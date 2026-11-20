import { DEFAULT_TIME_ZONE, newId } from "@/lib";
import * as inventory from "@/modules/inventory";
import * as production from "@/modules/production";
import * as purchasing from "@/modules/purchasing";
import * as quality from "@/modules/quality";
import {
  DEMO_PREPARE_JOB,
  claimDemoPreparation,
  finishDemoPreparation,
} from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import { createSupplier } from "@/platform/contacts";
import type { JobHandlers } from "@/platform/jobs";
import { createLocation } from "@/platform/locations";
import { forOrganization } from "@/server";

/**
 * Data sets of a demonstration company (WMS-44, ADR 0089). A data set
 * loads, as the company's titular, everything a person needs to see each
 * main screen with something in it. **Everything goes through the real
 * services** (locks, average cost, reservations, lots, serials, audit), so
 * stock and value reconcile; nothing is written straight to a table.
 *
 * Today there is one set, `generic`, of no line of business: neutral names
 * («Producto A», «Material 1», «Kit básico»). Another set is a new entry
 * here (WMS-45 decides whether there will be any).
 */

type Actor = { organizationId: string; userId: string };
export type DemoDataset = (actor: Actor) => Promise<void>;

/** A step of a data set that did not go through: stops the whole load. */
class DemoStepFailed extends Error {
  constructor(what: string, detail: unknown) {
    const reason =
      detail && typeof detail === "object"
        ? ((detail as { formError?: string; message?: string; error?: string })
            .formError ??
          (detail as { message?: string }).message ??
          (detail as { error?: string }).error ??
          JSON.stringify(detail).slice(0, 200))
        : String(detail);
    super(`${what}: ${reason}`);
    this.name = "DemoStepFailed";
  }
}

async function must<T extends { ok: boolean }>(
  what: string,
  result: Promise<T>,
): Promise<Extract<T, { ok: true }>> {
  const done = await result;
  if (!done.ok) throw new DemoStepFailed(what, done);
  return done as Extract<T, { ok: true }>;
}

/** A day of the company's calendar, `days` from today («AAAA-MM-DD»). */
async function dayFromToday(organizationId: string, days: number) {
  // The company's calendar, read through one of its memberships (business
  // code never reads the company row with the plain client).
  const membership = await forOrganization(organizationId).membership.findFirst(
    { select: { organization: { select: { timeZone: true } } } },
  );
  const timeZone = membership?.organization.timeZone ?? DEFAULT_TIME_ZONE;
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [year, month, day] = today.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
}

/** Picks every picking task of an outbound order, as the titular. */
async function pickOrder(actor: Actor, orderId: string) {
  const tasks = await forOrganization(
    actor.organizationId,
  ).warehouseTask.findMany({
    where: { kind: "PICK", status: "PENDING", outboundLine: { orderId } },
    orderBy: { number: "asc" },
    select: {
      id: true,
      quantity: true,
      product: { select: { sku: true } },
      fromLocation: { select: { code: true, name: true } },
    },
  });
  for (const task of tasks) {
    await must("tomar tarea de surtido", inventory.acceptTask(actor, task.id));
    await must(
      "confirmar surtido",
      inventory.confirmPick(actor, task.id, {
        productCode: task.product!.sku,
        locationCode: task.fromLocation.code ?? task.fromLocation.name,
        quantity: task.quantity!.toString(),
      }),
    );
    await must("dejar en preparación", inventory.deliverTask(actor, task.id));
  }
}

/** The generic data set: one warehouse with everything in use. */
const generic: DemoDataset = async (actor) => {
  const { organizationId } = actor;

  // ── Locations: two zones, and one place of each use. ──────────────────
  const places: Record<string, string> = {};
  const location = async (
    key: string,
    input: Parameters<typeof createLocation>[1],
    parent?: string,
  ) => {
    const made = await must(
      `ubicación ${input.name}`,
      createLocation(actor, {
        ...input,
        parentId: parent ? places[parent] : undefined,
      }),
    );
    places[key] = (made as unknown as { locationId: string }).locationId;
  };
  await location("A", { name: "Zona A", level: 1 });
  await location("A1", { name: "Pasillo 1", level: 2 }, "A");
  await location(
    "A-01-01",
    { name: "Estante 1", level: 3, code: "A-01-01" },
    "A1",
  );
  await location(
    "A-01-02",
    { name: "Estante 2", level: 3, code: "A-01-02" },
    "A1",
  );
  await location("A2", { name: "Pasillo 2", level: 2 }, "A");
  await location(
    "A-02-01",
    { name: "Estante 1", level: 3, code: "A-02-01" },
    "A2",
  );
  await location(
    "A-02-02",
    { name: "Estante 2", level: 3, code: "A-02-02", type: "PICKING" },
    "A2",
  );
  await location("B", { name: "Zona B", level: 1 });
  await location("B1", { name: "Pasillo 1", level: 2 }, "B");
  await location(
    "B-01-01",
    { name: "Estante 1", level: 3, code: "B-01-01" },
    "B1",
  );
  await location("REC", {
    name: "Recepción",
    level: 1,
    code: "REC-01",
    type: "RECEIVING",
  });
  await location("CUA", {
    name: "Cuarentena",
    level: 1,
    code: "CUA-01",
    type: "QUARANTINE",
  });
  await location("RES", {
    name: "Restauración",
    level: 1,
    code: "RES-01",
    type: "REPAIR",
  });
  await location("PROD", {
    name: "Línea de producción",
    level: 1,
    code: "PROD-01",
    type: "PRODUCTION",
  });

  // ── Products, with stock and minimums (some below). ───────────────────
  const products: Record<string, string> = {};
  const PRODUCTS = [
    ["PRD-A", "Producto A", "General", "A-01-01", 480, 100],
    ["PRD-B", "Producto B", "General", "A-01-01", 320, 100],
    ["PRD-C", "Producto C", "General", "A-01-02", 35, 80],
    ["CAJ-CH", "Caja chica", "Empaque", "A-01-02", 150, 40],
    ["CAJ-GR", "Caja grande", "Empaque", "A-01-02", 12, 40],
    ["MAT-1", "Material 1", "Materiales", "A-02-01", 200, 50],
    ["MAT-2", "Material 2", "Materiales", "A-02-01", 90, 30],
    ["MAT-3", "Material 3", "Materiales", "B-01-01", 0, 10],
  ] as const;
  for (const [sku, name, category, where, stock, minimum] of PRODUCTS) {
    const made = await must(
      `producto ${sku}`,
      createProduct(actor, { sku, name, category, unit: "piece" }),
    );
    products[sku] = made.productId;
    if (stock > 0) {
      await must(
        `saldo inicial ${sku}`,
        inventory.registerInitialBalance(actor, {
          productId: made.productId,
          quantity: String(stock),
          locationId: places[where],
        }),
      );
    }
    await must(
      `mínimo ${sku}`,
      inventory.setMinimum(actor, {
        productId: made.productId,
        quantity: String(minimum),
      }),
    );
  }

  // By lot, with expiry: one of its lots about to expire.
  const lotted = await must(
    "producto LOT-A",
    createProduct(actor, {
      sku: "LOT-A",
      name: "Producto por lote",
      category: "General",
      unit: "piece",
      tracking: "LOT",
      lotExpiry: "REQUIRED",
    }),
  );
  products["LOT-A"] = lotted.productId;
  for (const [code, days, where, quantity] of [
    ["L-001", 20, "A-02-01", "36"],
    ["L-002", 240, "B-01-01", "60"],
  ] as const) {
    await must(
      `lote ${code}`,
      inventory.registerInitialBalance(actor, {
        productId: lotted.productId,
        quantity,
        locationId: places[where],
        lotCode: code,
        lotExpiresOn: await dayFromToday(organizationId, days),
      }),
    );
  }

  // By serial number.
  const serial = await must(
    "producto SER-A",
    createProduct(actor, {
      sku: "SER-A",
      name: "Equipo con número de serie",
      category: "General",
      unit: "piece",
      tracking: "SERIAL",
    }),
  );
  products["SER-A"] = serial.productId;
  await must(
    "series SER-A",
    inventory.registerInitialBalance(actor, {
      productId: serial.productId,
      quantity: "3",
      locationId: places["B-01-01"],
      serials: ["SA-0001", "SA-0002", "SA-0003"].join("\n"),
    }),
  );

  // ── Some history: an entry and two exits. ──────────────────────────────
  await must(
    "entrada",
    inventory.registerEntry(actor, {
      productId: products["PRD-A"]!,
      quantity: "120",
      locationId: places["A-01-01"],
    }),
  );
  for (const [sku, where, quantity] of [
    ["MAT-1", "A-02-01", "10"],
    ["CAJ-CH", "A-01-02", "24"],
  ] as const) {
    await must(
      `salida ${sku}`,
      inventory.registerExit(actor, {
        productId: products[sku]!,
        quantity,
        locationId: places[where],
      }),
    );
  }

  // ── Stock that waits for a decision, and damaged stock. ───────────────
  for (const [to, toLocation, quantity, reason] of [
    ["INSPECTION", "CUA", "3", "Revisar antes de usar"],
    ["REPAIR", "RES", "3", "Reacondicionar el empaque"],
    ["DAMAGED", undefined, "2", "Empaque roto"],
  ] as const) {
    await must(
      `existencias ${to}`,
      inventory.changeStockStatus(actor, {
        productId: products["PRD-B"]!,
        locationId: places["A-01-01"]!,
        toLocationId: toLocation ? places[toLocation] : undefined,
        from: "AVAILABLE",
        to,
        quantity,
        reason,
        idempotencyKey: newId(),
      }),
    );
  }

  // ── Purchasing: two suppliers, an order on its way. ───────────────────
  // Reserved domain (RFC 6761): no mail ever reaches anyone, and a
  // demonstration does not send orders by mail anyway.
  const supplier = await must(
    "proveedor",
    createSupplier(actor, {
      name: "Proveedor Uno",
      contactPerson: "Persona de contacto",
      email: "proveedor.uno@example.test",
    }),
  );
  await must(
    "segundo proveedor",
    createSupplier(actor, {
      name: "Proveedor Dos",
      contactPerson: "Persona de contacto",
      email: "proveedor.dos@example.test",
    }),
  );
  const order = await must(
    "orden de compra",
    purchasing.createPurchaseOrder(actor, { supplierId: supplier.supplierId }),
  );
  const purchaseOrderId = (order as unknown as { orderId: string }).orderId;
  for (const [sku, quantity, unitCost] of [
    ["CAJ-GR", "60", "18.50"],
    ["PRD-C", "30", "42.00"],
    ["MAT-3", "20", "310.00"],
    ["LOT-A", "48", "35.00"],
  ] as const) {
    await must(
      `línea de compra ${sku}`,
      purchasing.addOrderLine(actor, purchaseOrderId, {
        productId: products[sku]!,
        capture: "base",
        quantity,
        unitCost,
      }),
    );
  }
  await must(
    "confirmar orden de compra",
    purchasing.submitPurchaseOrder(actor, purchaseOrderId),
  );

  // ── Outbound orders: one picked, one to pick, one draft. ──────────────
  const outbound = async (
    recipient: string,
    lines: readonly (readonly [string, string])[],
    extra: { priority?: "URGENT" } = {},
  ) => {
    const made = await must(
      `pedido ${recipient}`,
      inventory.createOutboundOrder(actor, { recipient, ...extra }),
    );
    const orderId = (made as unknown as { orderId: string }).orderId;
    for (const [sku, quantity] of lines) {
      await must(
        `línea de pedido ${sku}`,
        inventory.setOutboundLine(actor, orderId, {
          productId: products[sku]!,
          quantity,
        }),
      );
    }
    return orderId;
  };
  const picked = await outbound("Cliente Sur", [
    ["PRD-B", "20"],
    ["MAT-2", "5"],
  ]);
  await must("liberar pedido", inventory.releaseOutboundOrder(actor, picked));
  await pickOrder(actor, picked);
  const toPick = await outbound(
    "Cliente Norte",
    [
      ["PRD-A", "50"],
      ["CAJ-CH", "12"],
      ["LOT-A", "12"],
    ],
    { priority: "URGENT" },
  );
  await must("liberar pedido", inventory.releaseOutboundOrder(actor, toPick));
  await outbound("Cliente Centro", [["PRD-B", "40"]]);

  // ── A transfer task, an open count and an incident. ───────────────────
  await must(
    "tarea de traslado",
    inventory.createTask(actor, {
      productId: products["PRD-A"]!,
      fromLocationId: places["A-01-01"]!,
      toLocationId: places["A-02-01"]!,
      quantity: "10",
    }),
  );
  await must(
    "conteo",
    inventory.openCount(actor, { locationId: places["A-01-02"]! }),
  );
  await must(
    "incidencia",
    inventory.reportIncident(actor, {
      kind: "MISPLACED",
      description: "Una caja no está en el estante que dice el sistema.",
      location: "A-02-01",
      idempotencyKey: newId(),
    }),
  );

  // ── Production and Quality: a kit, its recipe, an order and a plan. ───
  const kit = await must(
    "producto KIT-B",
    createProduct(actor, {
      sku: "KIT-B",
      name: "Kit básico",
      category: "General",
      unit: "piece",
    }),
  );
  await must(
    "mínimo KIT-B",
    inventory.setMinimum(actor, { productId: kit.productId, quantity: "20" }),
  );
  const recipe = await must(
    "receta",
    production.createRecipe(actor, kit.productId, { baseQuantity: "1" }),
  );
  for (const [sku, quantity] of [
    ["MAT-1", "2"],
    ["MAT-2", "1"],
    ["CAJ-CH", "1"],
  ] as const) {
    await must(
      `material ${sku}`,
      production.setRecipeInput(actor, recipe.versionId, {
        productId: products[sku]!,
        quantity,
      }),
    );
  }
  await must(
    "activar receta",
    production.activateRecipeVersion(actor, recipe.versionId),
  );
  await must(
    "área de la receta",
    production.setRecipeArea(actor, kit.productId, places["PROD"]!),
  );
  const productionOrder = await must(
    "orden de producción",
    production.createProductionOrder(actor, {
      productId: kit.productId,
      quantity: "10",
      areaLocationId: places["PROD"]!,
    }),
  );
  await must(
    "liberar orden de producción",
    production.releaseProductionOrder(
      actor,
      (productionOrder as unknown as { orderId: string }).orderId,
    ),
  );
  const plan = await must(
    "plan de inspección",
    quality.startPlanDraft(actor, kit.productId),
  );
  const planVersion = (plan as unknown as { versionId: string }).versionId;
  await must(
    "punto del plan",
    quality.addPlanPoint(actor, planVersion, {
      label: "Revisión visual",
      kind: "CHECK",
      required: true,
    }),
  );
  await must("publicar plan", quality.publishPlanDraft(actor, planVersion));
  await must(
    "defecto",
    quality.createDefect(actor, {
      name: "Pieza incompleta",
      severity: "MAJOR",
    }),
  );
};

/** Data sets by key; the console offers only these. */
export const DEMO_DATASETS: Record<string, DemoDataset> = { generic };

/** Keys of the data sets, for the console. */
export const DEMO_DATASET_KEYS = Object.keys(DEMO_DATASETS);

/** One line for the console: never a stack. */
function failureText(error: unknown): string {
  if (error instanceof DemoStepFailed) return error.message;
  return "Falló un paso al cargar los datos; revisa los registros del worker.";
}

/**
 * Loads a demonstration in the worker. Its job has a single attempt
 * (loading twice would repeat data that is never deleted), and the claim
 * makes any second run of it do nothing. A failure is kept on the
 * demonstration, for the console.
 */
export const demoJobHandlers: JobHandlers = {
  [DEMO_PREPARE_JOB]: {
    handle: async ({ organizationId }) => {
      const claim = await claimDemoPreparation(organizationId);
      if (!claim) return { skipped: true };
      const dataset = DEMO_DATASETS[claim.dataset];
      if (!dataset) {
        await finishDemoPreparation(organizationId, {
          ok: false,
          failure: "El juego de datos ya no existe.",
        });
        return { skipped: true };
      }
      try {
        await dataset({ organizationId, userId: claim.ownerUserId });
      } catch (error) {
        await finishDemoPreparation(organizationId, {
          ok: false,
          failure: failureText(error),
        });
        throw error;
      }
      await finishDemoPreparation(organizationId, { ok: true });
      return { ready: true };
    },
    onFailed: async ({ organizationId }) => {
      // Only a preparation still running changes (the worker vanished).
      await finishDemoPreparation(organizationId, {
        ok: false,
        failure: "La preparación se interrumpió antes de terminar.",
      });
    },
  },
};
