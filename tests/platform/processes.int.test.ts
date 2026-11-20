import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { newId } from "@/lib";
import { moduleRegistry } from "@/modules/registry";
import type { Role } from "@/platform/authorization";
import {
  activateModule,
  createModuleRegistry,
  deactivateModule,
} from "@/platform/billing";
import { invalidateEntitlements } from "@/platform/entitlements";
import { createFileLink, evidencePhotoLinksOf } from "@/platform/files";
import { createLocation } from "@/platform/locations";
import {
  ProcessStagesPending,
  assertStagesDone,
  assignStage,
  backStage,
  completeOperationStage,
  completeStage,
  countProcessWork,
  getProcessDefinition,
  getProcessSettings,
  getProcessView,
  listProcessWork,
  processStepReach,
  publishProcess,
  reachMilestone,
  releaseStage,
  saveProcessDraft,
  setProcessPlace,
  skipStage,
  startProcess,
  takeStage,
  uploadProcessPhoto,
  type DraftInput,
  type ProcessDocument,
} from "@/platform/processes";
import { createOrganization } from "@/platform/tenancy";
import { LOCKING_TRANSACTION, db, forOrganization } from "@/server";

import { TEST_JPEG } from "../setup/images";
import { grantSeats } from "../setup/plan";

// WMS-74 (ADR 0069): the engine of processes, tested with documents that
// exist only here (no module declares one yet). The «documents» are ids;
// the engine never reads a table of a module.

/** Who the request comes from at a shared terminal (WMS-38), if anybody. */
let terminalUser: string | null = null;
vi.mock("@/platform/auth", async (original) => ({
  ...(await original<typeof import("@/platform/auth")>()),
  terminalUserOfRequest: async () => terminalUser,
}));

const stamp = Date.now();
let counter = 0;

// Producción is announced today: the same contracts, marked available, let
// a company have it (as in production-roles.int.test.ts).
const registry = createModuleRegistry(
  moduleRegistry.all.map((contract) =>
    contract.id === "production" || contract.id === "quality"
      ? { ...contract, availability: "available" as const }
      : contract,
  ),
);

const DOC: ProcessDocument = {
  key: "test.batch",
  module: "inventory",
  label: "Lote de prueba",
  milestones: [
    { key: "OPEN", label: "Abierto" },
    { key: "CHECK", label: "En revisión" },
    { key: "CANCELLED", label: "Cancelado", closes: true },
  ],
  operations: [
    {
      key: "test.verified",
      label: "Se verificó",
      milestone: "CHECK",
      leadsTo: null,
    },
    {
      key: "test.stored",
      label: "Se guardó",
      milestone: "CHECK",
      leadsTo: null,
    },
  ],
  readPermission: "inventory.stock.read",
  href: (id) => `/inventario?documento=${id}`,
};

/** A document of a module the company may not have. */
const PRODUCTION_DOC: ProcessDocument = {
  ...DOC,
  key: "test.order",
  module: "production",
  label: "Orden de prueba",
  readPermission: "production.order.read",
};

const DOCUMENTS = [DOC, PRODUCTION_DOC];

type Actor = { organizationId: string; userId: string };

async function newUser(label: string) {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: `${label} ${++counter}`,
      email: `proc.${counter}.${stamp}@example.test`,
      emailVerified: true,
      twoFactorEnabled: true,
    },
  });
  return user.id;
}

async function newCompany(modules: string[] = []) {
  const owner = await newUser("Titular");
  const created = await createOrganization(owner, {
    name: `Procesos ${counter}`,
    timeZone: "",
  });
  if (!created.ok) throw new Error("company setup failed");
  await grantSeats(created.organizationId);
  for (const moduleId of ["inventory", ...modules]) {
    const result = await activateModule(registry, {
      organizationId: created.organizationId,
      moduleId,
      actorUserId: null,
    });
    if (!result.ok && result.reason !== "unchanged") {
      throw new Error(`could not activate ${moduleId}`);
    }
  }
  const facility = await db.facility.findFirstOrThrow({
    where: { organizationId: created.organizationId, isDefault: true },
    select: { id: true },
  });
  return {
    owner: { organizationId: created.organizationId, userId: owner },
    facilityId: facility.id,
  };
}

async function member(
  organizationId: string,
  roles: Role[],
  scope: { facilityId: string; locationId?: string }[] = [],
): Promise<Actor> {
  const userId = await newUser(roles.join("-"));
  const membership = await db.membership.create({
    data: { id: newId(), organizationId, userId, status: "ACTIVE" },
  });
  for (const role of roles) {
    await db.membershipRole.create({
      data: { id: newId(), organizationId, membershipId: membership.id, role },
    });
  }
  for (const row of scope) {
    await db.membershipScope.create({
      data: {
        id: newId(),
        organizationId,
        membershipId: membership.id,
        facilityId: row.facilityId,
        locationId: row.locationId ?? null,
      },
    });
  }
  return { organizationId, userId };
}

/** Lijado (Almacenista) → Armado [Base, Tapa] (Operario) → Verificado → Empaque. */
const DRAFT: DraftInput = {
  stages: [
    {
      name: "Lijado",
      kind: "MANUAL",
      milestone: "OPEN",
      roles: ["operator"],
      photo: "OPTIONAL",
      note: "OPTIONAL",
      allowSkip: true,
    },
    {
      name: "Armado",
      kind: "MANUAL",
      milestone: "OPEN",
      roles: ["production_operator"],
      childOrder: "IN_ORDER",
      allowBack: true,
      children: [{ name: "Base" }, { name: "Tapa" }],
    },
    { name: "Verificado", kind: "OPERATION", operationKey: "test.verified" },
    {
      name: "Empaque",
      kind: "MANUAL",
      milestone: "CHECK",
      roles: ["warehouse"],
      quantity: "REQUIRED",
      note: "REQUIRED",
      allowBack: true,
    },
  ],
};

async function publish(owner: Actor, draft: DraftInput = DRAFT, doc = DOC) {
  const saved = await saveProcessDraft(owner, DOCUMENTS, doc.key, draft);
  if (!saved.ok) throw new Error(`draft refused: ${saved.error}`);
  const published = await publishProcess(owner, DOCUMENTS, doc.key);
  if (!published.ok) throw new Error("publish refused");
  return published.number;
}

async function start(
  owner: Actor,
  facilityId: string,
  options: { locationId?: string; doc?: ProcessDocument; label?: string } = {},
) {
  const documentId = newId();
  const result = await forOrganization(owner.organizationId).$transaction(
    (tx) =>
      startProcess(tx, options.doc ?? DOC, owner, {
        documentId,
        facilityId,
        locationId: options.locationId ?? null,
        label: options.label ?? `LP-${counter}`,
        milestone: "OPEN",
      }),
    LOCKING_TRANSACTION,
  );
  return { documentId, ...result };
}

/** The state id of a stage of work of a document, by its name. */
async function stateOf(
  organizationId: string,
  progressId: string,
  name: string,
) {
  const row = await db.processStageState.findFirstOrThrow({
    where: { organizationId, progressId, stage: { name } },
    select: { id: true, status: true, takenByUserId: true },
  });
  return row;
}

/** Who got a notice of the relay for a document, as user ids. */
async function relayed(organizationId: string, progressId: string) {
  const rows = await db.notification.findMany({
    where: {
      organizationId,
      typeKey: "processes.ready",
      href: `/procesos/${progressId}`,
    },
    select: { recipientUserId: true, text: true },
  });
  return rows;
}

const key = () => newId();

afterEach(() => {
  terminalUser = null;
  invalidateEntitlements();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("configuring a process", () => {
  it("only who configures the company sees, saves and publishes", async () => {
    const { owner } = await newCompany();
    const operator = await member(owner.organizationId, ["operator"]);
    await expect(getProcessSettings(operator, DOCUMENTS)).rejects.toMatchObject(
      { code: "permission_denied" },
    );
    await expect(
      saveProcessDraft(operator, DOCUMENTS, DOC.key, DRAFT),
    ).rejects.toMatchObject({ code: "permission_denied" });
    // Without Producción its document is not offered at all.
    const settings = await getProcessSettings(owner, DOCUMENTS);
    expect(settings.map((each) => each.documentKey)).toEqual([DOC.key]);
    expect(
      await saveProcessDraft(owner, DOCUMENTS, PRODUCTION_DOC.key, DRAFT),
    ).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("checks the draft against its document", async () => {
    const { owner } = await newCompany();
    const cases: [DraftInput, string][] = [
      [
        { stages: [{ name: "Sin área", kind: "MANUAL", milestone: "OPEN" }] },
        "Elige el área",
      ],
      [
        {
          stages: [
            { name: "Op", kind: "OPERATION", operationKey: "no.existe" },
          ],
        },
        "Elige la operación",
      ],
      [
        {
          stages: [
            {
              name: "B",
              kind: "MANUAL",
              milestone: "CHECK",
              roles: ["operator"],
            },
            {
              name: "A",
              kind: "MANUAL",
              milestone: "OPEN",
              roles: ["operator"],
            },
          ],
        },
        "orden de los estados",
      ],
      [
        {
          stages: [
            {
              name: "A",
              kind: "MANUAL",
              milestone: "OPEN",
              roles: ["production_operator"],
            },
          ],
        },
        "ya no se puede elegir",
      ],
      [
        {
          stages: Array.from({ length: 31 }, (_, index) => ({
            name: `E${index}`,
            kind: "MANUAL" as const,
            milestone: "OPEN",
            roles: ["operator"],
          })),
        },
        "hasta 30 etapas",
      ],
    ];
    for (const [draft, error] of cases) {
      const result = await saveProcessDraft(owner, DOCUMENTS, DOC.key, draft);
      expect(result.ok, error).toBe(false);
      if (!result.ok) expect(result.error).toContain(error);
    }
  });

  it("publishes versions; a published version never changes (base)", async () => {
    const { owner } = await newCompany(["production"]);
    expect(await publish(owner)).toBe(1);
    const view = await getProcessDefinition(owner, DOCUMENTS, DOC.key);
    expect(view?.published?.number).toBe(1);
    expect(view?.published?.stages.map((stage) => stage.name)).toEqual([
      "Lijado",
      "Armado",
      "Verificado",
      "Empaque",
    ]);
    expect(view?.published?.stages[1]?.children).toEqual([
      { name: "Base" },
      { name: "Tapa" },
    ]);
    expect(view?.draft).toBeNull();
    const stage = await db.processStage.findFirstOrThrow({
      where: { organizationId: owner.organizationId, name: "Lijado" },
      select: { id: true },
    });
    await expect(
      db.processStage.update({ where: { id: stage.id }, data: { name: "X" } }),
    ).rejects.toThrow(/only a draft changes/);
    await expect(
      db.processStage.delete({ where: { id: stage.id } }),
    ).rejects.toThrow(/only a draft changes/);
    // Publishing again with no draft says it is already in force.
    expect(await publishProcess(owner, DOCUMENTS, DOC.key)).toMatchObject({
      ok: true,
      repeated: true,
    });
  });
});

describe("a document with its process", () => {
  let owner: Actor;
  let facilityId: string;
  let operator: Actor;
  let operator2: Actor;
  let maker: Actor;
  let maker2: Actor;
  let warehouse: Actor;
  let viewer: Actor;
  let supervisor: Actor;

  beforeAll(async () => {
    ({ owner, facilityId } = await newCompany(["production"]));
    operator = await member(owner.organizationId, ["operator"]);
    operator2 = await member(owner.organizationId, ["operator"]);
    maker = await member(owner.organizationId, ["production_operator"]);
    maker2 = await member(owner.organizationId, ["production_operator"]);
    warehouse = await member(owner.organizationId, ["warehouse"]);
    viewer = await member(owner.organizationId, ["viewer"]);
    supervisor = await member(owner.organizationId, ["supervisor"]);
    await publish(owner);
  });

  it("without a published process nothing starts", async () => {
    const { owner: other, facilityId: place } = await newCompany();
    const result = await start(other, place);
    expect(result).toMatchObject({ started: false, progressId: null });
  });

  it("starts once and relays the first stage to its area only", async () => {
    const doc = await start(owner, facilityId);
    expect(doc.started).toBe(true);
    // Repeated, nothing new.
    const again = await forOrganization(owner.organizationId).$transaction(
      (tx) =>
        startProcess(tx, DOC, owner, {
          documentId: doc.documentId,
          facilityId,
          label: "LP-x",
          milestone: "OPEN",
        }),
    );
    expect(again).toEqual({ started: false, progressId: doc.progressId });
    const notified = (await relayed(owner.organizationId, doc.progressId!)).map(
      (row) => row.recipientUserId,
    );
    expect(notified.sort()).toEqual([operator.userId, operator2.userId].sort());
    expect(
      (await stateOf(owner.organizationId, doc.progressId!, "Lijado")).status,
    ).toBe("READY");
    expect(
      (await stateOf(owner.organizationId, doc.progressId!, "Base")).status,
    ).toBe("WAITING");
  });

  it("the lock: a stage is not done before the previous one (P10)", async () => {
    const doc = await start(owner, facilityId);
    const base = await stateOf(owner.organizationId, doc.progressId!, "Base");
    const result = await completeStage(maker, DOCUMENTS, {
      stateId: base.id,
      idempotencyKey: key(),
    });
    expect(result).toMatchObject({ ok: false, reason: "not_allowed" });
    if (!result.ok) expect(result.error).toContain("esperando Lijado");
    const view = await getProcessView(maker, DOCUMENTS, {
      progressId: doc.progressId!,
    });
    const leaf = view?.stages[1]?.leaves[0];
    expect(leaf?.waitingText).toBe("Esperando: Lijado (Almacenista)");
    expect(leaf?.canComplete).toBe(false);
  });

  it("only the area works a stage, and two cannot take it at once", async () => {
    const doc = await start(owner, facilityId);
    const lijado = await stateOf(
      owner.organizationId,
      doc.progressId!,
      "Lijado",
    );
    for (const who of [maker, warehouse, viewer]) {
      const refused = await takeStage(who, DOCUMENTS, { stateId: lijado.id });
      expect(refused.ok).toBe(false);
    }
    const [a, b] = await Promise.all([
      takeStage(operator, DOCUMENTS, {
        stateId: lijado.id,
        idempotencyKey: key(),
      }),
      takeStage(operator2, DOCUMENTS, {
        stateId: lijado.id,
        idempotencyKey: key(),
      }),
    ]);
    const wins = [a, b].filter((each) => each.ok);
    expect(wins).toHaveLength(1);
    const loser = [a, b].find((each) => !each.ok);
    expect(loser).toMatchObject({ ok: false, reason: "taken" });
    const taken = await stateOf(
      owner.organizationId,
      doc.progressId!,
      "Lijado",
    );
    const holder = a.ok ? operator : operator2;
    const other = a.ok ? operator2 : operator;
    expect(taken.takenByUserId).toBe(holder.userId);
    // The other one cannot complete it nor release it.
    expect(
      await completeStage(other, DOCUMENTS, { stateId: lijado.id }),
    ).toMatchObject({ ok: false, reason: "taken" });
    expect(
      await releaseStage(other, DOCUMENTS, { stateId: lijado.id }),
    ).toMatchObject({ ok: false, reason: "taken" });
    // Who has it sees it in «Mis tareas»; the other sees nothing available.
    const mine = await listProcessWork(holder, DOCUMENTS, { view: "mine" });
    expect(mine.items.map((item) => item.stateId)).toContain(lijado.id);
    const available = await listProcessWork(other, DOCUMENTS, {
      view: "available",
    });
    expect(available.items.map((item) => item.stateId)).not.toContain(
      lijado.id,
    );
    // Released, it is available again.
    expect(
      await releaseStage(holder, DOCUMENTS, { stateId: lijado.id }),
    ).toMatchObject({ ok: true });
    const back = await listProcessWork(other, DOCUMENTS, { view: "available" });
    expect(back.items.map((item) => item.stateId)).toContain(lijado.id);
  });

  it("relays to the next area, with sub-stages in order, and keeps the trail", async () => {
    const doc = await start(owner, facilityId);
    const progressId = doc.progressId!;
    const lijado = await stateOf(owner.organizationId, progressId, "Lijado");
    const done = await completeStage(operator, DOCUMENTS, {
      stateId: lijado.id,
      note: "Sin detalles",
      idempotencyKey: key(),
      userAgent:
        "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
      installed: true,
    });
    expect(done).toMatchObject({ ok: true });
    const notified = (await relayed(owner.organizationId, progressId))
      .filter((row) => row.text.includes("Base"))
      .map((row) => row.recipientUserId);
    expect(notified.sort()).toEqual([maker.userId, maker2.userId].sort());
    expect(
      (await stateOf(owner.organizationId, progressId, "Base")).status,
    ).toBe("READY");
    expect(
      (await stateOf(owner.organizationId, progressId, "Tapa")).status,
    ).toBe("WAITING");
    const counts = await countProcessWork(maker, DOCUMENTS);
    expect(counts.available).toBeGreaterThanOrEqual(1);
    const step = await db.processStep.findFirstOrThrow({
      where: {
        organizationId: owner.organizationId,
        progressId,
        action: "COMPLETED",
      },
      select: { id: true, device: true, note: true, actorUserId: true },
    });
    expect(step).toMatchObject({
      device: "Chrome en Android · app instalada",
      note: "Sin detalles",
      actorUserId: operator.userId,
    });
    // The trail never changes nor goes away.
    await expect(
      db.processStep.update({ where: { id: step.id }, data: { note: "x" } }),
    ).rejects.toThrow(/never changes/);
    await expect(
      db.processStep.delete({ where: { id: step.id } }),
    ).rejects.toThrow(/never deleted/);
  });

  it("a retry answers repeated; the same key for something else is refused", async () => {
    const doc = await start(owner, facilityId);
    const lijado = await stateOf(
      owner.organizationId,
      doc.progressId!,
      "Lijado",
    );
    const confirmation = key();
    const first = await completeStage(operator, DOCUMENTS, {
      stateId: lijado.id,
      idempotencyKey: confirmation,
    });
    expect(first.ok).toBe(true);
    expect(
      await completeStage(operator, DOCUMENTS, {
        stateId: lijado.id,
        idempotencyKey: confirmation,
      }),
    ).toMatchObject({ ok: true, repeated: true });
    const base = await stateOf(owner.organizationId, doc.progressId!, "Base");
    expect(
      await takeStage(maker, DOCUMENTS, {
        stateId: base.id,
        idempotencyKey: confirmation,
      }),
    ).toMatchObject({ ok: false, reason: "key_reused" });
    expect(
      await db.processStep.count({
        where: {
          organizationId: owner.organizationId,
          idempotencyKey: confirmation,
        },
      }),
    ).toBe(1);
  });

  it("evidence the stage asks is required; what it does not ask is refused", async () => {
    const doc = await start(owner, facilityId);
    const progressId = doc.progressId!;
    await completeStage(operator, DOCUMENTS, {
      stateId: (await stateOf(owner.organizationId, progressId, "Lijado")).id,
    });
    for (const name of ["Base", "Tapa"]) {
      const state = await stateOf(owner.organizationId, progressId, name);
      // Armado asks no note.
      if (name === "Base") {
        expect(
          await completeStage(maker, DOCUMENTS, {
            stateId: state.id,
            note: "x",
          }),
        ).toMatchObject({ ok: false, field: "note" });
      }
      expect(
        await completeStage(maker, DOCUMENTS, { stateId: state.id }),
      ).toMatchObject({ ok: true });
    }
    await forOrganization(owner.organizationId).$transaction(async (tx) => {
      await reachMilestone(tx, DOC, owner, doc.documentId, "CHECK");
      expect(
        await assertStagesDone(tx, DOC, doc.documentId, "test.verified"),
      ).toEqual({ ok: true });
      await completeOperationStage(
        tx,
        DOC,
        owner,
        doc.documentId,
        "test.verified",
      );
    }, LOCKING_TRANSACTION);
    const empaque = await stateOf(owner.organizationId, progressId, "Empaque");
    expect(empaque.status).toBe("READY");
    expect(
      await completeStage(warehouse, DOCUMENTS, {
        stateId: empaque.id,
        note: "Listo",
      }),
    ).toMatchObject({ ok: false, field: "quantity" });
    expect(
      await completeStage(warehouse, DOCUMENTS, {
        stateId: empaque.id,
        quantity: "10",
      }),
    ).toMatchObject({ ok: false, field: "note" });
    expect(
      await completeStage(warehouse, DOCUMENTS, {
        stateId: empaque.id,
        quantity: "-3",
        note: "Listo",
      }),
    ).toMatchObject({ ok: false, field: "quantity" });
    expect(
      await completeStage(warehouse, DOCUMENTS, {
        stateId: empaque.id,
        quantity: "12.5",
        note: "Listo",
      }),
    ).toMatchObject({ ok: true });
    const progress = await db.processProgress.findFirstOrThrow({
      where: { id: progressId },
      select: { status: true },
    });
    expect(progress.status).toBe("DONE");
  });

  it("operations wait for earlier stages of the same document only (P10b)", async () => {
    const behind = await start(owner, facilityId);
    const ahead = await start(owner, facilityId);
    // The second document goes through its manual stages.
    await completeStage(operator, DOCUMENTS, {
      stateId: (
        await stateOf(owner.organizationId, ahead.progressId!, "Lijado")
      ).id,
    });
    for (const name of ["Base", "Tapa"]) {
      await completeStage(maker, DOCUMENTS, {
        stateId: (await stateOf(owner.organizationId, ahead.progressId!, name))
          .id,
      });
    }
    await forOrganization(owner.organizationId).$transaction(async (tx) => {
      await reachMilestone(tx, DOC, owner, behind.documentId, "CHECK");
      await reachMilestone(tx, DOC, owner, ahead.documentId, "CHECK");
      const waiting = await assertStagesDone(
        tx,
        DOC,
        behind.documentId,
        "test.verified",
      );
      expect(waiting).toEqual({
        ok: false,
        reason: "stages_pending",
        message: "Esperando: Lijado (Almacenista).",
      });
      // The one that is ready does not wait for the one behind.
      expect(
        await assertStagesDone(tx, DOC, ahead.documentId, "test.verified"),
      ).toEqual({ ok: true });
      expect(
        await completeOperationStage(
          tx,
          DOC,
          owner,
          ahead.documentId,
          "test.verified",
        ),
      ).toEqual({ applied: true });
      // Repeated, it changes nothing.
      expect(
        await completeOperationStage(
          tx,
          DOC,
          owner,
          ahead.documentId,
          "test.verified",
        ),
      ).toEqual({ applied: false });
    }, LOCKING_TRANSACTION);
    // A module that did not ask: the operation is rolled back.
    await expect(
      forOrganization(owner.organizationId).$transaction(
        (tx) =>
          completeOperationStage(
            tx,
            DOC,
            owner,
            behind.documentId,
            "test.verified",
          ),
        LOCKING_TRANSACTION,
      ),
    ).rejects.toBeInstanceOf(ProcessStagesPending);
    // An operation the process does not have is never blocked.
    const unknown = await forOrganization(owner.organizationId).$transaction(
      (tx) => assertStagesDone(tx, DOC, behind.documentId, "test.other"),
    );
    expect(unknown).toEqual({ ok: true });
  });

  it("milestones gate their stages; a closing milestone ends the process", async () => {
    const doc = await start(owner, facilityId);
    const progressId = doc.progressId!;
    await completeStage(operator, DOCUMENTS, {
      stateId: (await stateOf(owner.organizationId, progressId, "Lijado")).id,
    });
    for (const name of ["Base", "Tapa"]) {
      await completeStage(maker, DOCUMENTS, {
        stateId: (await stateOf(owner.organizationId, progressId, name)).id,
      });
    }
    // Still OPEN: the operation of CHECK waits for the document.
    const check = await forOrganization(owner.organizationId).$transaction(
      (tx) => assertStagesDone(tx, DOC, doc.documentId, "test.verified"),
    );
    expect(check).toMatchObject({ ok: false, reason: "stages_pending" });
    await forOrganization(owner.organizationId).$transaction((tx) =>
      reachMilestone(tx, DOC, owner, doc.documentId, "CANCELLED"),
    );
    const progress = await db.processProgress.findFirstOrThrow({
      where: { id: progressId },
      select: { status: true },
    });
    expect(progress.status).toBe("CLOSED");
    expect(
      await listProcessWork(warehouse, DOCUMENTS, { view: "available" }),
    ).toMatchObject({
      items: expect.not.arrayContaining([
        expect.objectContaining({ progressId }),
      ]),
    });
  });

  it("skips and goes back with a reason; an operation is never reopened", async () => {
    const doc = await start(owner, facilityId);
    const progressId = doc.progressId!;
    const lijado = await stateOf(owner.organizationId, progressId, "Lijado");
    expect(
      await skipStage(operator, DOCUMENTS, {
        stateId: lijado.id,
        reason: "no",
      }),
    ).toMatchObject({ ok: false, field: "reason" });
    expect(
      await skipStage(operator, DOCUMENTS, {
        stateId: lijado.id,
        reason: "Ya venía lijado",
      }),
    ).toMatchObject({ ok: true });
    expect(
      (await stateOf(owner.organizationId, progressId, "Lijado")).status,
    ).toBe("SKIPPED");
    const base = await stateOf(owner.organizationId, progressId, "Base");
    // Armado cannot be skipped.
    expect(
      await skipStage(maker, DOCUMENTS, {
        stateId: base.id,
        reason: "Ya está hecho",
      }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    // Back from Base reopens Lijado for its area, with a notice.
    expect(
      await backStage(maker, DOCUMENTS, {
        stateId: base.id,
        reason: "Quedó con astillas",
      }),
    ).toMatchObject({ ok: true });
    expect(
      (await stateOf(owner.organizationId, progressId, "Lijado")).status,
    ).toBe("READY");
    expect(
      (await stateOf(owner.organizationId, progressId, "Base")).status,
    ).toBe("WAITING");
    const lijadoNotices = (
      await relayed(owner.organizationId, progressId)
    ).filter((row) => row.text.includes("Lijado"));
    expect(lijadoNotices.length).toBe(4); // two at start, two after going back
    // Empaque goes back to an operation that already happened: refused.
    await completeStage(operator, DOCUMENTS, { stateId: lijado.id });
    for (const name of ["Base", "Tapa"]) {
      await completeStage(maker, DOCUMENTS, {
        stateId: (await stateOf(owner.organizationId, progressId, name)).id,
      });
    }
    await forOrganization(owner.organizationId).$transaction(async (tx) => {
      await reachMilestone(tx, DOC, owner, doc.documentId, "CHECK");
      await completeOperationStage(
        tx,
        DOC,
        owner,
        doc.documentId,
        "test.verified",
      );
    }, LOCKING_TRANSACTION);
    const empaque = await stateOf(owner.organizationId, progressId, "Empaque");
    const refused = await backStage(warehouse, DOCUMENTS, {
      stateId: empaque.id,
      reason: "Falta revisar",
    });
    expect(refused).toMatchObject({ ok: false, reason: "not_allowed" });
    if (!refused.ok)
      expect(refused.error).toContain("operación que ya ocurrió");
  });

  it("who leads assigns to a person of the area only, who hears it", async () => {
    const doc = await start(owner, facilityId);
    const lijado = await stateOf(
      owner.organizationId,
      doc.progressId!,
      "Lijado",
    );
    expect(
      await assignStage(operator, DOCUMENTS, {
        stateId: lijado.id,
        assigneeUserId: operator2.userId,
      }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(
      await assignStage(supervisor, DOCUMENTS, {
        stateId: lijado.id,
        assigneeUserId: viewer.userId,
      }),
    ).toMatchObject({ ok: false, field: "assignee" });
    expect(
      await assignStage(supervisor, DOCUMENTS, {
        stateId: lijado.id,
        assigneeUserId: operator2.userId,
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: true });
    expect(
      (await stateOf(owner.organizationId, doc.progressId!, "Lijado"))
        .takenByUserId,
    ).toBe(operator2.userId);
    const heard = await db.notification.count({
      where: {
        organizationId: owner.organizationId,
        typeKey: "processes.assigned",
        recipientUserId: operator2.userId,
      },
    });
    expect(heard).toBeGreaterThanOrEqual(1);
    // Who assigns may release what somebody else has.
    expect(
      await releaseStage(supervisor, DOCUMENTS, { stateId: lijado.id }),
    ).toMatchObject({ ok: true });
    const view = await getProcessView(supervisor, DOCUMENTS, {
      progressId: doc.progressId!,
    });
    const people =
      view?.assignees[lijado.id]?.map((person) => person.userId) ?? [];
    expect(people).toEqual(
      expect.arrayContaining([operator.userId, operator2.userId]),
    );
    expect(people).not.toContain(viewer.userId);
    expect(people).not.toContain(maker.userId);
  });

  it("at a shared terminal a stage is done, never assigned (WMS-38)", async () => {
    const doc = await start(owner, facilityId);
    const lijado = await stateOf(
      owner.organizationId,
      doc.progressId!,
      "Lijado",
    );
    terminalUser = supervisor.userId;
    expect(
      await assignStage(supervisor, DOCUMENTS, {
        stateId: lijado.id,
        assigneeUserId: operator.userId,
      }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    terminalUser = operator.userId;
    expect(
      await completeStage(operator, DOCUMENTS, { stateId: lijado.id }),
    ).toMatchObject({ ok: true });
  });

  it("a new version is for new documents; what started keeps its own (P11)", async () => {
    const before = await start(owner, facilityId);
    await publish(owner, {
      stages: [
        {
          name: "Revisión",
          kind: "MANUAL",
          milestone: "OPEN",
          roles: ["warehouse"],
        },
      ],
    });
    const after = await start(owner, facilityId);
    const versions = await db.processProgress.findMany({
      where: { id: { in: [before.progressId!, after.progressId!] } },
      select: { id: true, version: { select: { number: true } } },
    });
    const numberOf = (id: string) =>
      versions.find((row) => row.id === id)?.version.number;
    expect(numberOf(after.progressId!)).toBeGreaterThan(
      numberOf(before.progressId!)!,
    );
    const old = await getProcessView(owner, DOCUMENTS, {
      progressId: before.progressId!,
    });
    expect(old?.stages.map((stage) => stage.name)).toContain("Lijado");
    const fresh = await getProcessView(owner, DOCUMENTS, {
      progressId: after.progressId!,
    });
    expect(fresh?.stages.map((stage) => stage.name)).toEqual(["Revisión"]);
    // Back to the first process for the rest of the tests.
    await publish(owner);
  });

  it("a photo of a step is evidence: seen by who reads the document", async () => {
    const { owner: o2, facilityId: f2 } = await newCompany();
    await publish(o2, {
      stages: [
        {
          name: "Foto",
          kind: "MANUAL",
          milestone: "OPEN",
          roles: ["operator"],
          photo: "REQUIRED",
        },
      ],
    });
    const worker = await member(o2.organizationId, ["operator"]);
    const reader = await member(o2.organizationId, ["viewer"]);
    const doc = await start(o2, f2);
    const state = await stateOf(o2.organizationId, doc.progressId!, "Foto");
    expect(
      await completeStage(worker, DOCUMENTS, { stateId: state.id }),
    ).toMatchObject({ ok: false, field: "photos" });
    // Who may not do the stage uploads nothing for it (N4).
    expect(
      await uploadProcessPhoto(reader, DOCUMENTS, {
        stateId: state.id,
        name: "a.jpg",
        bytes: TEST_JPEG,
      }),
    ).toMatchObject({ ok: false });
    const photo = await uploadProcessPhoto(worker, DOCUMENTS, {
      stateId: state.id,
      name: "a.jpg",
      bytes: TEST_JPEG,
    });
    if (!photo.ok) throw new Error(photo.error);
    expect(
      await completeStage(worker, DOCUMENTS, {
        stateId: state.id,
        photoIds: [photo.fileId],
      }),
    ).toMatchObject({ ok: true });
    const owners = { process_step: processStepReach(DOCUMENTS) };
    const link = await createFileLink(reader, photo.fileId, {
      owners,
      onlyEvidence: true,
    });
    expect(link.ok).toBe(true);
    // Without the function of its owner, the photo does not exist.
    const blind = await createFileLink(reader, photo.fileId, { owners: {} });
    expect(blind.ok).toBe(false);
    // Another company never sees it.
    const { owner: stranger } = await newCompany();
    const foreign = await createFileLink(stranger, photo.fileId, { owners });
    expect(foreign.ok).toBe(false);
    const view = await getProcessView(reader, DOCUMENTS, {
      progressId: doc.progressId!,
    });
    expect(view?.steps[0]?.photos).toHaveLength(1);
    // Once done, nobody stores photos for that stage any more.
    expect(
      await uploadProcessPhoto(worker, DOCUMENTS, {
        stateId: state.id,
        name: "b.jpg",
        bytes: TEST_JPEG,
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("who hears and who reaches (scope, modules, companies)", () => {
  it("a tied role without its module neither hears nor works (WMS-59)", async () => {
    const { owner, facilityId } = await newCompany(); // without Producción
    await publish(owner, {
      stages: [
        {
          name: "Paso",
          kind: "MANUAL",
          milestone: "OPEN",
          roles: ["operator"],
        },
      ],
    });
    // The stage asks Almacenista; this person has it only through a tied
    // role? No: a mixed member, Almacén + Operario de producción, where the
    // stage asks Operario: their roles in force do not include it.
    const mixed = await member(owner.organizationId, [
      "warehouse",
      "production_operator",
    ]);
    // A stage of the tied role, written straight into a published version
    // (the editor would not offer the role without its module).
    const definition = await db.processDefinition.findFirstOrThrow({
      where: { organizationId: owner.organizationId, documentKey: DOC.key },
      select: { id: true },
    });
    const versionId = newId();
    const stageId = newId();
    await db.processVersion.create({
      data: {
        id: versionId,
        organizationId: owner.organizationId,
        definitionId: definition.id,
        number: 99,
        status: "DRAFT",
        draftKey: definition.id,
        createdByUserId: owner.userId,
      },
    });
    await db.processStage.create({
      data: {
        id: stageId,
        organizationId: owner.organizationId,
        versionId,
        position: 0,
        name: "De producción",
        kind: "MANUAL",
        milestoneKey: "OPEN",
      },
    });
    await db.processStageRole.create({
      data: {
        id: newId(),
        organizationId: owner.organizationId,
        stageId,
        role: "production_operator",
      },
    });
    // As if the module had been removed after publishing: the engine and
    // the editor both refuse such a role now, so it goes straight in.
    await db.processVersion.updateMany({
      where: { organizationId: owner.organizationId, status: "PUBLISHED" },
      data: { status: "RETIRED", currentKey: null, retiredAt: new Date() },
    });
    await db.processVersion.update({
      where: { id: versionId },
      data: {
        status: "PUBLISHED",
        draftKey: null,
        currentKey: definition.id,
        publishedAt: new Date(),
      },
    });
    const doc = await start(owner, facilityId);
    expect(await relayed(owner.organizationId, doc.progressId!)).toEqual([]);
    const state = await stateOf(
      owner.organizationId,
      doc.progressId!,
      "De producción",
    );
    expect(
      await takeStage(mixed, DOCUMENTS, { stateId: state.id }),
    ).toMatchObject({
      ok: false,
      reason: "not_allowed",
    });
    expect(
      (await listProcessWork(mixed, DOCUMENTS, { view: "available" })).total,
    ).toBe(0);
  });

  it("only who reaches the warehouse or the zone hears and works", async () => {
    const { owner, facilityId } = await newCompany();
    const zoneA = await createLocation(owner, { level: 1, name: "Zona A" });
    const zoneB = await createLocation(owner, { level: 1, name: "Zona B" });
    if (!zoneA.ok || !zoneB.ok) throw new Error("zones");
    const other = await db.facility.create({
      data: {
        id: newId(),
        organizationId: owner.organizationId,
        name: "Otro almacén",
        code: `OT-${counter}`,
      },
    });
    await publish(owner, {
      stages: [
        {
          name: "En zona",
          kind: "MANUAL",
          milestone: "OPEN",
          roles: ["operator"],
          zoneOnly: true,
        },
      ],
    });
    const everywhere = await member(owner.organizationId, ["operator"]);
    const inA = await member(
      owner.organizationId,
      ["operator"],
      [{ facilityId, locationId: zoneA.locationId }],
    );
    const elsewhere = await member(
      owner.organizationId,
      ["operator"],
      [{ facilityId: other.id }],
    );
    const docB = await start(owner, facilityId, {
      locationId: zoneB.locationId,
    });
    const heard = (await relayed(owner.organizationId, docB.progressId!)).map(
      (row) => row.recipientUserId,
    );
    expect(heard).toEqual([everywhere.userId]);
    const stateB = await stateOf(
      owner.organizationId,
      docB.progressId!,
      "En zona",
    );
    expect(
      await takeStage(inA, DOCUMENTS, { stateId: stateB.id }),
    ).toMatchObject({
      ok: false,
      reason: "not_allowed",
    });
    // Outside the warehouse, the process does not exist.
    expect(
      await takeStage(elsewhere, DOCUMENTS, { stateId: stateB.id }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(
      await getProcessView(elsewhere, DOCUMENTS, {
        progressId: docB.progressId!,
      }),
    ).toBeNull();
    // The document moves to zone A: the person of zone A may work it now.
    await forOrganization(owner.organizationId).$transaction((tx) =>
      setProcessPlace(tx, DOC, docB.documentId, {
        facilityId,
        locationId: zoneA.locationId,
      }),
    );
    const listed = await listProcessWork(inA, DOCUMENTS, { view: "available" });
    expect(listed.items.map((item) => item.stateId)).toEqual([stateB.id]);
    expect(
      (await listProcessWork(elsewhere, DOCUMENTS, { view: "available" }))
        .total,
    ).toBe(0);
    expect(
      await takeStage(inA, DOCUMENTS, { stateId: stateB.id }),
    ).toMatchObject({
      ok: true,
    });
  });

  it("another company never sees nor touches a process", async () => {
    const { owner, facilityId } = await newCompany();
    await publish(owner, {
      stages: [
        {
          name: "Paso",
          kind: "MANUAL",
          milestone: "OPEN",
          roles: ["operator"],
        },
      ],
    });
    const doc = await start(owner, facilityId);
    const state = await stateOf(owner.organizationId, doc.progressId!, "Paso");
    const { owner: stranger } = await newCompany();
    expect(
      await getProcessView(stranger, DOCUMENTS, {
        progressId: doc.progressId!,
      }),
    ).toBeNull();
    for (const action of [takeStage, completeStage, releaseStage]) {
      expect(
        await action(stranger, DOCUMENTS, { stateId: state.id }),
      ).toMatchObject({ ok: false, reason: "not_found" });
    }
    expect(
      (await listProcessWork(stranger, DOCUMENTS, { view: "available" })).total,
    ).toBe(0);
  });

  it("with the plan expired everything is to see and nothing to do", async () => {
    const { owner, facilityId } = await newCompany();
    await publish(owner, {
      stages: [
        {
          name: "Paso",
          kind: "MANUAL",
          milestone: "OPEN",
          roles: ["operator"],
        },
      ],
    });
    const worker = await member(owner.organizationId, ["operator"]);
    const doc = await start(owner, facilityId);
    const state = await stateOf(owner.organizationId, doc.progressId!, "Paso");
    await db.entitlement.updateMany({
      where: { organizationId: owner.organizationId },
      data: {
        validFrom: new Date(Date.now() - 2 * 86_400_000),
        validUntil: new Date(Date.now() - 86_400_000),
      },
    });
    invalidateEntitlements(owner.organizationId);
    expect(
      await completeStage(worker, DOCUMENTS, { stateId: state.id }),
    ).toMatchObject({ ok: false, reason: "read_only" });
    expect(
      await saveProcessDraft(owner, DOCUMENTS, DOC.key, DRAFT),
    ).toMatchObject({ ok: false, reason: "read_only" });
    const view = await getProcessView(worker, DOCUMENTS, {
      progressId: doc.progressId!,
    });
    expect(view?.readOnly).toBe(true);
    expect(view?.next).toBeNull();
    expect(
      (await listProcessWork(worker, DOCUMENTS, { view: "available" })).total,
    ).toBe(0);
  });

  it("without documents nothing is listed", async () => {
    const { owner } = await newCompany();
    expect(
      await listProcessWork(owner, [], { view: "available" }),
    ).toMatchObject({
      total: 0,
      items: [],
    });
    expect(await countProcessWork(owner, [])).toEqual({
      mine: 0,
      available: 0,
    });
  });
});

describe("review of WMS-74", () => {
  const ONE: DraftInput = {
    stages: [
      {
        name: "Paso",
        kind: "MANUAL",
        milestone: "OPEN",
        roles: ["operator"],
        zoneOnly: true,
      },
    ],
  };

  it("an area takes only roles that can do stages of the document (M1)", async () => {
    const { owner, facilityId } = await newCompany();
    for (const role of ["forklift", "viewer", "manager", "buyer"] as const) {
      const result = await saveProcessDraft(owner, DOCUMENTS, DOC.key, {
        stages: [
          { name: "X", kind: "MANUAL", milestone: "OPEN", roles: [role] },
        ],
      });
      expect(result, role).toMatchObject({ ok: false, reason: "invalid" });
    }
    const view = await getProcessDefinition(owner, DOCUMENTS, DOC.key);
    const offered = view?.roleOptions.map((option) => option.value) ?? [];
    expect(offered).toContain("operator");
    expect(offered).not.toContain("forklift");
    expect(offered).not.toContain("viewer");
    // A draft that got a bad role is refused again at publishing.
    await saveProcessDraft(owner, DOCUMENTS, DOC.key, ONE);
    const stage = await db.processStage.findFirstOrThrow({
      where: {
        organizationId: owner.organizationId,
        version: { status: "DRAFT" },
      },
      select: { id: true },
    });
    await db.processStageRole.create({
      data: {
        id: newId(),
        organizationId: owner.organizationId,
        stageId: stage.id,
        role: "forklift",
      },
    });
    expect(await publishProcess(owner, DOCUMENTS, DOC.key)).toMatchObject({
      ok: false,
      reason: "invalid",
      index: 0,
    });
    // Saved and published in one go; with nobody of the area, it says so.
    expect(
      await saveProcessDraft(owner, DOCUMENTS, DOC.key, ONE, { publish: true }),
    ).toMatchObject({ ok: true, published: true });
    const doc = await start(owner, facilityId);
    const seen = await getProcessView(owner, DOCUMENTS, {
      progressId: doc.progressId!,
    });
    expect(seen?.stages[0]?.leaves[0]?.nobody).toBe(true);
    await member(owner.organizationId, ["operator"]);
    const after = await getProcessView(owner, DOCUMENTS, {
      progressId: doc.progressId!,
    });
    expect(after?.stages[0]?.leaves[0]?.nobody).toBe(false);
  });

  it("reassigning keeps who had it in the trail and tells them (B1)", async () => {
    const { owner, facilityId } = await newCompany();
    await publish(owner, ONE);
    const a = await member(owner.organizationId, ["operator"]);
    const b = await member(owner.organizationId, ["operator"]);
    const lead = await member(owner.organizationId, ["supervisor"]);
    const doc = await start(owner, facilityId);
    const state = await stateOf(owner.organizationId, doc.progressId!, "Paso");
    expect(await takeStage(a, DOCUMENTS, { stateId: state.id })).toMatchObject({
      ok: true,
    });
    expect(
      await assignStage(lead, DOCUMENTS, {
        stateId: state.id,
        assigneeUserId: b.userId,
      }),
    ).toMatchObject({ ok: true });
    const step = await db.processStep.findFirstOrThrow({
      where: { organizationId: owner.organizationId, action: "ASSIGNED" },
      select: { previousUserId: true, assigneeUserId: true },
    });
    expect(step).toEqual({
      previousUserId: a.userId,
      assigneeUserId: b.userId,
    });
    const told = await db.notification.findMany({
      where: {
        organizationId: owner.organizationId,
        recipientUserId: a.userId,
        typeKey: "processes.assigned",
      },
      select: { text: true },
    });
    expect(told.map((row) => row.text).join(" ")).toContain("ahora la tiene");
  });

  it("the same confirmation on two processes at once is refused, not an error (B2)", async () => {
    const { owner, facilityId } = await newCompany();
    await publish(owner, ONE);
    const worker = await member(owner.organizationId, ["operator"]);
    const first = await start(owner, facilityId);
    const second = await start(owner, facilityId);
    const confirmation = key();
    const results = await Promise.all(
      [first, second].map(async (doc) =>
        takeStage(worker, DOCUMENTS, {
          stateId: (
            await stateOf(owner.organizationId, doc.progressId!, "Paso")
          ).id,
          idempotencyKey: confirmation,
        }),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({
      reason: "key_reused",
    });
  });

  it("a confirmation already used on one process is not a retry on another of the same version (WMS-76)", async () => {
    // Both processes share the stages of the published version: the step
    // of the first was taken as a retry of the second («Ya quedó
    // registrado.») when it was already committed, two `ok` for one key.
    const { owner, facilityId } = await newCompany();
    await publish(owner, ONE);
    const worker = await member(owner.organizationId, ["operator"]);
    const first = await start(owner, facilityId);
    const second = await start(owner, facilityId);
    const confirmation = key();
    const stateIn = async (doc: { progressId?: string | null }) =>
      (await stateOf(owner.organizationId, doc.progressId!, "Paso")).id;
    expect(
      await takeStage(worker, DOCUMENTS, {
        stateId: await stateIn(first),
        idempotencyKey: confirmation,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await takeStage(worker, DOCUMENTS, {
        stateId: await stateIn(second),
        idempotencyKey: confirmation,
      }),
    ).toMatchObject({ ok: false, reason: "key_reused" });
    // The real retry, on the first process, still is one.
    expect(
      await takeStage(worker, DOCUMENTS, {
        stateId: await stateIn(first),
        idempotencyKey: confirmation,
      }),
    ).toMatchObject({ ok: true, repeated: true });
    expect(
      (await stateOf(owner.organizationId, second.progressId!, "Paso"))
        .takenByUserId,
    ).toBeNull();
  });

  it("the same confirmation on two processes at once gives one `ok`, every round (WMS-76)", async () => {
    const { owner, facilityId } = await newCompany();
    await publish(owner, ONE);
    const worker = await member(owner.organizationId, ["operator"]);
    for (let round = 0; round < 50; round++) {
      const docs = [
        await start(owner, facilityId),
        await start(owner, facilityId),
      ];
      const states = await Promise.all(
        docs.map(
          async (doc) =>
            (await stateOf(owner.organizationId, doc.progressId!, "Paso")).id,
        ),
      );
      const confirmation = key();
      const results = await Promise.all(
        states.map((stateId) =>
          takeStage(worker, DOCUMENTS, {
            stateId,
            idempotencyKey: confirmation,
          }),
        ),
      );
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.find((result) => !result.ok)).toMatchObject({
        reason: "key_reused",
      });
    }
  }, 180_000);

  it("who assigns is limited by zone too (B3)", async () => {
    const { owner, facilityId } = await newCompany();
    const zoneA = await createLocation(owner, { level: 1, name: "Zona A" });
    const zoneB = await createLocation(owner, { level: 1, name: "Zona B" });
    if (!zoneA.ok || !zoneB.ok) throw new Error("zones");
    await publish(owner, ONE);
    const worker = await member(owner.organizationId, ["operator"]);
    const leadA = await member(
      owner.organizationId,
      ["supervisor"],
      [{ facilityId, locationId: zoneA.locationId }],
    );
    const doc = await start(owner, facilityId, {
      locationId: zoneB.locationId,
    });
    const state = await stateOf(owner.organizationId, doc.progressId!, "Paso");
    expect(
      await assignStage(leadA, DOCUMENTS, {
        stateId: state.id,
        assigneeUserId: worker.userId,
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    await takeStage(worker, DOCUMENTS, { stateId: state.id });
    expect(
      await releaseStage(leadA, DOCUMENTS, { stateId: state.id }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    const view = await getProcessView(leadA, DOCUMENTS, {
      progressId: doc.progressId!,
    });
    expect(view?.stages[0]?.leaves[0]?.canAssign).toBe(false);
    expect(view?.stages[0]?.leaves[0]?.canRelease).toBe(false);
    expect(view?.assignees).toEqual({});
  });

  it("the trail says when it shows only the latest steps (B6)", async () => {
    const { owner, facilityId } = await newCompany();
    await publish(owner, {
      stages: [
        {
          name: "Paso",
          kind: "MANUAL",
          milestone: "OPEN",
          roles: ["operator"],
        },
      ],
    });
    const worker = await member(owner.organizationId, ["operator"]);
    const doc = await start(owner, facilityId);
    const state = await stateOf(owner.organizationId, doc.progressId!, "Paso");
    for (let round = 0; round < 51; round++) {
      await takeStage(worker, DOCUMENTS, { stateId: state.id });
      await releaseStage(worker, DOCUMENTS, { stateId: state.id });
    }
    const view = await getProcessView(worker, DOCUMENTS, {
      progressId: doc.progressId!,
    });
    expect(view?.steps).toHaveLength(100);
    expect(view?.olderSteps).toBe(2);
  }, 60_000);

  it("without the module of the document the screen says so (B7)", async () => {
    const { owner, facilityId } = await newCompany(["production"]);
    await publish(
      owner,
      {
        stages: [
          {
            name: "Corte",
            kind: "MANUAL",
            milestone: "OPEN",
            roles: ["production_operator"],
          },
        ],
      },
      PRODUCTION_DOC,
    );
    const doc = await start(owner, facilityId, { doc: PRODUCTION_DOC });
    expect(
      (await getProcessView(owner, DOCUMENTS, { progressId: doc.progressId! }))
        ?.moduleMissing,
    ).toBe(false);
    // Removed, the module stays to read: the process is seen, read-only.
    await deactivateModule(registry, {
      organizationId: owner.organizationId,
      moduleId: "production",
      actorUserId: null,
    });
    invalidateEntitlements(owner.organizationId);
    const readOnly = await getProcessView(owner, DOCUMENTS, {
      progressId: doc.progressId!,
    });
    expect(readOnly?.moduleMissing).toBe(false);
    expect(readOnly?.readOnly).toBe(true);
    // With no trace of the module at all, the screen says it is missing.
    await db.entitlement.deleteMany({
      where: { organizationId: owner.organizationId, key: "production" },
    });
    invalidateEntitlements(owner.organizationId);
    expect(
      (await getProcessView(owner, DOCUMENTS, { progressId: doc.progressId! }))
        ?.moduleMissing,
    ).toBe(true);
  });

  it("the base keeps the states of a stage and nothing changes once over (N3)", async () => {
    const { owner, facilityId } = await newCompany();
    await publish(owner, {
      stages: [
        { name: "Uno", kind: "MANUAL", milestone: "OPEN", roles: ["operator"] },
        { name: "Dos", kind: "MANUAL", milestone: "OPEN", roles: ["operator"] },
      ],
    });
    const doc = await start(owner, facilityId);
    const dos = await stateOf(owner.organizationId, doc.progressId!, "Dos");
    await expect(
      db.processStageState.update({
        where: { id: dos.id },
        data: { status: "DONE" },
      }),
    ).rejects.toThrow(/transition not allowed/);
    await forOrganization(owner.organizationId).$transaction((tx) =>
      reachMilestone(tx, DOC, owner, doc.documentId, "CANCELLED"),
    );
    const uno = await stateOf(owner.organizationId, doc.progressId!, "Uno");
    await expect(
      db.processStageState.update({
        where: { id: uno.id },
        data: { status: "DONE" },
      }),
    ).rejects.toThrow(/process is over/);
  });

  it("an ended process never opens again, and an operation is never reopened (second review)", async () => {
    const { owner, facilityId } = await newCompany();
    await publish(owner, {
      stages: [
        {
          name: "Verificado",
          kind: "OPERATION",
          operationKey: "test.verified",
        },
        {
          name: "Cierre",
          kind: "MANUAL",
          milestone: "CHECK",
          roles: ["operator"],
        },
      ],
    });
    const doc = await start(owner, facilityId);
    await forOrganization(owner.organizationId).$transaction(async (tx) => {
      await reachMilestone(tx, DOC, owner, doc.documentId, "CHECK");
      await completeOperationStage(
        tx,
        DOC,
        owner,
        doc.documentId,
        "test.verified",
      );
    }, LOCKING_TRANSACTION);
    const verified = await stateOf(
      owner.organizationId,
      doc.progressId!,
      "Verificado",
    );
    await expect(
      db.processStageState.update({
        where: { id: verified.id },
        data: { status: "WAITING" },
      }),
    ).rejects.toThrow(/transition not allowed/);
    const worker = await member(owner.organizationId, ["operator"]);
    await completeStage(worker, DOCUMENTS, {
      stateId: (await stateOf(owner.organizationId, doc.progressId!, "Cierre"))
        .id,
    });
    await expect(
      db.processProgress.update({
        where: { id: doc.progressId! },
        data: { status: "ACTIVE" },
      }),
    ).rejects.toThrow(/transition not allowed/);
  });

  it("photos of many steps are signed only for what their owner confirms", async () => {
    const { owner } = await newCompany();
    const someStep = newId();
    expect(
      await evidencePhotoLinksOf(owner, "process_step", [someStep], undefined),
    ).toEqual(new Map());
    const none = async () => new Set<string>();
    expect(
      await evidencePhotoLinksOf(owner, "process_step", [someStep], none),
    ).toEqual(new Map());
  });

  it("who is limited to a warehouse does not configure processes (N6)", async () => {
    const { owner, facilityId } = await newCompany();
    const admin = await member(
      owner.organizationId,
      ["administrator"],
      [{ facilityId }],
    );
    await expect(getProcessSettings(admin, DOCUMENTS)).rejects.toMatchObject({
      code: "whole_company_required",
    });
    await expect(
      saveProcessDraft(admin, DOCUMENTS, DOC.key, ONE),
    ).rejects.toMatchObject({ code: "whole_company_required" });
  });
});

describe("an operation that may already have happened (WMS-31 review)", () => {
  let answer: boolean | "throw" = false;
  let calls = 0;
  const SETTLE_DOC: ProcessDocument = {
    key: "test.settle",
    module: "inventory",
    label: "Documento con revisión",
    milestones: [
      { key: "OPEN", label: "Abierto" },
      { key: "CANCELLED", label: "Cancelado", closes: true },
    ],
    operations: [
      {
        key: "test.first",
        label: "Primero",
        milestone: "OPEN",
        leadsTo: null,
      },
      {
        key: "test.kept",
        label: "Se guardó",
        milestone: "OPEN",
        leadsTo: null,
        settle: async () => {
          calls += 1;
          if (answer === "throw") throw new Error("boom");
          return answer;
        },
      },
    ],
    readPermission: "inventory.stock.read",
    href: (id) => `/inventario?documento=${id}`,
  };
  const ALL = [...DOCUMENTS, SETTLE_DOC];
  const TWO: DraftInput = {
    stages: [
      { name: "Paso", kind: "MANUAL", milestone: "OPEN", roles: ["warehouse"] },
      { name: "Guardado", kind: "OPERATION", operationKey: "test.kept" },
    ],
  };

  async function ready(owner: Actor, facilityId: string) {
    const saved = await saveProcessDraft(owner, ALL, SETTLE_DOC.key, TWO);
    if (!saved.ok) throw new Error(saved.error);
    const published = await publishProcess(owner, ALL, SETTLE_DOC.key);
    if (!published.ok) throw new Error("publish refused");
    const started = await start(owner, facilityId, { doc: SETTLE_DOC });
    return started.progressId!;
  }

  it("is not asked while the stage waits, and is asked once when it becomes ready", async () => {
    const { owner, facilityId } = await newCompany();
    answer = false;
    calls = 0;
    const progressId = await ready(owner, facilityId);
    expect(calls).toBe(0);
    const paso = await stateOf(owner.organizationId, progressId, "Paso");
    expect(
      await completeStage(owner, ALL, {
        stateId: paso.id,
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: true });
    expect(calls).toBe(1);
    expect(
      (await stateOf(owner.organizationId, progressId, "Guardado")).status,
    ).toBe("READY");
  });

  it("ends the stage right there when the operation already happened", async () => {
    const { owner, facilityId } = await newCompany();
    answer = true;
    calls = 0;
    const progressId = await ready(owner, facilityId);
    const paso = await stateOf(owner.organizationId, progressId, "Paso");
    expect(
      await completeStage(owner, ALL, {
        stateId: paso.id,
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: true });
    expect(calls).toBe(1);
    expect(
      (await stateOf(owner.organizationId, progressId, "Guardado")).status,
    ).toBe("DONE");
    expect(
      (
        await db.processProgress.findFirstOrThrow({
          where: { id: progressId },
        })
      ).status,
    ).toBe("DONE");
  });

  it("inside a module's call a failing check is logged, undoes nothing, and a later evaluation ends the stage", async () => {
    const { owner, facilityId } = await newCompany();
    const ONLY: DraftInput = {
      stages: [
        { name: "Guardado", kind: "OPERATION", operationKey: "test.kept" },
      ],
    };
    const saved = await saveProcessDraft(owner, ALL, SETTLE_DOC.key, ONLY);
    if (!saved.ok) throw new Error(saved.error);
    const published = await publishProcess(owner, ALL, SETTLE_DOC.key);
    if (!published.ok) throw new Error("publish refused");
    // startProcess: the stage is ready at once and its check fails.
    answer = "throw";
    const started = await start(owner, facilityId, { doc: SETTLE_DOC });
    expect(started.started).toBe(true);
    expect(
      (await stateOf(owner.organizationId, started.progressId!, "Guardado"))
        .status,
    ).toBe("READY");
    // Any later evaluation asks again: now it ends the stage.
    answer = true;
    await forOrganization(owner.organizationId).$transaction(
      (tx) => reachMilestone(tx, SETTLE_DOC, owner, started.documentId, "OPEN"),
      LOCKING_TRANSACTION,
    );
    expect(
      (await stateOf(owner.organizationId, started.progressId!, "Guardado"))
        .status,
    ).toBe("DONE");
  });

  it("a failing check after completeOperationStage keeps the operation", async () => {
    const { owner, facilityId } = await newCompany();
    const PAIR: DraftInput = {
      stages: [
        { name: "Primero", kind: "OPERATION", operationKey: "test.first" },
        { name: "Guardado", kind: "OPERATION", operationKey: "test.kept" },
      ],
    };
    const saved = await saveProcessDraft(owner, ALL, SETTLE_DOC.key, PAIR);
    if (!saved.ok) throw new Error(saved.error);
    const published = await publishProcess(owner, ALL, SETTLE_DOC.key);
    if (!published.ok) throw new Error("publish refused");
    answer = false;
    const started = await start(owner, facilityId, { doc: SETTLE_DOC });
    answer = "throw";
    const done = await forOrganization(owner.organizationId).$transaction(
      (tx) =>
        completeOperationStage(
          tx,
          SETTLE_DOC,
          owner,
          started.documentId,
          "test.first",
        ),
      LOCKING_TRANSACTION,
    );
    expect(done).toEqual({ applied: true });
    expect(
      (await stateOf(owner.organizationId, started.progressId!, "Primero"))
        .status,
    ).toBe("DONE");
    expect(
      (await stateOf(owner.organizationId, started.progressId!, "Guardado"))
        .status,
    ).toBe("READY");
  });

  it("a check that fails undoes the action of the person, with a clear message", async () => {
    const { owner, facilityId } = await newCompany();
    answer = "throw";
    const progressId = await ready(owner, facilityId);
    const paso = await stateOf(owner.organizationId, progressId, "Paso");
    expect(
      await completeStage(owner, ALL, {
        stateId: paso.id,
        idempotencyKey: key(),
      }),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("No se pudo revisar"),
    });
    expect(
      (await stateOf(owner.organizationId, progressId, "Paso")).status,
    ).toBe("READY");
  });
});
