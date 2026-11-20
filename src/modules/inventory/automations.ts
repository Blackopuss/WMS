import "server-only";

import type {
  ActionOutcome,
  AutomationAction,
  AutomationSubject,
  AutomationTrigger,
} from "@/platform/automations";
import { isLimited, locationScopeWhere } from "@/platform/locations";
import { forOrganization } from "@/server";

import { dayWindow } from "./calendar-day";
import { openCount } from "./counts";
import { INCIDENT_KIND_LABELS, type IncidentKind } from "./incident-states";
import { reportIncident } from "./incidents";
import { listExpiringLots } from "./lots";
import { listLowStock } from "./minimums";
import { formatStock } from "./movements";
import { freeToTake } from "./reservations";
import { changeStockStatus } from "./status-change";
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
  async scan(actor, { limit }) {
    const page = await listLowStock(actor, { page: 1 });
    if (page.limited) return [];
    const items = page.items.slice(0, limit);
    const categories = new Map(
      (
        await forOrganization(actor.organizationId).product.findMany({
          where: { id: { in: items.map((item) => item.productId) } },
          select: { id: true, categoryId: true },
        })
      ).map((row) => [row.id, row.categoryId]),
    );
    return items.map((item): AutomationSubject => ({
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
  },
};

export const LOT_EXPIRING_TRIGGER: AutomationTrigger = {
  key: "inventory.lot.expiring",
  module: "inventory",
  label: "Cuando un lote está por caducar",
  description:
    "Se revisa cada hora con el aviso de caducidad de la empresa; una vez por lote y almacén.",
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
  async scan(actor, { facilityId, limit }) {
    if (!facilityId) return [];
    const page = await listExpiringLots(actor, { facilityId });
    return page.items.slice(0, limit).map((lot): AutomationSubject => ({
      key: `lot:${lot.lotId}:${facilityId}`,
      summary: `${lot.productName}, lote ${lot.code}: ${lot.expiryText} (${lot.quantityLabel} en ${page.facilityName}).`,
      facilityId,
      locationIds: [],
      href: `/inventario/lotes/${lot.lotId}`,
      refs: { productId: lot.productId, lotId: lot.lotId },
      facts: { expired: lot.expired },
    }));
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
  async scan(actor, { facilityId, values, limit }) {
    if (!facilityId) return [];
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
      take: limit,
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
    return tasks.map((task): AutomationSubject => ({
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
  async scan(actor, { facilityId, limit }) {
    if (!facilityId) return [];
    const client = forOrganization(actor.organizationId);
    const today = await dayWindow(client, new Date());
    if (!today) return [];
    const orders = await client.outboundOrder.findMany({
      where: {
        facilityId,
        status: {
          in: ["RELEASED", "PICKING", "PICKED", "PACKING", "PACKED"],
        },
        dueOn: { lt: new Date(`${today.day}T00:00:00Z`) },
      },
      orderBy: [{ dueOn: "asc" }, { id: "asc" }],
      take: limit,
      select: { id: true, number: true, recipient: true, dueOn: true },
    });
    return orders.map((order): AutomationSubject => ({
      key: `order:${order.id}`,
      summary: `El pedido PS-${String(order.number).padStart(4, "0")} para ${order.recipient} debía salir el ${order.dueOn!.toISOString().slice(0, 10).split("-").reverse().join("/")} y no ha salido.`,
      facilityId,
      locationIds: [],
      href: `/pedidos/${order.id}`,
      refs: { outboundOrderId: order.id },
      facts: {},
    }));
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
 * «Bloquear» (coordination, 2026-11-20): only a lot about to expire or
 * expired; what is free of each location of the warehouse passes from
 * Disponible to Bloqueado with «Cambiar estado», never what is reserved
 * for an order, a task or inside a pallet. Nothing free is not a failure.
 */
export const BLOCK_LOT_ACTION: AutomationAction = {
  key: "inventory.stock.block",
  module: "inventory",
  label: "Bloquear el lote",
  description:
    "Pasa a «Bloqueado» lo libre del lote en el almacén; lo apartado para un pedido o una tarea no se toca. Se libera a mano con «Cambiar estado».",
  permissions: ["inventory.status.change", "inventory.stock.read"],
  options: [],
  needs: ["productId", "lotId"],
  onlyTriggers: ["inventory.lot.expiring"],
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
    const product = await client.product.findFirst({
      where: { id: subject.refs.productId! },
      select: { tracking: true, unitCode: true },
    });
    if (!product || product.tracking !== "LOT") {
      return {
        kind: "already",
        line: "No se hizo: solo se bloquean productos controlados por lote.",
      };
    }
    const scoped = await locationScopeWhere(client, context.actorUserId);
    const balances = await client.stockBalance.findMany({
      where: {
        productId: subject.refs.productId!,
        lotId: subject.refs.lotId!,
        status: "AVAILABLE",
        quantity: { gt: 0 },
        location: {
          facilityId: subject.facilityId,
          ...(isLimited(scoped) ? { AND: [scoped] } : {}),
        },
      },
      orderBy: { locationId: "asc" },
      take: 20,
      select: {
        locationId: true,
        location: { select: { code: true, name: true } },
      },
    });
    const blocked: string[] = [];
    for (const balance of balances) {
      const free = await freeToTake(
        client,
        subject.refs.productId!,
        balance.locationId,
        subject.refs.lotId!,
      );
      if (!free.greaterThan(0)) continue;
      const result = await changeStockStatus(actor, {
        productId: subject.refs.productId!,
        locationId: balance.locationId,
        lotId: subject.refs.lotId!,
        from: "AVAILABLE",
        to: "BLOCKED",
        quantity: free.toString(),
        reason: `Automatización: ${context.rule.name}`.slice(0, 200),
        // One per location, whatever order a retry reads them in.
        idempotencyKey: `${context.idempotencyKey}-${balance.locationId.replace(/-/g, "").slice(-12)}`,
      });
      // Taken meanwhile (an order reserved it first): left as it is.
      if (!result.ok || !("movementId" in result)) continue;
      blocked.push(
        `${formatStock(result.baseQuantity ?? free.toString(), product.unitCode)} en ${placeName(balance.location)}`,
      );
    }
    if (blocked.length === 0) {
      return {
        kind: "already",
        line: "No se hizo: no había existencias libres de ese lote.",
      };
    }
    return {
      kind: "done",
      line: `Se bloqueó ${blocked.join(", ")}.`.slice(0, 200),
      href: `/inventario/lotes/${subject.refs.lotId}`,
    };
  },
};

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
