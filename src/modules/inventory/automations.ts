import "server-only";

import type {
  ActionOutcome,
  AutomationAction,
  AutomationSubject,
  AutomationTrigger,
} from "@/platform/automations";
import { isLimited, locationScopeWhere } from "@/platform/locations";
import { forOrganization } from "@/server";

import { blockFreeOfLotAt, lotsWithFreeStock } from "./automation-block";
import { dayWindow } from "./calendar-day";
import { openCount } from "./counts";
import { INCIDENT_KIND_LABELS, type IncidentKind } from "./incident-states";
import { reportIncident } from "./incidents";
import { listExpiringLots } from "./lots";
import { listLowStock } from "./minimums";
import { formatStock } from "./movements";
import { STOCK_STATUS_LABELS, STOCK_STATUSES } from "./stock-status";
import {
  ADJUSTMENT_APPLIED_EVENT,
  STOCK_STATUS_CHANGED_EVENT,
} from "./webhooks";

/**
 * What Inventario offers to automations (WMS-64, ADR 0092): triggers of
 * facts it already publishes (`emitWebhookEvent`), states a round checks
 * with the same services of its screens, and three actions that call the
 * same services as the screens (an incident, a count, blocking a lot).
 * Registered in src/modules/registry/automations.ts.
 */

type Client = ReturnType<typeof forOrganization>;

const objectOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");

async function placeOf(client: Client, locationId: string) {
  return client.location.findFirst({
    where: { id: locationId.slice(0, 36) },
    select: { id: true, name: true, code: true, facilityId: true },
  });
}

async function productOf(client: Client, productId: string) {
  return client.product.findFirst({
    where: { id: productId.slice(0, 36) },
    select: { id: true, name: true, unitCode: true, categoryId: true },
  });
}

/** Rows a round reads per page of tasks or orders. */
const SCAN_PAGE = 50;

const placeName = (place: { code: string | null; name: string }) =>
  place.code ?? place.name;

const CATEGORY_CONDITION = {
  key: "categoryId",
  label: "De la categoría",
  kind: "choice",
  source: "categories",
  optional: true,
  match: "equals",
} as const;

// ── Facts ────────────────────────────────────────────────────────────────

export const STATUS_CHANGED_TRIGGER: AutomationTrigger = {
  key: STOCK_STATUS_CHANGED_EVENT.key,
  module: "inventory",
  label: "Cuando existencias cambian de estado",
  description:
    "Al pasar existencias de un estado a otro, a mano o al decidir una devolución de cliente.",
  readPermission: "inventory.stock.read",
  kind: "event",
  conditions: [
    {
      key: "toStatus",
      label: "Pasan a",
      kind: "multi",
      options: STOCK_STATUSES.filter(
        (status) => status !== "IN_TRANSIT" && status !== "RECEIVING",
      ).map((status) => ({
        value: status,
        label: STOCK_STATUS_LABELS[status],
      })),
      optional: true,
      match: "includes",
    },
    CATEGORY_CONDITION,
  ],
  provides: ["productId", "locationId", "lotId"],
  async describe(organizationId, data) {
    const fact = objectOf(data);
    const client = forOrganization(organizationId);
    const [product, place] = await Promise.all([
      productOf(client, text(fact.productId)),
      placeOf(client, text(fact.toLocationId)),
    ]);
    if (!product || !place) return null;
    const to = text(fact.toStatus) as keyof typeof STOCK_STATUS_LABELS;
    const from = text(fact.fromStatus) as keyof typeof STOCK_STATUS_LABELS;
    return {
      key: `movement:${text(fact.movementId)}`,
      summary: `${product.name}: ${formatStock(text(fact.quantity) || "0", product.unitCode)} pasaron de ${STOCK_STATUS_LABELS[from] ?? from} a ${STOCK_STATUS_LABELS[to] ?? to} en ${placeName(place)}.`,
      facilityId: place.facilityId,
      locationIds: [place.id],
      href: `/inventario/${product.id}`,
      refs: {
        productId: product.id,
        locationId: place.id,
        lotId: text(fact.lotId) || null,
      },
      facts: { toStatus: to, categoryId: product.categoryId },
    };
  },
};

export const ADJUSTMENT_TRIGGER: AutomationTrigger = {
  key: ADJUSTMENT_APPLIED_EVENT.key,
  module: "inventory",
  label: "Cuando se corrigen existencias",
  description:
    "Al corregir existencias a mano, con autorización o al aplicar un conteo.",
  readPermission: "inventory.movement.read",
  kind: "event",
  conditions: [
    {
      key: "difference",
      label: "La diferencia es de al menos",
      kind: "number",
      min: "0.000001",
      max: "999999999",
      unit: "unidades del producto",
      optional: true,
      match: "atLeastAbs",
    },
    CATEGORY_CONDITION,
  ],
  provides: ["productId", "locationId", "lotId"],
  async describe(organizationId, data) {
    const fact = objectOf(data);
    const line = objectOf(Array.isArray(fact.lines) ? fact.lines[0] : null);
    const client = forOrganization(organizationId);
    const [product, place] = await Promise.all([
      productOf(client, text(line.productId)),
      placeOf(client, text(fact.locationId)),
    ]);
    if (!product || !place) return null;
    const difference = text(line.difference) || "0";
    const amount = formatStock(difference.replace(/^-/, ""), product.unitCode);
    return {
      key: `movement:${text(fact.movementId)}`,
      summary: `${product.name}: se corrigió en ${placeName(place)}, ${difference.startsWith("-") ? "bajó" : "subió"} ${amount}.`,
      facilityId: place.facilityId,
      locationIds: [place.id],
      href: `/inventario/${product.id}`,
      refs: {
        productId: product.id,
        locationId: place.id,
        lotId: text(line.lotId) || null,
      },
      facts: { difference, categoryId: product.categoryId },
    };
  },
};

// ── States ───────────────────────────────────────────────────────────────

export const LOW_STOCK_TRIGGER: AutomationTrigger = {
  key: "inventory.stock.low",
  module: "inventory",
  label: "Cuando un producto queda en o bajo su mínimo",
  description:
    "Se revisa cada hora con las existencias de toda la empresa; avisa una vez al día por producto.",
  readPermission: "inventory.minimum.read",
  kind: "state",
  wholeCompanyOnly: true,
  repeat: "day",
  conditions: [
    {
      key: "empty",
      label: "Solo si ya no queda nada",
      kind: "flag",
      match: "flag",
    },
    CATEGORY_CONDITION,
  ],
  provides: ["productId"],
  async scan(actor, { page: wanted }) {
    const page = await listLowStock(actor, { page: wanted });
    // A page past the last one answers the last again: nothing more.
    if (page.limited || page.page !== wanted) {
      return { subjects: [], more: false };
    }
    const items = page.items;
    const categories = new Map(
      (
        await forOrganization(actor.organizationId).product.findMany({
          where: { id: { in: items.map((item) => item.productId) } },
          select: { id: true, categoryId: true },
        })
      ).map((row) => [row.id, row.categoryId]),
    );
    const subjects = items.map((item): AutomationSubject => ({
      key: `product:${item.productId}`,
      summary: `${item.name}: hay ${item.stockLabel} y su mínimo es ${item.minimumLabel}.`,
      facilityId: null,
      locationIds: [],
      href: `/inventario/${item.productId}`,
      refs: { productId: item.productId },
      facts: {
        empty: item.empty,
        categoryId: categories.get(item.productId) ?? null,
      },
    }));
    return { subjects, more: page.page < page.pageCount };
  },
};

export const LOT_EXPIRING_TRIGGER: AutomationTrigger = {
  key: "inventory.lot.expiring",
  module: "inventory",
  label: "Cuando un lote está por caducar",
  description:
    "Se revisa cada hora con el aviso de caducidad de la empresa: avisos, incidencias y conteos una vez por lote y almacén; bloquear, mientras le quede algo libre.",
  readPermission: "inventory.stock.read",
  kind: "state",
  repeat: "once",
  conditions: [
    {
      key: "expired",
      label: "Solo si ya caducó",
      kind: "flag",
      match: "flag",
    },
  ],
  provides: ["productId", "lotId"],
  async scan(actor, { facilityId, page: wanted, onlyWith }) {
    if (!facilityId) return { subjects: [], more: false };
    // A rule that only blocks reads only lots with something available
    // there: what is already blocked stops taking room in the pages.
    const page = await listExpiringLots(actor, {
      facilityId,
      page: wanted,
      availableOnly: onlyWith === "free",
    });
    if (page.page !== wanted) return { subjects: [], more: false };
    // What of each lot is free to take here (the same rule blocking
    // uses), read at once for the page and inside the scope of the person.
    const client = forOrganization(actor.organizationId);
    const scoped = await locationScopeWhere(client, actor.userId);
    const free = await lotsWithFreeStock(
      client,
      page.items.map((lot) => ({ productId: lot.productId, lotId: lot.lotId })),
      { facilityId, ...(isLimited(scoped) ? { AND: [scoped] } : {}) },
    );
    const subjects = page.items
      .filter((lot) => onlyWith !== "free" || free.has(lot.lotId))
      .map((lot): AutomationSubject => ({
        key: `lot:${lot.lotId}:${facilityId}`,
        summary: `${lot.productName}, lote ${lot.code}: ${lot.expiryText} (${lot.quantityLabel} en ${page.facilityName}).`,
        facilityId,
        locationIds: [],
        href: `/inventario/lotes/${lot.lotId}`,
        refs: { productId: lot.productId, lotId: lot.lotId },
        facts: { expired: lot.expired, free: free.has(lot.lotId) },
      }));
    return { subjects, more: page.page < page.pageCount };
  },
};

const TASK_KINDS = [
  { value: "TRANSFER", label: "Traslado" },
  { value: "PICK", label: "Surtido" },
  { value: "PUTAWAY", label: "Acomodo" },
  { value: "REPLENISH", label: "Reposición" },
  { value: "ISSUE", label: "Surtir a producción" },
] as const;

export const TASK_UNCLAIMED_TRIGGER: AutomationTrigger = {
  key: "inventory.task.unclaimed",
  module: "inventory",
  label: "Cuando una tarea sigue sin tomar",
  description:
    "Se revisa cada hora: tareas sin asignar ni aceptar desde hace las horas que elijas; una vez por tarea.",
  readPermission: "inventory.task.read",
  kind: "state",
  repeat: "once",
  conditions: [
    {
      key: "hours",
      label: "Desde hace",
      kind: "choice",
      options: [
        { value: "2", label: "2 horas" },
        { value: "4", label: "4 horas" },
        { value: "8", label: "8 horas" },
        { value: "24", label: "24 horas" },
      ],
      defaultValue: "4",
      match: "scan",
    },
    {
      key: "kind",
      label: "Tipo de tarea",
      kind: "multi",
      options: TASK_KINDS,
      optional: true,
      match: "includes",
    },
  ],
  provides: ["taskId", "locationId", "productId"],
  async scan(actor, { facilityId, values, page }) {
    if (!facilityId) return { subjects: [], more: false };
    const hours = Number(values.hours) || 4;
    const client = forOrganization(actor.organizationId);
    const scoped = await locationScopeWhere(client, actor.userId);
    const tasks = await client.warehouseTask.findMany({
      where: {
        status: "PENDING",
        createdAt: { lte: new Date(Date.now() - hours * 3_600_000) },
        fromLocation: {
          facilityId,
          ...(isLimited(scoped) ? { AND: [scoped] } : {}),
        },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      skip: (page - 1) * SCAN_PAGE,
      take: SCAN_PAGE + 1,
      select: {
        id: true,
        number: true,
        kind: true,
        productId: true,
        fromLocationId: true,
        toLocationId: true,
        fromLocation: { select: { code: true, name: true } },
      },
    });
    const subjects = tasks
      .slice(0, SCAN_PAGE)
      .map((task): AutomationSubject => ({
        key: `task:${task.id}`,
        summary: `La tarea T-${String(task.number).padStart(4, "0")} (${TASK_KINDS.find((k) => k.value === task.kind)?.label ?? "tarea"} desde ${placeName(task.fromLocation)}) sigue sin tomar desde hace más de ${hours} horas.`,
        facilityId,
        locationIds: [task.fromLocationId, task.toLocationId],
        href: `/tareas/${task.id}`,
        refs: {
          taskId: task.id,
          locationId: task.fromLocationId,
          productId: task.productId,
        },
        facts: { kind: task.kind },
      }));
    return { subjects, more: tasks.length > SCAN_PAGE };
  },
};

export const OUTBOUND_LATE_TRIGGER: AutomationTrigger = {
  key: "inventory.outbound.late",
  module: "inventory",
  label: "Cuando un pedido no salió en su día",
  description:
    "Se revisa cada hora: pedidos liberados cuyo día de salida ya pasó y no han salido; una vez por pedido.",
  readPermission: "inventory.outbound.read",
  kind: "state",
  repeat: "once",
  conditions: [],
  provides: ["outboundOrderId"],
  async scan(actor, { facilityId, page }) {
    if (!facilityId) return { subjects: [], more: false };
    const client = forOrganization(actor.organizationId);
    const today = await dayWindow(client, new Date());
    if (!today) return { subjects: [], more: false };
    const orders = await client.outboundOrder.findMany({
      where: {
        facilityId,
        status: {
          in: ["RELEASED", "PICKING", "PICKED", "PACKING", "PACKED"],
        },
        dueOn: { lt: new Date(`${today.day}T00:00:00Z`) },
      },
      orderBy: [{ dueOn: "asc" }, { id: "asc" }],
      skip: (page - 1) * SCAN_PAGE,
      take: SCAN_PAGE + 1,
      select: { id: true, number: true, recipient: true, dueOn: true },
    });
    const subjects = orders
      .slice(0, SCAN_PAGE)
      .map((order): AutomationSubject => ({
        key: `order:${order.id}`,
        summary: `El pedido PS-${String(order.number).padStart(4, "0")} para ${order.recipient} debía salir el ${order.dueOn!.toISOString().slice(0, 10).split("-").reverse().join("/")} y no ha salido.`,
        facilityId,
        locationIds: [],
        href: `/pedidos/${order.id}`,
        refs: { outboundOrderId: order.id },
        facts: {},
      }));
    return { subjects, more: orders.length > SCAN_PAGE };
  },
};

// ── Actions ──────────────────────────────────────────────────────────────

const INCIDENT_OPTIONS = (
  ["DAMAGED_GOODS", "MISPLACED", "UNSAFE_LOCATION", "OTHER"] as IncidentKind[]
).map((kind) => ({ value: kind, label: INCIDENT_KIND_LABELS[kind] }));

/** The first message of a refusal of a service. */
function refusalOf(result: {
  formError?: string;
  error?: string;
  fieldErrors?: Record<string, string | undefined>;
}): string {
  return (
    result.formError ??
    result.error ??
    Object.values(result.fieldErrors ?? {}).find(Boolean) ??
    "El servicio no lo aceptó."
  );
}

export const OPEN_INCIDENT_ACTION: AutomationAction = {
  key: "inventory.incident.open",
  module: "inventory",
  label: "Abrir una incidencia",
  description:
    "Una incidencia en el almacén del hecho, ligada a su producto, ubicación, tarea o pedido, para que alguien la tome.",
  permissions: ["inventory.incident.create"],
  options: [
    {
      key: "kind",
      label: "Tipo de incidencia",
      kind: "choice",
      options: INCIDENT_OPTIONS,
      defaultValue: "OTHER",
    },
    { key: "note", label: "Nota", kind: "text", optional: true },
  ],
  async run(context): Promise<ActionOutcome> {
    const { subject, options, rule } = context;
    if (!subject.facilityId) {
      return {
        kind: "refused",
        line: "No se hizo: una incidencia necesita un almacén y esto es de toda la empresa.",
      };
    }
    const client = forOrganization(context.organizationId);
    const [place, product] = await Promise.all([
      subject.refs.locationId ? placeOf(client, subject.refs.locationId) : null,
      subject.refs.productId
        ? client.product.findFirst({
            where: { id: subject.refs.productId },
            select: { sku: true },
          })
        : null,
    ]);
    const note = typeof options.note === "string" ? options.note : "";
    const result = await reportIncident(
      { organizationId: context.organizationId, userId: context.actorUserId },
      {
        kind: String(options.kind ?? "OTHER"),
        description:
          `Automatización «${rule.name}»: ${subject.summary}${note ? `\n${note}` : ""}`.slice(
            0,
            1000,
          ),
        location:
          place && place.facilityId === subject.facilityId
            ? placeName(place)
            : null,
        product: product?.sku ?? null,
        taskId: subject.refs.taskId ?? null,
        orderId: subject.refs.outboundOrderId ?? null,
        idempotencyKey: context.idempotencyKey,
      },
    );
    if (!result.ok) return { kind: "refused", line: refusalOf(result) };
    return {
      kind: "done",
      line: `Se abrió la incidencia: ${result.summary}`,
      href: `/incidencias/${result.incidentId}`,
    };
  },
};

export const OPEN_COUNT_ACTION: AutomationAction = {
  key: "inventory.count.open",
  module: "inventory",
  label: "Abrir un conteo de la ubicación",
  description:
    "Un conteo de la ubicación del hecho. Si ya tiene uno abierto, no se abre otro.",
  permissions: ["inventory.count.create"],
  options: [],
  needs: ["locationId"],
  async run(context): Promise<ActionOutcome> {
    // Never the transit of a transfer nor «Preparación» (the system's).
    const place = await forOrganization(
      context.organizationId,
    ).location.findFirst({
      where: { id: context.subject.refs.locationId! },
      select: { isTransit: true, isStaging: true, archivedAt: true },
    });
    if (!place || place.isTransit || place.isStaging || place.archivedAt) {
      return {
        kind: "already",
        line: "No se hizo: esa ubicación no se cuenta (tránsito, preparación o archivada).",
      };
    }
    const result = await openCount(
      { organizationId: context.organizationId, userId: context.actorUserId },
      {
        locationId: context.subject.refs.locationId!,
        note: `Automatización «${context.rule.name}»`.slice(0, 200),
      },
    );
    if (result.ok) {
      return {
        kind: "done",
        line: "Se abrió un conteo de la ubicación.",
        href: `/conteos/${result.countId}`,
      };
    }
    // Already being counted (by hand or by a cycle count program): fine.
    if (result.openCountId) {
      return {
        kind: "already",
        line: "No se hizo: la ubicación ya tenía un conteo abierto.",
        href: `/conteos/${result.openCountId}`,
      };
    }
    return { kind: "refused", line: `No se hizo: ${result.error}` };
  },
};

/**
 * «Bloquear» (coordination, 2026-11-20; second review): only a lot about
 * to expire or expired; what is free of each location of the warehouse
 * passes from Disponible to Bloqueado, never what is reserved for an
 * order, a task or a production order, nor what is inside a pallet. It
 * decides with `blockFreeOfLotAt` under the locks of a change of state, so
 * nothing «moves meanwhile». Nothing free is not a failure. It repeats
 * while the lot is about to expire and has something free.
 */
export const BLOCK_LOT_ACTION: AutomationAction = {
  key: "inventory.stock.block",
  module: "inventory",
  label: "Bloquear el lote",
  description:
    "Pasa a «Bloqueado» lo libre del lote en el almacén; lo apartado para un pedido o una tarea no se toca. Se repite mientras el lote siga por caducar y le quede algo libre. Se libera a mano con «Cambiar estado».",
  permissions: ["inventory.status.change", "inventory.stock.read"],
  options: [],
  needs: ["productId", "lotId"],
  onlyTriggers: ["inventory.lot.expiring"],
  repeats: { fact: "free" },
  async run(context): Promise<ActionOutcome> {
    const { subject } = context;
    if (!subject.facilityId) {
      return { kind: "refused", line: "No se hizo: falta el almacén." };
    }
    const actor = {
      organizationId: context.organizationId,
      userId: context.actorUserId,
    };
    const client = forOrganization(context.organizationId);
    const scoped = await locationScopeWhere(client, context.actorUserId);
    // What an earlier try of this same run already blocked (the job may
    // have failed after confirming some locations): it is said again, and
    // it is never «nothing to do».
    const earlier = await client.stockMovement.findMany({
      where: {
        type: "STATUS_CHANGE",
        idempotencyKey: { startsWith: `${context.idempotencyKey}-` },
      },
      orderBy: { id: "asc" },
      take: BLOCK_LOCATIONS_MAX,
      select: {
        lines: {
          where: { direction: "OUT" },
          take: 1,
          select: {
            locationId: true,
            baseQuantity: true,
            unitCode: true,
            location: { select: { code: true, name: true } },
          },
        },
      },
    });
    const blocked: string[] = [];
    const done = new Set<string>();
    for (const movement of earlier) {
      const line = movement.lines[0];
      if (!line || done.has(line.locationId)) continue;
      done.add(line.locationId);
      blocked.push(
        `${formatStock(line.baseQuantity.toString(), line.unitCode)} en ${placeName(line.location)}`,
      );
    }
    const refused: string[] = [];
    let after: string | null = null;
    let seen = 0;
    let more = false;
    for (;;) {
      // Every location of the lot in the warehouse with something
      // available, a page at a time; what is free is decided under locks.
      const balances: {
        locationId: string;
        location: { code: string | null; name: string };
      }[] = await client.stockBalance.findMany({
        where: {
          productId: subject.refs.productId!,
          lotId: subject.refs.lotId!,
          status: "AVAILABLE",
          quantity: { gt: 0 },
          ...(after ? { locationId: { gt: after } } : {}),
          location: {
            facilityId: subject.facilityId,
            ...(isLimited(scoped) ? { AND: [scoped] } : {}),
          },
        },
        orderBy: { locationId: "asc" },
        take: BLOCK_PAGE,
        select: {
          locationId: true,
          location: { select: { code: true, name: true } },
        },
      });
      for (const balance of balances) {
        // Its key already answered in an earlier try (said above).
        if (done.has(balance.locationId)) continue;
        const answer = await blockFreeOfLotAt(actor, {
          productId: subject.refs.productId!,
          locationId: balance.locationId,
          lotId: subject.refs.lotId!,
          reason: `Automatización: ${context.rule.name}`.slice(0, 200),
          idempotencyKey: `${context.idempotencyKey}-${balance.locationId.replace(/-/g, "").slice(-12)}`,
        });
        if (answer.kind === "blocked") {
          blocked.push(`${answer.label} en ${placeName(balance.location)}`);
        } else if (answer.kind === "refused") {
          refused.push(`${placeName(balance.location)}: ${answer.message}`);
        }
      }
      seen += balances.length;
      if (balances.length < BLOCK_PAGE) break;
      if (seen >= BLOCK_LOCATIONS_MAX) {
        more = true;
        break;
      }
      after = balances.at(-1)!.locationId;
    }
    const said = blocked.length > 0 ? `Se bloqueó ${blocked.join(", ")}.` : "";
    if (refused.length > 0) {
      // The real cause, from the change of state itself.
      return {
        kind: "refused",
        line: `${said} No se pudo bloquear en ${refused.join("; ")}`
          .trim()
          .slice(0, 200),
      };
    }
    if (blocked.length === 0) {
      return {
        kind: "already",
        line: "No se hizo: no había nada libre de ese lote (todo apartado o ya bloqueado).",
      };
    }
    return {
      kind: "done",
      line: (more
        ? `${said} Hay más ubicaciones: la siguiente revisión sigue con ellas.`
        : said
      ).slice(0, 200),
      href: `/inventario/lotes/${subject.refs.lotId}`,
    };
  },
};

/** Locations of a lot read per page when blocking it… */
const BLOCK_PAGE = 50;
/** …and at most this many in one run (the rest, in the next round). */
const BLOCK_LOCATIONS_MAX = 500;

export const INVENTORY_AUTOMATION_TRIGGERS: readonly AutomationTrigger[] = [
  STATUS_CHANGED_TRIGGER,
  ADJUSTMENT_TRIGGER,
  LOW_STOCK_TRIGGER,
  LOT_EXPIRING_TRIGGER,
  TASK_UNCLAIMED_TRIGGER,
  OUTBOUND_LATE_TRIGGER,
];

export const INVENTORY_AUTOMATION_ACTIONS: readonly AutomationAction[] = [
  OPEN_INCIDENT_ACTION,
  OPEN_COUNT_ACTION,
  BLOCK_LOT_ACTION,
];
