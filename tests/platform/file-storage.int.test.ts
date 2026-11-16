import { existsSync } from "node:fs";
import path from "node:path";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { newId } from "@/lib";
import { moduleRegistry } from "@/modules/registry";
import { getCompanyPlan, provisionCompany } from "@/platform/billing";
import { getQuotaUsage, invalidateEntitlements } from "@/platform/entitlements";
import {
  createFileLink,
  deleteFile,
  openFileLink,
  pingStorage,
  processStorageCleanup,
  purgeOrphanPhotos,
  readStoredFile,
  storeFile,
  type FileActor,
} from "@/platform/files";
import {
  S3Client,
  StorageError,
  readS3Config,
} from "@/platform/files/s3-client";
import { auditStorage, copyStoredFiles } from "@/platform/files/storage-copy";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

import { startFakeS3, type FakeS3 } from "../setup/fake-s3";
import { TEST_JPEG } from "../setup/images";

// WMS-67 (ADR 0070): the bytes of private files in a bucket compatible with
// S3 (Cloudflare R2), behind the same interface. Against a fake S3 server
// in this process that checks every signature on its own.

const stamp = Date.now();
let counter = 0;
let staff = "";
const csv = (text = "sku,nombre\nTOR-1,Tornillo\n") => Buffer.from(text);

async function newUser() {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: "Persona",
      email: `almacenamiento.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(storageGb?: number): Promise<FileActor> {
  const owner = await newUser();
  const created = await createOrganization(owner, {
    name: `Empresa almacenamiento ${counter}`,
    timeZone: "",
  });
  if (!created.ok) throw new Error("company setup failed");
  if (!staff) {
    staff = await newUser();
    await db.platformStaff.create({ data: { userId: staff } });
  }
  const result = await provisionCompany(
    moduleRegistry,
    staff,
    created.organizationId,
    {
      productLimit: 50,
      users: 10,
      ...(storageGb === undefined ? {} : { storageGb }),
      modules: ["inventory"],
      validUntil: null,
      reason: "Prueba de almacenamiento",
    },
  );
  if (!result.ok) throw new Error("provision failed");
  return { organizationId: created.organizationId, userId: owner };
}

async function upload(actor: FileActor, bytes = csv()) {
  const result = await storeFile(actor, {
    purpose: "import_source",
    name: "productos.csv",
    bytes,
  });
  if (!result.ok) throw new Error(`upload failed: ${result.error}`);
  return result.fileId;
}

const usedKib = async (organizationId: string) => {
  const usage = await getQuotaUsage(organizationId, "file_storage_kib");
  return usage.used + usage.reserved;
};
const notes = (organizationId: string) =>
  db.storageCleanup.findMany({ where: { organizationId } });

let s3: FakeS3;
let backup: FakeS3;
const saved = { ...process.env };
let actor: FileActor;
let other: FileActor;

function useS3(extra: Record<string, string> = {}) {
  Object.assign(process.env, s3.env(), backup.env("FILE_BACKUP_S3_"), {
    FILE_STORAGE_DRIVER: "s3",
    FILE_STORAGE_S3_TIMEOUT_MS: "2000",
    ...extra,
  });
}

beforeAll(async () => {
  s3 = await startFakeS3();
  backup = await startFakeS3({ bucket: "wms-respaldo", pageSize: 2 });
  actor = await company();
  other = await company();
}, 60_000);

beforeEach(() => useS3());

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("FILE_")) delete process.env[key];
  }
  Object.assign(process.env, saved);
  invalidateEntitlements();
});

afterAll(async () => {
  await s3.close();
  await backup.close();
  await db.$disconnect();
});

describe("the S3 driver", () => {
  it("keeps the bytes in the bucket under company and file, read back the same", async () => {
    const before = await usedKib(actor.organizationId);
    const fileId = await upload(actor);
    const key = `${actor.organizationId}/${fileId}`;
    const object = s3.objects.get(key);
    expect(object?.bytes.equals(csv())).toBe(true);
    const row = await db.storedFile.findUniqueOrThrow({
      where: { id: fileId },
    });
    expect(object?.sha256).toBe(row.sha256);
    // Not on the disk.
    expect(
      existsSync(
        path.join(
          process.env.FILE_STORAGE_DIR ?? "",
          actor.organizationId,
          fileId,
        ),
      ),
    ).toBe(false);
    expect(
      (await readStoredFile(actor.organizationId, fileId))!.bytes.equals(csv()),
    ).toBe(true);
    // The link of the person opens it through the application.
    const link = await createFileLink(actor, fileId);
    if (!link.ok) throw new Error("no link");
    const url = new URL(link.url, "http://local.test");
    const opened = await openFileLink(actor, {
      fileId,
      expires: url.searchParams.get("e")!,
      signature: url.searchParams.get("s")!,
    });
    expect(opened).toMatchObject({ ok: true, inline: false });
    // Nothing waits for cleanup; the quota counts it.
    expect(await notes(actor.organizationId)).toEqual([]);
    expect(await usedKib(actor.organizationId)).toBe(before + 1);
  });

  it("another company never reaches the object, even in the same bucket", async () => {
    const fileId = await upload(actor);
    expect(await readStoredFile(other.organizationId, fileId)).toBeNull();
    expect(await createFileLink(other, fileId)).toEqual({
      ok: false,
      reason: "not_found",
    });
    // A row of the other company pointing at this key is refused before
    // the storage is asked.
    const forged = newId();
    await db.storedFile.create({
      data: {
        id: forged,
        organizationId: other.organizationId,
        purpose: "import_source",
        name: "ajeno.csv",
        contentType: "text/csv; charset=utf-8",
        size: 10,
        sha256: "0".repeat(64),
        storageKey: `${actor.organizationId}/${fileId}`,
        createdByUserId: other.userId,
      },
    });
    const gets = s3.requests.length;
    expect(await readStoredFile(other.organizationId, forged)).toBeNull();
    expect(s3.requests.length).toBe(gets);
  });

  it("removing frees the quota and the object", async () => {
    const fileId = await upload(actor, Buffer.alloc(3000, 97));
    const key = `${actor.organizationId}/${fileId}`;
    const before = await usedKib(actor.organizationId);
    expect(await deleteFile(actor, fileId)).toEqual({ ok: true });
    expect(s3.objects.has(key)).toBe(false);
    expect(await usedKib(actor.organizationId)).toBe(before - 3);
    expect(await notes(actor.organizationId)).toEqual([]);
  });

  it("an object missing or changed in the bucket «is not there»", async () => {
    const gone = await upload(actor);
    s3.objects.delete(`${actor.organizationId}/${gone}`);
    expect(await readStoredFile(actor.organizationId, gone)).toBeNull();
    const changed = await upload(actor);
    s3.objects.get(`${actor.organizationId}/${changed}`)!.bytes =
      Buffer.from("otra cosa");
    expect(await readStoredFile(actor.organizationId, changed)).toBeNull();
  });

  it("retries a 5xx and keeps the file", async () => {
    s3.fail(503, 2);
    const from = s3.requests.length;
    const fileId = await upload(actor);
    const puts = s3.requests.slice(from).filter((r) => r.method === "PUT");
    expect(puts.map((r) => r.status)).toEqual([503, 503, 200]);
    expect(s3.objects.has(`${actor.organizationId}/${fileId}`)).toBe(true);
  });

  it("a storage that keeps failing: nothing is kept, nothing is charged", async () => {
    const files = await db.storedFile.count({
      where: { organizationId: actor.organizationId },
    });
    const before = await usedKib(actor.organizationId);
    s3.fail(500, 3);
    const result = await storeFile(actor, {
      purpose: "import_source",
      name: "productos.csv",
      bytes: csv(),
    });
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    if (!result.ok) expect(result.error).toMatch(/Intenta de nuevo/);
    expect(
      await db.storedFile.count({
        where: { organizationId: actor.organizationId },
      }),
    ).toBe(files);
    expect(await usedKib(actor.organizationId)).toBe(before);
    // Removing the half-written object worked: no note is left.
    expect(await notes(actor.organizationId)).toEqual([]);
  });

  it("a timeout is retried", async () => {
    useS3({ FILE_STORAGE_S3_TIMEOUT_MS: "300" });
    s3.delay(1500);
    const fileId = await upload(actor);
    expect(s3.objects.has(`${actor.organizationId}/${fileId}`)).toBe(true);
  });

  it("bad credentials: refused by the signature, the secret never in the error", async () => {
    useS3({ FILE_STORAGE_S3_SECRET_ACCESS_KEY: "secreto-equivocado-123" });
    const client = new S3Client(readS3Config("FILE_STORAGE_S3_"));
    const error = await client
      .put(`${actor.organizationId}/${newId()}`, csv(), "a".repeat(64))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect(error).toMatchObject({ status: 403, retriable: false });
    // The body hash is checked first: a body that is not the signed one.
    const signed = await client
      .put(
        `${actor.organizationId}/${newId()}`,
        csv(),
        (await import("node:crypto"))
          .createHash("sha256")
          .update(csv())
          .digest("hex"),
      )
      .catch((e: unknown) => e);
    expect(signed).toMatchObject({
      status: 403,
      code: "SignatureDoesNotMatch",
    });
    const text = `${String(signed)} ${JSON.stringify(signed)}`;
    expect(text).not.toContain("secreto-equivocado");
    expect(text).not.toContain("AWS4-HMAC-SHA256");

    useS3({ FILE_STORAGE_S3_ACCESS_KEY_ID: "AKIDOTRA" });
    expect(
      await storeFile(actor, {
        purpose: "import_source",
        name: "productos.csv",
        bytes: csv(),
      }),
    ).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("never follows a redirect", async () => {
    s3.redirect();
    const client = new S3Client(readS3Config("FILE_STORAGE_S3_"));
    const error = await client
      .get(`${actor.organizationId}/${newId()}`)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 307, retriable: false });
  });

  it("an error of the storage when reading is an error, not «not there»", async () => {
    const fileId = await upload(actor);
    s3.fail(503, 3);
    await expect(
      readStoredFile(actor.organizationId, fileId),
    ).rejects.toBeInstanceOf(StorageError);
  });
});

describe("configuration", () => {
  const config = (values: Record<string, string>) => () =>
    readS3Config("FILE_STORAGE_S3_", {
      ...s3.env(),
      ...values,
    } as NodeJS.ProcessEnv);

  it("only https, no user, no path; http only to the loopback outside production", () => {
    expect(
      config({ FILE_STORAGE_S3_ENDPOINT: "http://r2.example.com" }),
    ).toThrow(/https/);
    expect(
      config({
        FILE_STORAGE_S3_ENDPOINT: "https://a:b@cuenta.r2.cloudflarestorage.com",
      }),
    ).toThrow(/user/);
    expect(
      config({
        FILE_STORAGE_S3_ENDPOINT:
          "https://cuenta.r2.cloudflarestorage.com/otro",
      }),
    ).toThrow(/no path/);
    expect(config({ NODE_ENV: "production" })).toThrow(/https/);
    expect(config({ FILE_STORAGE_S3_BUCKET: "../otro" })).toThrow(/bucket/);
    expect(config({ FILE_STORAGE_S3_PREFIX: "a/b" })).toThrow(/PREFIX/);
    expect(config({ FILE_STORAGE_S3_SECRET_ACCESS_KEY: "" })).toThrow(
      /Missing FILE_STORAGE_S3_SECRET_ACCESS_KEY/,
    );
    const ok = config({
      FILE_STORAGE_S3_ENDPOINT: "https://cuenta.r2.cloudflarestorage.com",
    })();
    expect(ok.region).toBe("auto");
  });

  it("a prefix keeps installations apart in one bucket", async () => {
    useS3({ FILE_STORAGE_S3_PREFIX: "pruebas" });
    const fileId = await upload(actor);
    expect(s3.objects.has(`pruebas/${actor.organizationId}/${fileId}`)).toBe(
      true,
    );
    expect(
      (await readStoredFile(actor.organizationId, fileId))!.bytes.equals(csv()),
    ).toBe(true);
  });
});

describe("storage quota (file_storage_kib)", () => {
  it("5 GB without a limit in the plan; the plan can say more", async () => {
    const usage = await getQuotaUsage(actor.organizationId, "file_storage_kib");
    expect(usage.limit).toBe(5 * 1024 * 1024);
    const bigger = await company(20);
    expect(
      (await getQuotaUsage(bigger.organizationId, "file_storage_kib")).limit,
    ).toBe(20 * 1024 * 1024);
    expect(await getCompanyPlan(bigger.organizationId)).toMatchObject({
      storageGb: 20,
    });
  });

  it("over the limit nothing is kept and the person is told", async () => {
    const full = await company(1);
    await upload(full);
    await db.quotaUsage.updateMany({
      where: { organizationId: full.organizationId, key: "file_storage_kib" },
      data: { taken: 1024 * 1024 - 1 },
    });
    const result = await storeFile(full, {
      purpose: "import_source",
      name: "productos.csv",
      bytes: Buffer.alloc(4096, 98),
    });
    expect(result).toMatchObject({ ok: false, reason: "storage_full" });
    if (!result.ok) {
      expect(result.error).toBe(
        "Tu plan incluye 1 GB para archivos y ya están en uso. Borra archivos que no necesites o pide más espacio.",
      );
    }
    // The transaction went back: no row, the object taken back, no note.
    expect(
      await db.storedFile.count({
        where: { organizationId: full.organizationId },
      }),
    ).toBe(1);
    expect(
      [...s3.objects.keys()].filter((k) => k.startsWith(full.organizationId)),
    ).toHaveLength(1);
    expect(await notes(full.organizationId)).toEqual([]);
    // What fits still goes in.
    expect(
      (
        await storeFile(full, {
          purpose: "import_source",
          name: "chico.csv",
          bytes: Buffer.alloc(100, 98),
        })
      ).ok,
    ).toBe(true);
  });

  it("two uploads at once for the last place: only one wins", async () => {
    const full = await company(1);
    await upload(full);
    await db.quotaUsage.updateMany({
      where: { organizationId: full.organizationId, key: "file_storage_kib" },
      data: { taken: 1024 * 1024 - 3 },
    });
    const results = await Promise.all(
      [1, 2].map(() =>
        storeFile(full, {
          purpose: "import_source",
          name: "productos.csv",
          bytes: Buffer.alloc(2048, 99),
        }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await usedKib(full.organizationId)).toBe(1024 * 1024 - 1);
  });

  it("the purge of photos never linked gives their place back", async () => {
    const owner = await company();
    const photo = await storeFile(owner, {
      purpose: "incident_photo",
      name: "foto.jpg",
      bytes: TEST_JPEG,
    });
    if (!photo.ok) throw new Error(photo.error);
    const before = await usedKib(owner.organizationId);
    const removed = await purgeOrphanPhotos(owner.organizationId, {
      now: new Date(Date.now() + 25 * 3600 * 1000),
    });
    expect(removed).toBe(1);
    expect(await usedKib(owner.organizationId)).toBeLessThan(before);
    expect(s3.objects.has(`${owner.organizationId}/${photo.fileId}`)).toBe(
      false,
    );
  });
});

describe("cleanup of what was left (platform.storage_cleanup)", () => {
  it("a removal whose bytes could not go is finished by the round", async () => {
    const owner = await company();
    const fileId = await upload(owner);
    const key = `${owner.organizationId}/${fileId}`;
    s3.fail(503, 3);
    expect(await deleteFile(owner, fileId)).toEqual({ ok: true });
    expect(s3.objects.has(key)).toBe(true);
    const [note] = await notes(owner.organizationId);
    expect(note).toMatchObject({ storageKey: key, reason: "DELETE" });
    // Too young: left alone.
    expect(await processStorageCleanup(owner.organizationId)).toEqual({
      removed: 0,
      kept: 0,
      failed: 0,
    });
    const later = { now: new Date(Date.now() + 16 * 60 * 1000) };
    s3.fail(503, 3);
    expect(await processStorageCleanup(owner.organizationId, later)).toEqual({
      removed: 0,
      kept: 0,
      failed: 1,
    });
    expect((await notes(owner.organizationId))[0]).toMatchObject({
      attempts: 1,
      lastError: expect.stringContaining("503"),
    });
    expect(await processStorageCleanup(owner.organizationId, later)).toEqual({
      removed: 1,
      kept: 0,
      failed: 0,
    });
    expect(s3.objects.has(key)).toBe(false);
    expect(await notes(owner.organizationId)).toEqual([]);
  });

  it("an upload that did not end leaves a note the round resolves", async () => {
    const owner = await company();
    // The bytes went, the process died before its row: only the note.
    const lost = `${owner.organizationId}/${newId()}`;
    s3.objects.set(lost, {
      bytes: csv(),
      sha256: null,
      lastModified: new Date(),
    });
    await db.storageCleanup.create({
      data: {
        id: newId(),
        organizationId: owner.organizationId,
        storageKey: lost,
        reason: "UPLOAD",
      },
    });
    // A note of an upload that did end (its row exists): only the note goes.
    const fileId = await upload(owner);
    const live = `${owner.organizationId}/${fileId}`;
    await db.storageCleanup.create({
      data: {
        id: newId(),
        organizationId: owner.organizationId,
        storageKey: live,
        reason: "UPLOAD",
      },
    });
    expect(
      await processStorageCleanup(owner.organizationId, {
        now: new Date(Date.now() + 16 * 60 * 1000),
      }),
    ).toEqual({ removed: 1, kept: 1, failed: 0 });
    expect(s3.objects.has(lost)).toBe(false);
    expect(s3.objects.has(live)).toBe(true);
    expect(await readStoredFile(owner.organizationId, fileId)).not.toBeNull();
  });
});

describe("moving the files (storage:copy)", () => {
  it("disk → s3, repeatable, verified; then the disk can go; and back", async () => {
    const owner = await company();
    process.env.FILE_STORAGE_DRIVER = "disk";
    const ids = [await upload(owner), await upload(owner, csv("a,b\n1,2\n"))];
    const gone = await upload(owner);
    await deleteFile(owner, gone);
    const problems: string[] = [];
    const run = (
      from: "disk" | "s3" | "backup",
      to: "disk" | "s3" | "backup",
      extra = {},
    ) =>
      copyStoredFiles({
        from,
        to,
        verify: true,
        organizationIds: [owner.organizationId],
        onProblem: (p) => problems.push(`${p.kind}:${p.fileId}`),
        ...extra,
      });

    expect(await run("disk", "s3")).toMatchObject({
      files: 2,
      copied: 2,
      skipped: 0,
      problems: 0,
    });
    // Again: nothing to copy.
    expect(await run("disk", "s3")).toMatchObject({ copied: 0, skipped: 2 });
    // The application reads them from R2 now.
    process.env.FILE_STORAGE_DRIVER = "s3";
    for (const id of ids) {
      expect(await readStoredFile(owner.organizationId, id)).not.toBeNull();
    }
    // Removing the source only with a verified copy.
    await expect(
      copyStoredFiles({
        from: "disk",
        to: "s3",
        removeSource: true,
        organizationIds: [],
      }),
    ).rejects.toThrow(/verify/);
    expect(await run("disk", "s3", { removeSource: true })).toMatchObject({
      removed: 2,
    });
    const dir = process.env.FILE_STORAGE_DIR!;
    expect(existsSync(path.join(dir, owner.organizationId, ids[0]!))).toBe(
      false,
    );
    // Going back.
    expect(await run("s3", "disk")).toMatchObject({ copied: 2, problems: 0 });
    process.env.FILE_STORAGE_DRIVER = "disk";
    expect(await readStoredFile(owner.organizationId, ids[1]!)).not.toBeNull();
    expect(problems).toEqual([]);
  });

  it("the backup bucket is never overwritten; what is missing is said", async () => {
    const owner = await company();
    const ids = [await upload(owner), await upload(owner), await upload(owner)];
    const problems: string[] = [];
    const run = () =>
      copyStoredFiles({
        from: "s3",
        to: "backup",
        verify: true,
        organizationIds: [owner.organizationId],
        onProblem: (p) => problems.push(p.kind),
      });
    expect(await run()).toMatchObject({ copied: 3, problems: 0 });
    // A changed object in the backup stays as it is.
    const key = `${owner.organizationId}/${ids[0]}`;
    backup.objects.get(key)!.sha256 = "f".repeat(64);
    // An object lost in the main bucket cannot be copied.
    s3.objects.delete(`${owner.organizationId}/${ids[1]}`);
    expect(await run()).toMatchObject({ copied: 0, problems: 1 });
    expect(problems).toEqual(["differs"]);
    // Restoring from the backup brings back what was lost.
    problems.length = 0;
    expect(
      await copyStoredFiles({
        from: "backup",
        to: "s3",
        verify: true,
        organizationIds: [owner.organizationId],
        onProblem: (p) => problems.push(p.kind),
      }),
    ).toMatchObject({ copied: 1, skipped: 2, problems: 0 });
    expect(await readStoredFile(owner.organizationId, ids[1]!)).not.toBeNull();
  });

  it("the audit lists objects without a live file, across pages", async () => {
    const owner = await company();
    await upload(owner);
    const stray = `${owner.organizationId}/${newId()}`;
    for (const target of [backup]) {
      target.objects.set(stray, {
        bytes: csv(),
        sha256: null,
        lastModified: new Date(),
      });
    }
    await copyStoredFiles({
      from: "s3",
      to: "backup",
      organizationIds: [owner.organizationId],
    });
    const found = await auditStorage("backup", [owner.organizationId]);
    expect(found.map((item) => item.key)).toEqual([stray]);
  });
});

describe("pingStorage", () => {
  it("writes, reads back and removes; says why it failed without secrets", async () => {
    const before = s3.objects.size;
    expect(await pingStorage()).toMatchObject({ ok: true, driver: "s3" });
    expect(s3.objects.size).toBe(before);
    useS3({ FILE_STORAGE_S3_SECRET_ACCESS_KEY: "otro-secreto-de-prueba" });
    const failed = await pingStorage();
    expect(failed).toMatchObject({ ok: false, driver: "s3" });
    expect(failed.error).toContain("403");
    expect(failed.error).not.toContain("otro-secreto");
    process.env.FILE_STORAGE_DRIVER = "disk";
    expect(await pingStorage()).toMatchObject({ ok: true, driver: "disk" });
  });
});
