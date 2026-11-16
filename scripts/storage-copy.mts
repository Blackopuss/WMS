// Copies the private files the database references from one storage to
// another (WMS-67, ADR 0070): moving the disk to Cloudflare R2, going back,
// the copy to the backup bucket and restoring from it. Repeatable; it never
// removes nor replaces anything in the backup bucket.
//
// Usage (quien integra agrega a package.json
// "storage:copy": "tsx scripts/storage-copy.mts"):
//   npm run storage:copy -- --from disk --to s3 --verify
//   npm run storage:copy -- --from disk --to s3 --verify --remove-source
//   npm run storage:copy -- --from s3 --to disk --verify        (volver atrás)
//   npm run storage:copy -- --from s3 --to backup --verify      (respaldo)
//   npm run storage:copy -- --from backup --to s3 --verify      (restaurar)
//   npm run storage:copy -- --audit --to s3                     (sobrantes)
//   npm run storage:copy -- --recount                           (cupo vs archivos)
//   … --company <id>                                            (una empresa)
//   … --verify-all       vuelve a leer todo, también lo que ya estaba (lento)
//   … --backup-env-stdin las credenciales del bucket de respaldo llegan por
//                        la entrada estándar (CLAVE=VALOR), nunca de la
//                        configuración de la app: así las pasa `respaldo`.
// `disk` is FILE_STORAGE_DIR, `s3` the FILE_STORAGE_S3_* bucket and `backup`
// the FILE_BACKUP_S3_* bucket. Exit code 1 when anything is missing, does
// not match or failed; each problem is printed with its company and file.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

// Server code outside Next.js, as the worker runs it.
const serverOnly = pathToFileURL("scripts/server-only-stub.mjs").href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { url: serverOnly, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const TARGETS = ["disk", "s3", "backup"] as const;
type Target = (typeof TARGETS)[number];
const isTarget = (value: unknown): value is Target =>
  TARGETS.includes(value as Target);

const { values } = parseArgs({
  options: {
    from: { type: "string" },
    to: { type: "string" },
    verify: { type: "boolean", default: false },
    "verify-all": { type: "boolean", default: false },
    recount: { type: "boolean", default: false },
    "backup-env-stdin": { type: "boolean", default: false },
    "remove-source": { type: "boolean", default: false },
    audit: { type: "boolean", default: false },
    company: { type: "string" },
  },
});

// The token of the backup bucket never lives in the configuration of the
// web application (ADR 0070, review M3): `respaldo` (root) reads it from
// /etc/almacen and hands it here through stdin. Only FILE_BACKUP_S3_* keys
// are taken; whatever .env.local says about them is dropped first.
if (values["backup-env-stdin"]) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("FILE_BACKUP_S3_")) delete process.env[key];
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length > 16_384)
    throw new Error("La configuración es demasiado larga");
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const equal = line.indexOf("=");
    const key = line.slice(0, equal).trim();
    if (equal > 0 && /^FILE_BACKUP_S3_[A-Z_]+$/.test(key)) {
      process.env[key] = line.slice(equal + 1).trim();
    }
  }
}

const { db } = await import("@/server/db");
const { COPY_PROBLEM_HELP, auditStorage, copyStoredFiles, recountStorage } =
  await import("@/platform/files/storage-copy");

/** Every company in pages, or the one asked for. */
async function* companies(): AsyncGenerator<string> {
  if (values.company) {
    yield values.company;
    return;
  }
  let after: string | undefined;
  for (;;) {
    const page: { id: string }[] = await db.organization.findMany({
      orderBy: { id: "asc" },
      take: 200,
      ...(after ? { cursor: { id: after }, skip: 1 } : {}),
      select: { id: true },
    });
    if (page.length === 0) return;
    after = page[page.length - 1]!.id;
    for (const row of page) yield row.id;
  }
}

let failed = false;
const seen = new Set<string>();
try {
  if (values.company && !/^[0-9a-f-]{36}$/.test(values.company)) {
    throw new Error("--company debe ser el id de una empresa");
  }
  if (values.recount) {
    const drift = await recountStorage(companies());
    for (const item of drift) {
      console.log(
        `DIFERENCIA  empresa=${item.organizationId}  contador=${item.counted} KiB  ` +
          `archivos=${item.actual} KiB`,
      );
    }
    console.log(
      `Empresas con el contador de almacenamiento distinto a sus archivos: ${drift.length}. ` +
        "No se corrigió nada.",
    );
    failed = drift.length > 0;
  } else if (!isTarget(values.to)) {
    throw new Error("--to debe ser disk, s3 o backup");
  } else if (values.audit) {
    const stray = await auditStorage(values.to, companies());
    for (const item of stray) {
      console.log(
        `SOBRANTE  empresa=${item.organizationId}  llave=${item.key}  ` +
          `fecha=${item.lastModified?.toISOString() ?? "?"}`,
      );
    }
    console.log(`Objetos sin archivo vivo en ${values.to}: ${stray.length}`);
  } else {
    if (!isTarget(values.from)) {
      throw new Error("--from debe ser disk, s3 o backup");
    }
    const summary = await copyStoredFiles({
      from: values.from,
      to: values.to,
      verify: values.verify,
      verifyAll: values["verify-all"],
      removeSource: values["remove-source"],
      organizationIds: companies(),
      onProblem: (problem) => {
        seen.add(problem.kind);
        console.log(
          `${problem.kind.toUpperCase()}  empresa=${problem.organizationId}  ` +
            `archivo=${problem.fileId}${problem.detail ? `  (${problem.detail})` : ""}`,
        );
      },
    });
    console.log(
      `${values.from} → ${values.to}: ${summary.companies} empresas, ` +
        `${summary.files} archivos, ${summary.copied} copiados, ` +
        `${summary.skipped} ya estaban, ${summary.removed} borrados del origen, ` +
        `${summary.problems} con problema.`,
    );
    if (summary.problems > 0) {
      for (const [kind, help] of Object.entries(COPY_PROBLEM_HELP)) {
        if (seen.has(kind)) console.log(`  ${kind.toUpperCase()}: ${help}`);
      }
    }
    failed = summary.problems > 0;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  failed = true;
} finally {
  await db.$disconnect();
}
process.exit(failed ? 1 : 0);
