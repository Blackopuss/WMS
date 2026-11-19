import "server-only";

import { z } from "zod";

import { dec, isAppError, newId } from "@/lib";
import {
  KEY_REUSED,
  consumeReservation,
  formatStock,
  planMaterialTakes,
  postDisposal,
} from "@/modules/inventory";
import {
  ApprovalExpired,
  approvalRequired,
  findApprovalByKey,
  openApprovalRequest,
  type ApprovalContext,
  type ApprovalTx,
} from "@/platform/approvals";
import { recordAuditEvent } from "@/platform/audit";
import { companyModules, permissionsOf } from "@/platform/authorization";
import { assertModulePermission } from "@/platform/billing";
import { parseQuantity } from "@/platform/catalog";
import { readModuleStates } from "@/platform/entitlements";
import { isLimited, locationScopeWhere } from "@/platform/locations";
import { readSetting } from "@/platform/settings";
import {
  LOCKING_TRANSACTION,
  forOrganization,
  lockRows,
  type TenantDb,
} from "@/server";

import { SCRAP_APPROVAL } from "./approval-keys";
import { formatProductionNumber } from "./order-states";
import { idOf, insideArea, lockProductionOrder } from "./orders";
import type { ProductionActor } from "./recipes";
import { MATERIALS_MODE } from "./settings";

/**
 * «Reportar merma de material» (WMS-29, ADR 0087): material of a production
 * order lost beyond the recipe (a sheet that broke when cutting). A
 * DISPOSAL linked to the order, out of what is set aside for it first and
 * then free, never part of the cost of what is made. With the company's
 * rule `production.scrap` on, it waits for an authorization (nothing
 * written, nothing held) and is done again, whole, when authorized.
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,64}$/;

const schema = z.object({
  orderLineId: z.string().trim().min(1, "Elige el material.").max(36),
  quantity: z.string().trim().min(1, "Escribe cuánto se perdió.").max(20),
  reason: z
    .string()
    .trim()
    .min(3, "Escribe qué pasó.")
    .max(500, "Usa como máximo 500 caracteres."),
  serials: z.union([z.string().max(20000), z.array(z.string()).max(5000)]).optional(),
  idempotencyKey: z.string().trim(),
});

export type ScrapInput = z.input<typeof schema>;
type ScrapData = z.output<typeof schema>;
export type ScrapField = "orderLineId" | "quantity" | "reason" | "serials";

export type ScrapResult =
  | { ok: true; summary: string; repeated?: true }
  | {
      ok: false;
      reason: "pending_approval";
      requestId: string;
      formError: string;
      repeated?: true;
    }
  | {
      ok: false;
      reason: "invalid" | "not_found" | "not_allowed";
      fieldErrors?: Partial<Record<ScrapField, string>>;
      formError?: string;
    };

type Mode =
  | { kind: "direct" }
  | {
      kind: "approved";
      requestId: string;
      authorizedByName: string | null;
    };

class Rejected extends Error {
  constructor(readonly result: ScrapResult) {
    super("production scrap rejected");
  }
}

const refuse = (
  reason: "invalid" | "not_found" | "not_allowed",
  message: string,
  field?: ScrapField,
): never => {
  throw new Rejected(
    field
      ? { ok: false, reason, fieldErrors: { [field]: message } }
      : { ok: false, reason, formError: message },
  );
};

const isKeyClash = (error: unknown) =>
  (error as { code?: string }).code === "P2002" &&
  JSON.stringify((error as { meta?: unknown }).meta ?? "").includes(
    "idempotencyKey",
  );

/** «Reportar merma de material» of an order released or in progress. */
export async function reportMaterialScrap(
  actor: ProductionActor,
  orderId: string,
  input: ScrapInput,
): Promise<ScrapResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "production.scrap.create",
  );
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Partial<Record<ScrapField, string>> = {};
    let formError: string | undefined;
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (field === "idempotencyKey") formError ??= issue.message;
      else fieldErrors[field as ScrapField] ??= issue.message;
    }
    return { ok: false, reason: "invalid", fieldErrors, formError };
  }
  if (!IDEMPOTENCY_KEY.test(parsed.data.idempotencyKey)) {
    return {
      ok: false,
      reason: "invalid",
      formError:
        "No pudimos identificar esta confirmación. Recarga la página e inténtalo de nuevo.",
    };
  }
  try {
    return await forOrganization(organizationId).$transaction(
      (tx) => scrapIn(tx, actor, orderId, parsed.data, { kind: "direct" }),
      LOCKING_TRANSACTION,
    );
  } catch (error) {
    if (error instanceof Rejected) return error.result;
    if (isKeyClash(error)) {
      return { ok: false, reason: "not_allowed", formError: KEY_REUSED };
    }
    throw error;
  }
}

/** One open request per material line (ids without dashes). */
const scrapOpenKey = (lineId: string) => `ps:${lineId.replace(/-/g, "")}`;

async function scrapIn(
  tx: Tx,
  actor: ProductionActor,
  orderId: string,
  data: ScrapData,
  mode: Mode,
): Promise<ScrapResult> {
  const { organizationId, userId } = actor;
  const line = await tx.productionOrderLine.findFirst({
    where: { id: idOf(data.orderLineId), orderId: idOf(orderId) },
    select: { id: true, productId: true },
  });
  if (!line) return refuse("invalid", "Elige un material de esta orden.", "orderLineId");
  // Products → order (ADR 0087).
  await lockRows(tx, "product", [line.productId]);
  await lockProductionOrder(tx, orderId, userId).catch((error) => {
    if (error instanceof Error && error.message === "production order rejected") {
      refuse("not_found", "Esta orden de producción no existe.");
    }
    throw error;
  });
  const order = await tx.productionOrder.findFirst({
    where: { id: idOf(orderId) },
    select: {
      id: true,
      number: true,
      status: true,
      facilityId: true,
      areaLocationId: true,
    },
  });
  if (!order) return refuse("not_found", "Esta orden de producción no existe.");
  const material = await tx.productionOrderLine.findFirst({
    where: { id: line.id },
    select: {
      unitCode: true,
      product: {
        select: {
          id: true,
          name: true,
          unitCode: true,
          quantityStep: true,
          tracking: true,
          status: true,
        },
      },
    },
  });
  if (!material) return refuse("invalid", "Elige un material.", "orderLineId");

  // A repeated confirmation (INV-21).
  const replay = await tx.stockMovement.findFirst({
    where: { idempotencyKey: data.idempotencyKey },
    select: {
      type: true,
      createdByUserId: true,
      productionScrap: { select: { orderLineId: true, quantity: true } },
    },
  });
  if (replay) {
    if (mode.kind === "approved") {
      return refuse("not_allowed", "Esta merma ya se había registrado.");
    }
    let same = false;
    try {
      same =
        replay.type === "DISPOSAL" &&
        replay.createdByUserId === userId &&
        replay.productionScrap?.orderLineId === line.id &&
        dec(data.quantity).equals(replay.productionScrap.quantity.toString());
    } catch {
      same = false;
    }
    if (!same) return refuse("not_allowed", KEY_REUSED);
    return {
      ok: true,
      repeated: true,
      summary: "Esta merma ya estaba registrada. No se registró de nuevo.",
    };
  }
  if (mode.kind === "direct") {
    const asked = await findApprovalByKey(tx, data.idempotencyKey);
    if (asked) {
      const payload = scrapPayload.safeParse(asked.payload);
      if (
        asked.typeKey !== SCRAP_APPROVAL.key ||
        asked.requestedByUserId !== userId ||
        !payload.success ||
        payload.data.orderLineId !== line.id ||
        payload.data.quantity !== data.quantity
      ) {
        return refuse("not_allowed", KEY_REUSED);
      }
      if (asked.status !== "PENDING") {
        return refuse(
          "not_allowed",
          "Esa solicitud de merma ya se decidió. Recarga la página para reportar otra.",
        );
      }
      return {
        ok: false,
        reason: "pending_approval",
        requestId: asked.id,
        repeated: true,
        formError: `Esta merma ya se había pedido: ${asked.summary}`,
      };
    }
  }

  if (order.status !== "RELEASED" && order.status !== "IN_PROGRESS") {
    return refuse(
      "not_allowed",
      "Esta orden no está liberada ni en proceso: no se reporta merma.",
    );
  }
  const quantity = parseQuantity(
    {
      unitCode: material.product.unitCode,
      quantityStep: material.product.quantityStep.toString(),
    },
    data.quantity,
  );
  if (!quantity.ok) return refuse("invalid", quantity.error, "quantity");

  const mode_ = await readSetting(tx, MATERIALS_MODE);
  const area = await insideArea(tx, order.facilityId, order.areaLocationId);
  const scope = await locationScopeWhere(tx, userId);
  const plan = await planMaterialTakes(tx, {
    lineId: line.id,
    product: {
      id: material.product.id,
      name: material.product.name,
      unitCode: material.unitCode,
      tracking: material.product.tracking,
    },
    quantity: quantity.quantity,
    facilityId: order.facilityId,
    within: isLimited(scope) ? scope : null,
    onlyIn: mode_ === "issue" ? area : null,
    area,
    serials: data.serials,
  });
  if (!plan.ok) {
    if (plan.error) return refuse("invalid", plan.error, "serials");
    return refuse(
      "invalid",
      `Solo hay ${formatStock(plan.reachable.toString(), material.unitCode)} de ${material.product.name} a tu alcance para esta orden.`,
      "quantity",
    );
  }
  const numberText = formatProductionNumber(order.number);
  const text = `${formatStock(quantity.quantity.toString(), material.unitCode)} de ${material.product.name}`;

  if (
    mode.kind === "direct" &&
    (await approvalRequired(tx, SCRAP_APPROVAL.key))
  ) {
    const summary = `Merma de ${text} en ${numberText}. Motivo: ${data.reason}`;
    const asked = await openApprovalRequest(tx, SCRAP_APPROVAL, actor, {
      sourceType: "production_order",
      sourceId: order.id,
      openKey: scrapOpenKey(line.id),
      idempotencyKey: data.idempotencyKey,
      facilityId: order.facilityId,
      locationId: order.areaLocationId,
      summary,
      payload: {
        v: 1,
        orderId: order.id,
        orderLineId: line.id,
        quantity: data.quantity,
        serials: data.serials ?? null,
        reason: data.reason,
        idempotencyKey: data.idempotencyKey,
      },
    });
    if (!asked.ok) {
      return refuse(
        "not_allowed",
        `Ya hay una merma de ${material.product.name} en ${numberText} esperando autorización.`,
      );
    }
    return {
      ok: false,
      reason: "pending_approval",
      requestId: asked.requestId,
      formError: `Quedó pendiente de autorización: ${summary}`,
    };
  }

  // What was set aside for the order goes first; the rest was asked free
  // under the product's lock (postDisposal does not look at reservations).
  for (const take of plan.takes) {
    for (const reservation of take.reservations) {
      await consumeReservation(tx, reservation.id, reservation.quantity);
    }
  }
  const done = await postDisposal(tx, actor, {
    lines: plan.takes.map((take) => ({
      productId: take.productId,
      locationId: take.locationId,
      status: "AVAILABLE" as const,
      lotId: take.lotId,
      quantity: take.quantity,
      serials:
        take.units.length > 0 ? take.units.map((unit) => unit.serial) : undefined,
    })),
    reason: `Merma de producción (${numberText}): ${data.reason}`.slice(0, 500),
    reference: `${numberText} · merma`,
    idempotencyKey: data.idempotencyKey,
    allowedStatuses: ["AVAILABLE"],
    takesAvailable: true,
    authorizedBy:
      mode.kind === "approved"
        ? { name: mode.authorizedByName, requestId: mode.requestId }
        : null,
  });
  if (!done.ok) {
    return refuse(
      "invalid",
      done.error,
      done.field === "serials" ? "serials" : "quantity",
    );
  }
  await tx.productionScrap.create({
    data: {
      id: newId(),
      organizationId,
      orderId: order.id,
      orderLineId: line.id,
      movementId: done.movementId,
      productId: material.product.id,
      quantity: quantity.quantity.toString(),
      unitCode: material.unitCode,
      reason: data.reason,
      createdByUserId: userId,
    },
  });
  await recordAuditEvent(tx, {
    organizationId,
    actorUserId: userId,
    action: "production.scrap_reported",
    target: { type: "production_order", id: order.id },
    reason: data.reason,
    metadata: {
      orden: numberText,
      material: text,
      ...(mode.kind === "approved"
        ? {
            autorizadoPor: mode.authorizedByName ?? "otra persona",
            solicitud: mode.requestId,
          }
        : {}),
    },
  });
  return {
    ok: true,
    summary: `Se registró la merma: ${text}. No entra al costo de lo producido.`,
  };
}

const scrapPayload = z.object({
  v: z.literal(1),
  orderId: z.string().max(36),
  orderLineId: z.string().max(36),
  quantity: z.string().max(20),
  serials: z.union([z.string(), z.array(z.string()), z.null()]),
  reason: z.string().max(500),
  idempotencyKey: z.string().max(64),
});

const NO_LONGER = "Esta merma ya no se puede aplicar.";

/**
 * Applies an authorized scrap (ADR 0087), inside the transaction of the
 * decision: done again, whole, in the name of who asked; anything that no
 * longer holds makes the request expire.
 */
export async function applyApprovedScrap(
  tx: ApprovalTx,
  context: ApprovalContext,
): Promise<{ outcome: string }> {
  const stored = scrapPayload.safeParse(context.request.payload);
  const parsed = stored.success
    ? schema.safeParse({
        orderLineId: stored.data.orderLineId,
        quantity: stored.data.quantity,
        reason: stored.data.reason,
        serials: stored.data.serials ?? undefined,
        idempotencyKey: stored.data.idempotencyKey,
      })
    : null;
  if (!stored.success || !parsed?.success) throw new ApprovalExpired(NO_LONGER);
  const actor = {
    organizationId: context.organizationId,
    userId: context.request.requestedByUserId,
  };
  // NEG-20: who asked still works here and may report scrap.
  const member = await (tx as unknown as Tx).membership.findFirst({
    where: { userId: actor.userId, status: "ACTIVE" },
    select: {
      roles: { select: { role: true } },
      organization: { select: { ownerUserId: true } },
    },
  });
  if (!member) {
    throw new ApprovalExpired(
      "Quien pidió la merma ya no trabaja en la empresa: que la pida alguien que sí.",
    );
  }
  const subject = {
    isOwner: member.organization.ownerUserId === actor.userId,
    roles: member.roles.map((each) => each.role),
    modules: companyModules(
      await readModuleStates(tx as unknown as Tx, actor.organizationId),
    ),
  };
  if (!permissionsOf(subject).has("production.scrap.create")) {
    throw new ApprovalExpired(
      "Quien pidió la merma ya no puede reportarla: que la pida alguien que sí.",
    );
  }
  try {
    const result = await scrapIn(
      tx as unknown as Tx,
      actor,
      stored.data.orderId,
      parsed.data,
      {
        kind: "approved",
        requestId: context.request.id,
        authorizedByName: context.decidedByName,
      },
    );
    if (!result.ok) {
      throw new ApprovalExpired(
        ("formError" in result && result.formError) ||
          Object.values(
            ("fieldErrors" in result && result.fieldErrors) || {},
          )[0] ||
          NO_LONGER,
      );
    }
    return { outcome: result.summary };
  } catch (error) {
    if (error instanceof Rejected) {
      const result = error.result as {
        formError?: string;
        fieldErrors?: Record<string, string>;
      };
      throw new ApprovalExpired(
        result.formError ?? Object.values(result.fieldErrors ?? {})[0] ?? NO_LONGER,
      );
    }
    if (isAppError(error) && error.kind === "forbidden") {
      throw new ApprovalExpired(
        "Quien pidió la merma ya no alcanza esa área: que la pida alguien que sí.",
      );
    }
    throw error;
  }
}

/** Whether scrap waits for an authorization in this company (for the form). */
export async function scrapNeedsApproval(
  actor: ProductionActor,
): Promise<boolean> {
  return approvalRequired(
    forOrganization(actor.organizationId),
    SCRAP_APPROVAL.key,
  );
}

