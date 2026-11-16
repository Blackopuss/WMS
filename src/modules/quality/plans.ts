import "server-only";

import { dec, formatDecimal, newId } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import { isAllowed } from "@/platform/authorization";
import { assertModulePermission } from "@/platform/billing";
import { getUnit, parseQuantity } from "@/platform/catalog";
import { parseSettingValue, readSetting } from "@/platform/settings";
import {
  LOCKING_TRANSACTION,
  forOrganization,
  lockRows,
  type TenantDb,
} from "@/server";

import {
  INSPECTION_ORIGINS,
  MAX_PLAN_POINTS,
  ORIGIN_LABELS,
  POINT_KIND_LABELS,
  SAMPLINGS,
  SAMPLING_LABELS,
  cleanText,
  foldText,
  parsePoint,
  rangeText,
  resolveSampling,
  type InspectionOrigin,
  type PlanPoint,
  type PlanSampling,
  type PointField,
  type PointInput,
  type SampleRule,
  type Sampling,
} from "./plan-rules";
import { SAMPLING_DEFAULT } from "./settings";

/**
 * Inspection plans of the products (WMS-30A, ADR 0067). One plan per
 * product, with versions: a draft is prepared, published and then never
 * edited (also triggers); changing the plan is publishing the next
 * version. Nothing is deleted: a discarded draft and a retired version stay
 * readable. Configuring is `quality.plan.manage` (titular and
 * administration); reading, `quality.plan.read`. Nothing here touches
 * stock.
 *
 * Locks: product → plan, in a LOCKING_TRANSACTION. Changes to a draft lock
 * only its plan.
 */

type Actor = { organizationId: string; userId: string };
type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];
type Reader = Pick<Tx, "qualityPlanVersion" | "membership">;

const READ = "quality.plan.read" as const;
const MANAGE = "quality.plan.manage" as const;

export type PlanField =
  | PointField
  | "sampling"
  | "sampleQuantity"
  | "samplePercent"
  | "sampleMin"
  | "sampleMax"
  | "origins";

export type PlanResult =
  | { ok: true; message: string; versionId?: string; repeated?: true }
  | { ok: false; error: string; field?: PlanField };

type Failure = Extract<PlanResult, { ok: false }>;

/** Carries an expected failure out of the transaction so it rolls back. */
class Rejected extends Error {
  constructor(readonly result: Failure) {
    super("quality plan rejected");
  }
}

function fail(error: string, field?: PlanField): never {
  throw new Rejected({ ok: false, error, field });
}

async function run(
  organizationId: string,
  change: (tx: Tx) => Promise<PlanResult>,
): Promise<PlanResult> {
  try {
    return await forOrganization(organizationId).$transaction(
      change,
      LOCKING_TRANSACTION,
    );
  } catch (error) {
    if (error instanceof Rejected) return error.result;
    if ((error as { code?: string }).code === "P2002") {
      // Two names the database compares as equal (the collation folds
      // more than foldText, «ß» and «ss»): say which list it was.
      const target = JSON.stringify((error as { meta?: unknown }).meta ?? "");
      return target.includes("option") || target.includes("pointId")
        ? {
            ok: false,
            error: "Dos opciones de la lista se leen igual. Cambia una.",
            field: "options",
          }
        : {
            ok: false,
            error: "Ese punto ya está en el plan. Usa otro nombre.",
            field: "label",
          };
    }
    throw error;
  }
}

const GONE = "Ese borrador ya no se puede cambiar: se publicó o se descartó.";

/** The product, under its lock, still active. */
async function lockActiveProduct(tx: Tx, productId: string) {
  const [locked] = await lockRows(tx, "product", [String(productId)]);
  if (!locked) fail("Ese producto no existe.");
  const product = await tx.product.findFirstOrThrow({
    where: { id: locked },
    select: {
      id: true,
      name: true,
      status: true,
      unitCode: true,
      quantityStep: true,
    },
  });
  if (product.status !== "ACTIVE") {
    fail("El producto está archivado: su plan de inspección ya no cambia.");
  }
  return product;
}

/** A draft and its plan, with the plan locked; refuses anything else. */
async function lockDraft(tx: Tx, versionId: string) {
  const found = await tx.qualityPlanVersion.findFirst({
    where: { id: String(versionId) },
    select: { planId: true },
  });
  if (!found) fail("Ese plan no existe.");
  await lockRows(tx, "qualityPlan", [found!.planId]);
  const version = await tx.qualityPlanVersion.findFirstOrThrow({
    where: { id: String(versionId) },
    select: {
      id: true,
      planId: true,
      number: true,
      status: true,
      plan: {
        select: {
          productId: true,
          product: {
            select: {
              name: true,
              status: true,
              unitCode: true,
              quantityStep: true,
            },
          },
        },
      },
    },
  });
  if (version.status !== "DRAFT") fail(GONE);
  if (version.plan.product.status !== "ACTIVE") {
    fail("El producto está archivado: su plan de inspección ya no cambia.");
  }
  return version;
}

// ---------------------------------------------------------------------------
// Reading

const POINT_SELECT = {
  id: true,
  label: true,
  kind: true,
  required: true,
  photo: true,
  minValue: true,
  maxValue: true,
  unitLabel: true,
  options: {
    orderBy: { position: "asc" },
    select: { id: true, label: true, acceptable: true },
  },
} as const;

const VERSION_SELECT = {
  id: true,
  number: true,
  status: true,
  sampling: true,
  sampleRule: true,
  sampleQuantity: true,
  samplePercent: true,
  sampleMin: true,
  sampleMax: true,
  forProduced: true,
  forReceived: true,
  forReturned: true,
  createdByUserId: true,
  createdAt: true,
  publishedByUserId: true,
  publishedAt: true,
  closedByUserId: true,
  closedAt: true,
  points: {
    orderBy: { position: "asc" },
    select: POINT_SELECT,
  },
} as const;

/** One version of a plan with what screens show of it. */
function readVersion(
  client: Pick<Tx, "qualityPlanVersion">,
  where: { planId: string; status: "ACTIVE" | "DRAFT" },
) {
  return client.qualityPlanVersion.findFirst({
    where,
    select: VERSION_SELECT,
  });
}
type VersionRow = NonNullable<Awaited<ReturnType<typeof readVersion>>>;
type PointRow = {
  id: string;
  label: string;
  kind: PlanPoint["kind"];
  required: boolean;
  photo: boolean;
  minValue: { toString(): string } | null;
  maxValue: { toString(): string } | null;
  unitLabel: string | null;
  options: { id: string; label: string; acceptable: boolean }[];
};

const plain = (value: { toString(): string } | null) =>
  value === null ? null : dec(value.toString()).toString();

function pointOf(row: PointRow): PlanPoint {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    required: row.required,
    photo: row.photo,
    minValue: plain(row.minValue),
    maxValue: plain(row.maxValue),
    unitLabel: row.unitLabel,
    options: row.options,
  };
}

function ruleOf(row: {
  sampleRule: "FIXED" | "PERCENT" | null;
  sampleQuantity: { toString(): string } | null;
  samplePercent: number | null;
  sampleMin: { toString(): string } | null;
  sampleMax: { toString(): string } | null;
}): SampleRule | null {
  if (row.sampleRule === "FIXED") {
    return { kind: "FIXED", quantity: plain(row.sampleQuantity) ?? "1" };
  }
  if (row.sampleRule === "PERCENT") {
    return {
      kind: "PERCENT",
      percent: row.samplePercent ?? 100,
      min: plain(row.sampleMin) ?? "1",
      max: plain(row.sampleMax),
    };
  }
  return null;
}

function originsOf(row: {
  forProduced: boolean;
  forReceived: boolean;
  forReturned: boolean;
}): InspectionOrigin[] {
  return INSPECTION_ORIGINS.filter((origin) =>
    origin === "produced"
      ? row.forProduced
      : origin === "received"
        ? row.forReceived
        : row.forReturned,
  );
}

/** «Por muestra: 10 % (al menos 5, como mucho 50 piezas)». */
export function samplingText(
  sampling: PlanSampling,
  rule: SampleRule | null,
  unit: string,
): string {
  if (sampling !== "SAMPLE" || !rule) return SAMPLING_LABELS[sampling];
  if (rule.kind === "FIXED") {
    return `Por muestra: ${formatDecimal(rule.quantity)} ${unit}`;
  }
  const max =
    rule.max === null ? "" : `, como mucho ${formatDecimal(rule.max)}`;
  return `Por muestra: ${rule.percent} % (al menos ${formatDecimal(rule.min)}${max} ${unit})`;
}

export type PlanPointView = PlanPoint & { kindLabel: string; detail: string };

export type PlanVersionView = {
  id: string;
  number: number;
  status: "DRAFT" | "ACTIVE" | "RETIRED" | "DISCARDED";
  sampling: PlanSampling;
  rule: SampleRule | null;
  samplingText: string;
  origins: InspectionOrigin[];
  originsText: string;
  points: PlanPointView[];
  createdByName: string | null;
  createdAt: Date;
  publishedByName: string | null;
  publishedAt: Date | null;
  closedAt: Date | null;
};

function detailOf(point: PlanPoint): string {
  switch (point.kind) {
    case "CHECK":
      return "Cumple si es «sí»";
    case "NUMBER":
      return rangeText(point);
    case "CHOICE":
      return `Cumple con: ${point.options
        .filter((option) => option.acceptable)
        .map((option) => option.label)
        .join(", ")} · No cumple: ${point.options
        .filter((option) => !option.acceptable)
        .map((option) => option.label)
        .join(", ")}`;
    case "TEXT":
      return "Solo se anota";
  }
}

async function namesOf(
  client: Reader,
  ids: (string | null)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const members = await client.membership.findMany({
    where: { userId: { in: unique } },
    select: { userId: true, user: { select: { name: true } } },
  });
  return new Map(members.map((member) => [member.userId, member.user.name]));
}

function viewOf(
  row: VersionRow,
  names: Map<string, string>,
  unit: string,
): PlanVersionView {
  const rule = ruleOf(row);
  const origins = originsOf(row);
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    sampling: row.sampling,
    rule,
    samplingText: samplingText(row.sampling, rule, unit),
    origins,
    originsText: origins.map((origin) => ORIGIN_LABELS[origin]).join(", "),
    points: row.points.map((each) => {
      const point = pointOf(each);
      return {
        ...point,
        kindLabel: POINT_KIND_LABELS[point.kind],
        detail: detailOf(point),
      };
    }),
    createdByName: names.get(row.createdByUserId) ?? null,
    createdAt: row.createdAt,
    publishedByName: row.publishedByUserId
      ? (names.get(row.publishedByUserId) ?? null)
      : null,
    publishedAt: row.publishedAt,
    closedAt: row.closedAt,
  };
}

/** Versions listed per page under «Versiones anteriores». */
export const PLAN_HISTORY_PAGE_SIZE = 10;

export type ProductInspection = {
  productId: string;
  productName: string;
  productActive: boolean;
  unitCode: string;
  quantityStep: string;
  /** The version in force, or null when the product has no plan. */
  active: PlanVersionView | null;
  /** The draft being prepared; only for who may configure. */
  draft: PlanVersionView | null;
  /**
   * Earlier versions, newest first, one page: retired ones for everybody,
   * discarded drafts only for who may configure.
   */
  history: {
    items: PlanVersionView[];
    page: number;
    pageCount: number;
    total: number;
  };
  /** What rules without a plan (`quality.sampling.default`). */
  defaultSamplingText: string;
};

/**
 * The inspection plan of a product, for its card and its screen. The
 * version in force and the draft are read on their own; the history is
 * paged in the database (INV-10), a page out of range shows the last one.
 * Null when the product is not of the company.
 */
export async function getProductInspection(
  actor: Actor,
  productId: string,
  options: { page?: number } = {},
): Promise<ProductInspection | null> {
  await assertModulePermission(actor.organizationId, actor.userId, READ);
  const client = forOrganization(actor.organizationId);
  const product = await client.product.findFirst({
    where: { id: String(productId) },
    select: {
      id: true,
      name: true,
      status: true,
      unitCode: true,
      quantityStep: true,
      qualityPlans: { select: { id: true } },
    },
  });
  if (!product) return null;
  const [setting, mayManage] = await Promise.all([
    readSetting(client, SAMPLING_DEFAULT),
    isAllowed(actor.organizationId, actor.userId, MANAGE),
  ]);
  const planId = product.qualityPlans[0]?.id ?? null;
  // A discarded draft is a draft: only for who may configure.
  const statuses: ("RETIRED" | "DISCARDED")[] = mayManage
    ? ["RETIRED", "DISCARDED"]
    : ["RETIRED"];
  const total = planId
    ? await client.qualityPlanVersion.count({
        where: { planId, status: { in: statuses } },
      })
    : 0;
  const pageCount = Math.max(1, Math.ceil(total / PLAN_HISTORY_PAGE_SIZE));
  const page =
    options.page === undefined || !Number.isSafeInteger(options.page)
      ? 1
      : Math.min(Math.max(options.page, 1), pageCount);
  const [active, draft, history] = planId
    ? await Promise.all([
        readVersion(client, { planId, status: "ACTIVE" }),
        mayManage ? readVersion(client, { planId, status: "DRAFT" }) : null,
        client.qualityPlanVersion.findMany({
          where: { planId, status: { in: statuses } },
          // The number is unique in the plan: a stable order on its index.
          orderBy: [{ number: "desc" }, { id: "desc" }],
          skip: (page - 1) * PLAN_HISTORY_PAGE_SIZE,
          take: PLAN_HISTORY_PAGE_SIZE,
          select: VERSION_SELECT,
        }),
      ])
    : [null, null, []];
  const rows = [active, draft, ...history].filter(
    (row): row is VersionRow => row !== null,
  );
  const names = await namesOf(
    client,
    rows.flatMap((row) => [row.createdByUserId, row.publishedByUserId]),
  );
  const unit = unitText(product.unitCode);
  return {
    productId: product.id,
    productName: product.name,
    productActive: product.status === "ACTIVE",
    unitCode: product.unitCode,
    quantityStep: product.quantityStep.toString(),
    active: active ? viewOf(active, names, unit) : null,
    draft: draft ? viewOf(draft, names, unit) : null,
    history: {
      items: history.map((row) => viewOf(row, names, unit)),
      page,
      pageCount,
      total,
    },
    defaultSamplingText: setting === "sample" ? "Por muestra" : "Completa",
  };
}

/** Plural name of a unit, for texts («piezas», «kilogramos»). */
function unitText(unitCode: string): string {
  return getUnit(unitCode).plural;
}

// ---------------------------------------------------------------------------
// Changing

/**
 * Opens the draft of the next version, copied from the one in force (or
 * empty the first time). A plan has one draft: asking again returns it.
 */
export async function startPlanDraft(
  actor: Actor,
  productId: string,
): Promise<PlanResult> {
  await assertModulePermission(actor.organizationId, actor.userId, MANAGE);
  return run(actor.organizationId, async (tx) => {
    const product = await lockActiveProduct(tx, productId);
    let plan = await tx.qualityPlan.findFirst({
      where: { productId: product.id },
      select: { id: true },
    });
    if (!plan) {
      plan = await tx.qualityPlan.create({
        data: {
          id: newId(),
          organizationId: actor.organizationId,
          productId: product.id,
          createdByUserId: actor.userId,
        },
        select: { id: true },
      });
    }
    await lockRows(tx, "qualityPlan", [plan.id]);
    const versions = await tx.qualityPlanVersion.findMany({
      where: { planId: plan.id, status: { in: ["DRAFT", "ACTIVE"] } },
      select: VERSION_SELECT,
    });
    const draft = versions.find((version) => version.status === "DRAFT");
    if (draft) {
      return {
        ok: true,
        repeated: true,
        versionId: draft.id,
        message: `El borrador de la versión ${draft.number} ya estaba abierto.`,
      };
    }
    const last = await tx.qualityPlanVersion.findFirst({
      where: { planId: plan.id },
      orderBy: { number: "desc" },
      select: { number: true },
    });
    const number = (last?.number ?? 0) + 1;
    const active = versions.find((version) => version.status === "ACTIVE");
    const versionId = newId();
    await tx.qualityPlanVersion.create({
      data: {
        id: versionId,
        organizationId: actor.organizationId,
        planId: plan.id,
        number,
        createdByUserId: actor.userId,
        ...(active
          ? {
              sampling: active.sampling,
              sampleRule: active.sampleRule,
              sampleQuantity: active.sampleQuantity,
              samplePercent: active.samplePercent,
              sampleMin: active.sampleMin,
              sampleMax: active.sampleMax,
              forProduced: active.forProduced,
              forReceived: active.forReceived,
              forReturned: active.forReturned,
            }
          : {}),
      },
    });
    for (const [position, point] of (active?.points ?? []).entries()) {
      await insertPoint(
        tx,
        actor.organizationId,
        versionId,
        position + 1,
        pointOf(point),
      );
    }
    return {
      ok: true,
      versionId,
      message: active
        ? `Se abrió el borrador de la versión ${number}, copiado de la vigente.`
        : "Se abrió el borrador del plan.",
    };
  });
}

async function insertPoint(
  tx: Tx,
  organizationId: string,
  versionId: string,
  position: number,
  point: Omit<PlanPoint, "id" | "options"> & {
    options: { label: string; acceptable: boolean }[];
  },
) {
  const pointId = newId();
  await tx.qualityPlanPoint.create({
    data: {
      id: pointId,
      organizationId,
      versionId,
      position,
      label: point.label,
      kind: point.kind,
      required: point.required,
      photo: point.photo,
      minValue: point.minValue,
      maxValue: point.maxValue,
      unitLabel: point.unitLabel,
    },
  });
  if (point.options.length > 0) {
    await tx.qualityPlanPointOption.createMany({
      data: point.options.map((option, index) => ({
        id: newId(),
        organizationId,
        pointId,
        position: index + 1,
        label: option.label,
        acceptable: option.acceptable,
      })),
    });
  }
}

export type DraftInput = {
  sampling?: unknown;
  sampleRule?: unknown;
  sampleQuantity?: unknown;
  samplePercent?: unknown;
  sampleMin?: unknown;
  sampleMax?: unknown;
  forProduced?: unknown;
  forReceived?: unknown;
  forReturned?: unknown;
};

/** Changes how the quality is checked and what the draft applies to. */
export async function updatePlanDraft(
  actor: Actor,
  versionId: string,
  input: DraftInput,
): Promise<PlanResult> {
  await assertModulePermission(actor.organizationId, actor.userId, MANAGE);
  return run(actor.organizationId, async (tx) => {
    const version = await lockDraft(tx, versionId);
    const product = version.plan.product;
    const sampling = String(input.sampling ?? "") as PlanSampling;
    if (!SAMPLINGS.includes(sampling)) {
      fail("Elige cómo se revisa la calidad.", "sampling");
    }
    const quantityOf = (raw: unknown, field: PlanField) => {
      const parsed = parseQuantity(
        {
          unitCode: product.unitCode,
          quantityStep: product.quantityStep.toString(),
        },
        cleanText(raw),
      );
      if (!parsed.ok) fail(parsed.error, field);
      return (
        parsed as { quantity: { toString(): string } }
      ).quantity.toString();
    };
    const data: {
      sampling: PlanSampling;
      sampleRule: "FIXED" | "PERCENT" | null;
      sampleQuantity: string | null;
      samplePercent: number | null;
      sampleMin: string | null;
      sampleMax: string | null;
    } = {
      sampling,
      sampleRule: null,
      sampleQuantity: null,
      samplePercent: null,
      sampleMin: null,
      sampleMax: null,
    };
    if (sampling === "SAMPLE") {
      const rule = String(input.sampleRule ?? "");
      if (rule === "FIXED") {
        data.sampleRule = "FIXED";
        data.sampleQuantity = quantityOf(
          input.sampleQuantity,
          "sampleQuantity",
        );
      } else if (rule === "PERCENT") {
        data.sampleRule = "PERCENT";
        const percentText = cleanText(input.samplePercent);
        const percent = /^\d{1,3}$/.test(percentText)
          ? Number(percentText)
          : NaN;
        if (!(percent >= 1 && percent <= 100)) {
          fail("Escribe un porcentaje entero de 1 a 100.", "samplePercent");
        }
        data.samplePercent = percent;
        data.sampleMin = quantityOf(input.sampleMin, "sampleMin");
        if (cleanText(input.sampleMax) !== "") {
          data.sampleMax = quantityOf(input.sampleMax, "sampleMax");
          if (dec(data.sampleMax).lt(data.sampleMin)) {
            fail("El tope no puede ser menor que el mínimo.", "sampleMax");
          }
        }
      } else {
        fail("Elige cómo se calcula la muestra.", "sampling");
      }
    }
    const origins = {
      forProduced: input.forProduced === true,
      forReceived: input.forReceived === true,
      forReturned: input.forReturned === true,
    };
    if (!origins.forProduced && !origins.forReceived && !origins.forReturned) {
      fail("Marca al menos a qué aplica el plan.", "origins");
    }
    await tx.qualityPlanVersion.update({
      where: { id: version.id },
      data: { ...data, ...origins },
    });
    return {
      ok: true,
      versionId: version.id,
      message: "Se guardó el borrador.",
    };
  });
}

/** Adds a check point at the end of the draft. */
export async function addPlanPoint(
  actor: Actor,
  versionId: string,
  input: PointInput,
): Promise<PlanResult> {
  await assertModulePermission(actor.organizationId, actor.userId, MANAGE);
  const parsed = parsePoint(input);
  if (!parsed.ok) return parsed;
  return run(actor.organizationId, async (tx) => {
    const version = await lockDraft(tx, versionId);
    const points = await tx.qualityPlanPoint.findMany({
      where: { versionId: version.id },
      select: { label: true, position: true },
    });
    if (points.length >= MAX_PLAN_POINTS) {
      fail(`Un plan admite hasta ${MAX_PLAN_POINTS} puntos.`);
    }
    const key = foldText(parsed.point.label);
    if (points.some((point) => foldText(point.label) === key)) {
      fail("Ese punto ya está en el plan. Usa otro nombre.", "label");
    }
    const position = Math.max(0, ...points.map((point) => point.position)) + 1;
    await insertPoint(
      tx,
      actor.organizationId,
      version.id,
      position,
      parsed.point,
    );
    return {
      ok: true,
      versionId: version.id,
      message: `Se agregó «${parsed.point.label}».`,
    };
  });
}

/** Takes a point out of the draft (a draft is not used by anything yet). */
export async function removePlanPoint(
  actor: Actor,
  pointId: string,
): Promise<PlanResult> {
  await assertModulePermission(actor.organizationId, actor.userId, MANAGE);
  return run(actor.organizationId, async (tx) => {
    const found = await tx.qualityPlanPoint.findFirst({
      where: { id: String(pointId) },
      select: { versionId: true },
    });
    if (!found) fail("Ese punto ya no está en el plan.");
    const version = await lockDraft(tx, found!.versionId);
    const point = await tx.qualityPlanPoint.findFirst({
      where: { id: String(pointId), versionId: version.id },
      select: { id: true, label: true },
    });
    if (!point) fail("Ese punto ya no está en el plan.");
    await tx.qualityPlanPointOption.deleteMany({
      where: { pointId: point!.id },
    });
    await tx.qualityPlanPoint.delete({ where: { id: point!.id } });
    return {
      ok: true,
      versionId: version.id,
      message: `Se quitó «${point!.label}».`,
    };
  });
}

/**
 * Publishes the draft: the version in force is retired and the draft
 * rules from now on. Two at once: one publishes, the other is told it
 * already was.
 */
export async function publishPlanDraft(
  actor: Actor,
  versionId: string,
): Promise<PlanResult> {
  await assertModulePermission(actor.organizationId, actor.userId, MANAGE);
  return run(actor.organizationId, async (tx) => {
    const found = await tx.qualityPlanVersion.findFirst({
      where: { id: String(versionId) },
      select: { planId: true, plan: { select: { productId: true } } },
    });
    if (!found) fail("Ese plan no existe.");
    const product = await lockActiveProduct(tx, found!.plan.productId);
    await lockRows(tx, "qualityPlan", [found!.planId]);
    const version = await tx.qualityPlanVersion.findFirstOrThrow({
      where: { id: String(versionId) },
      select: {
        id: true,
        number: true,
        status: true,
        sampling: true,
        sampleRule: true,
        sampleQuantity: true,
        samplePercent: true,
        sampleMin: true,
        sampleMax: true,
        forProduced: true,
        forReceived: true,
        forReturned: true,
        _count: { select: { points: true } },
      },
    });
    if (version.status === "ACTIVE") {
      return {
        ok: true,
        repeated: true,
        versionId: version.id,
        message: `La versión ${version.number} ya estaba publicada.`,
      };
    }
    if (version.status !== "DRAFT") fail(GONE);
    if (version._count.points === 0) {
      fail("Agrega al menos un punto de revisión antes de publicar.");
    }
    // The rule of quantities of the product may have changed since the
    // draft was saved: the sample is checked again with the one in force.
    const rule = {
      unitCode: product.unitCode,
      quantityStep: product.quantityStep.toString(),
    };
    for (const [value, field] of [
      [version.sampleQuantity, "sampleQuantity"],
      [version.sampleMin, "sampleMin"],
      [version.sampleMax, "sampleMax"],
    ] as const) {
      if (value === null) continue;
      const parsed = parseQuantity(rule, dec(value.toString()).toString());
      if (!parsed.ok) {
        fail(
          `El tamaño de la muestra ya no sirve para este producto: ${parsed.error} Corrígelo y guarda el borrador.`,
          field,
        );
      }
    }
    const now = new Date();
    const current = await tx.qualityPlanVersion.findFirst({
      where: { planId: found!.planId, status: "ACTIVE" },
      select: { id: true, number: true },
    });
    if (current) {
      await tx.qualityPlanVersion.update({
        where: { id: current.id },
        data: {
          status: "RETIRED",
          closedAt: now,
          closedByUserId: actor.userId,
        },
      });
    }
    await tx.qualityPlanVersion.update({
      where: { id: version.id },
      data: {
        status: "ACTIVE",
        publishedAt: now,
        publishedByUserId: actor.userId,
      },
    });
    const sample = ruleOf(version);
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: "quality.plan_published",
      target: { type: "quality_plan_version", id: version.id },
      metadata: {
        producto: product.name,
        version: version.number,
        reemplaza: current?.number ?? null,
        revision: samplingText(
          version.sampling,
          sample,
          unitText(product.unitCode),
        ),
        aplicaA: originsOf(version)
          .map((origin) => ORIGIN_LABELS[origin])
          .join(", "),
        puntos: version._count.points,
      },
    });
    return {
      ok: true,
      versionId: version.id,
      message: `Se publicó la versión ${version.number} del plan de inspección.`,
    };
  });
}

/** Drops the draft; it stays readable as discarded. */
export async function discardPlanDraft(
  actor: Actor,
  versionId: string,
): Promise<PlanResult> {
  await assertModulePermission(actor.organizationId, actor.userId, MANAGE);
  return run(actor.organizationId, async (tx) => {
    const found = await tx.qualityPlanVersion.findFirst({
      where: { id: String(versionId) },
      select: { planId: true },
    });
    if (!found) fail("Ese plan no existe.");
    await lockRows(tx, "qualityPlan", [found!.planId]);
    const version = await tx.qualityPlanVersion.findFirstOrThrow({
      where: { id: String(versionId) },
      select: {
        id: true,
        number: true,
        status: true,
        plan: { select: { product: { select: { name: true } } } },
      },
    });
    if (version.status === "DISCARDED") {
      return {
        ok: true,
        repeated: true,
        message: "Ese borrador ya estaba descartado.",
      };
    }
    if (version.status !== "DRAFT") fail(GONE);
    await tx.qualityPlanVersion.update({
      where: { id: version.id },
      data: {
        status: "DISCARDED",
        closedAt: new Date(),
        closedByUserId: actor.userId,
      },
    });
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: "quality.plan_discarded",
      target: { type: "quality_plan_version", id: version.id },
      metadata: {
        producto: version.plan.product.name,
        version: version.number,
      },
    });
    return { ok: true, message: "Se descartó el borrador." };
  });
}

// ---------------------------------------------------------------------------
// For the inspection (WMS-30B)

type PlanReader = Pick<Tx, "qualityPlanVersion" | "organizationSetting">;

export type InspectionPlan = {
  versionId: string;
  number: number;
  /** With the company setting already applied. */
  sampling: Sampling;
  points: PlanPoint[];
};

/** The sampling setting of the company, read with its id in the filter. */
async function samplingSettingOf(
  tx: Pick<Tx, "organizationSetting">,
  organizationId: string,
): Promise<string> {
  const row = await tx.organizationSetting.findFirst({
    where: {
      organizationId: String(organizationId),
      key: SAMPLING_DEFAULT.key,
    },
    select: { value: true },
  });
  if (!row) return SAMPLING_DEFAULT.defaultValue;
  const parsed = parseSettingValue(SAMPLING_DEFAULT, row.value);
  return parsed.ok ? parsed.value : SAMPLING_DEFAULT.defaultValue;
}

/**
 * The plan in force of a product for what comes from `origin`, with its
 * sampling resolved, or null when there is none for that origin (then
 * `samplingWithoutPlan` says how the quality is checked). Call it inside
 * the transaction of the inspection, after its locks; it checks no
 * permission: the service that calls it already did. Every query names
 * the company, whatever client it gets.
 */
export async function inspectionPlanFor(
  tx: PlanReader,
  organizationId: string,
  productId: string,
  origin: InspectionOrigin,
): Promise<InspectionPlan | null> {
  const company = String(organizationId);
  const row = await tx.qualityPlanVersion.findFirst({
    where: {
      organizationId: company,
      status: "ACTIVE",
      plan: { organizationId: company, productId: String(productId) },
    },
    select: {
      id: true,
      number: true,
      sampling: true,
      sampleRule: true,
      sampleQuantity: true,
      samplePercent: true,
      sampleMin: true,
      sampleMax: true,
      forProduced: true,
      forReceived: true,
      forReturned: true,
      points: {
        where: { organizationId: company },
        orderBy: { position: "asc" },
        select: {
          ...POINT_SELECT,
          options: {
            where: { organizationId: company },
            orderBy: { position: "asc" },
            select: { id: true, label: true, acceptable: true },
          },
        },
      },
    },
  });
  if (!row || !originsOf(row).includes(origin)) return null;
  const setting = await samplingSettingOf(tx, company);
  return {
    versionId: row.id,
    number: row.number,
    sampling: resolveSampling(
      { sampling: row.sampling, rule: ruleOf(row) },
      setting,
    ),
    points: row.points.map(pointOf),
  };
}

/** How the quality is checked when there is no plan for that origin. */
export async function samplingWithoutPlan(
  tx: Pick<Tx, "organizationSetting">,
  organizationId: string,
): Promise<Sampling> {
  return resolveSampling(null, await samplingSettingOf(tx, organizationId));
}
