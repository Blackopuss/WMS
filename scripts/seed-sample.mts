// Sample data for the demo company (development only): locations, products
// with stock, a supplier with an order to receive, an outbound order to pick,
// a transfer task and an open count, plus two people of the floor without
// two-step sign-in. Everything goes through the real services, so balances
// reconcile. Run after `npm run db:seed`: `npm run db:seed:ejemplo`.
// Does nothing when the company already has products.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const database = process.env.DATABASE_NAME ?? "wms_dev";
if (process.env.NODE_ENV === "production" || !database.endsWith("_dev")) {
  console.error("Solo para la base de desarrollo.");
  process.exit(1);
}

const serverOnly = pathToFileURL("scripts/server-only-stub.mjs").href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { url: serverOnly, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { newId } = await import("@/lib");
const { db } = await import("@/server/db");
const { hashPassword } = await import("@/platform/auth/password");
const { LEGAL_DOCUMENTS, LEGAL_DOCUMENT_IDS } =
  await import("@/platform/legal/documents");
const { createProduct } = await import("@/platform/catalog");
const { createLocation } = await import("@/platform/locations");
const { createSupplier } = await import("@/platform/contacts");
const inventory = await import("@/modules/inventory");
const purchasing = await import("@/modules/purchasing");
const production = await import("@/modules/production");
const quality = await import("@/modules/quality");

const email = process.env.DEMO_EMAIL;
const password = process.env.DEMO_PASSWORD;
if (!email || !password) {
  console.error("Faltan DEMO_EMAIL y DEMO_PASSWORD: corre npm run db:seed.");
  process.exit(1);
}
const owner = await db.user.findUnique({ where: { email } });
const organization = owner
  ? await db.organization.findFirst({ where: { ownerUserId: owner.id } })
  : null;
if (!owner || !organization) {
  console.error("No existe la empresa demo: corre npm run db:seed.");
  process.exit(1);
}
const organizationId = organization.id;
const actor = { organizationId, userId: owner.id };

if ((await db.product.count({ where: { organizationId } })) > 0) {
  console.log("La empresa demo ya tiene productos: no se agregó nada.");
  await db.$disconnect();
  process.exit(0);
}

async function must<T extends { ok: boolean }>(
  what: string,
  result: Promise<T>,
): Promise<Extract<T, { ok: true }>> {
  const done = await result;
  if (!done.ok) throw new Error(`${what}: ${JSON.stringify(done)}`);
  return done as Extract<T, { ok: true }>;
}

// People of the floor, with the demo password and no two-step sign-in.
const people = [
  { name: "Olivia Operadora", local: "operador", role: "operator" },
  { name: "Samuel Supervisor", local: "supervisor", role: "supervisor" },
] as const;
const domain = email.split("@")[1];
for (const person of people) {
  const userId = newId();
  await db.user.create({
    data: {
      id: userId,
      name: person.name,
      email: `${person.local}@${domain}`,
      emailVerified: true,
    },
  });
  await db.account.create({
    data: {
      id: newId(),
      userId,
      providerId: "credential",
      accountId: userId,
      password: await hashPassword(password),
    },
  });
  await db.legalAcceptance.createMany({
    data: LEGAL_DOCUMENT_IDS.map((document) => ({
      id: newId(),
      userId,
      document,
      version: LEGAL_DOCUMENTS[document].version,
    })),
  });
  const membershipId = newId();
  await db.membership.create({
    data: { id: membershipId, organizationId, userId },
  });
  await db.membershipRole.create({
    data: { id: newId(), organizationId, membershipId, role: person.role },
  });
}

// Locations: two zones with aisles and shelves.
const locations: Record<string, string> = {};
async function location(
  key: string,
  name: string,
  level: number,
  parent?: string,
  code?: string,
) {
  const made = await must(
    `ubicación ${name}`,
    createLocation(actor, {
      name,
      level,
      parentId: parent ? locations[parent] : undefined,
      code,
    }),
  );
  locations[key] = (made as unknown as { locationId: string }).locationId;
}
await location("A", "Zona A", 1);
await location("A1", "Pasillo 1", 2, "A");
await location("A1-1", "Estante 1", 3, "A1", "A-01-01");
await location("A1-2", "Estante 2", 3, "A1", "A-01-02");
await location("A2", "Pasillo 2", 2, "A");
await location("A2-1", "Estante 1", 3, "A2", "A-02-01");
await location("B", "Zona B", 1);
await location("B1", "Pasillo 1", 2, "B");
await location("B1-1", "Estante 1", 3, "B1", "B-01-01");

const PRODUCTS = [
  ["CAJ-001", "Caja de cartón chica 30×20×15 cm", "Empaque", "A1-1", 480, 100],
  [
    "CAJ-002",
    "Caja de cartón mediana 40×30×25 cm",
    "Empaque",
    "A1-1",
    320,
    100,
  ],
  ["CAJ-003", "Caja de cartón grande 60×40×40 cm", "Empaque", "A1-2", 35, 80],
  ["CIN-001", "Cinta adhesiva transparente 48 mm", "Empaque", "A1-2", 150, 40],
  ["CIN-002", "Cinta adhesiva canela 48 mm", "Empaque", "A1-2", 12, 40],
  ["PEL-001", "Película estirable 18 in", "Empaque", "A2-1", 64, 20],
  ["ETI-001", "Etiqueta térmica 4×6 in (rollo)", "Etiquetado", "A2-1", 90, 30],
  ["ETI-002", "Etiqueta de frágil (rollo)", "Etiquetado", "A2-1", 8, 15],
  ["GUA-001", "Guantes de trabajo talla M (par)", "Seguridad", "B1-1", 75, 20],
  ["GUA-002", "Guantes de trabajo talla G (par)", "Seguridad", "B1-1", 60, 20],
  ["CHA-001", "Chaleco reflejante", "Seguridad", "B1-1", 40, 10],
  ["TAR-001", "Tarima de madera estándar", "Manejo", "B1-1", 55, 20],
  ["FLE-001", "Fleje plástico 1/2 in (rollo)", "Manejo", "A2-1", 0, 10],
  ["MAR-001", "Marcador permanente negro", "Oficina", "A1-2", 200, 50],
] as const;

const products: Record<string, string> = {};
for (const [sku, name, category, where, stock, minimum] of PRODUCTS) {
  const made = await must(
    `producto ${sku}`,
    createProduct(actor, { sku, name, category, unit: "piece" }),
  );
  products[sku] = made.productId;
  if (stock > 0) {
    await must(
      `saldo ${sku}`,
      inventory.registerInitialBalance(actor, {
        productId: made.productId,
        quantity: String(stock),
        locationId: locations[where],
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

// A product by lot (WMS-21): two lots with different expiry dates, one of
// them about to expire, so «Por caducar» and the order of «de dónde sale»
// have something to show.
{
  const inDays = (days: number) =>
    new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const made = await must(
    "producto LIM-001",
    createProduct(actor, {
      sku: "LIM-001",
      name: "Gel antibacterial 500 ml",
      category: "Limpieza",
      unit: "piece",
      tracking: "LOT",
      lotExpiry: "REQUIRED",
    }),
  );
  products["LIM-001"] = made.productId;
  for (const [code, days, where, quantity] of [
    ["L-2501", 20, "A2-1", "36"],
    ["L-2502", 240, "B1-1", "60"],
  ] as const) {
    await must(
      `lote ${code}`,
      inventory.registerInitialBalance(actor, {
        productId: made.productId,
        quantity,
        locationId: locations[where],
        lotCode: code,
        lotExpiresOn: inDays(days),
      }),
    );
  }
}

// Some history: an entry and two exits.
await must(
  "entrada",
  inventory.registerEntry(actor, {
    productId: products["CAJ-001"]!,
    quantity: "120",
    locationId: locations["A1-1"],
  }),
);
for (const [sku, where, quantity] of [
  ["CIN-001", "A1-2", "24"],
  ["MAR-001", "A1-2", "10"],
] as const) {
  await must(
    `salida ${sku}`,
    inventory.registerExit(actor, {
      productId: products[sku]!,
      quantity,
      locationId: locations[where],
    }),
  );
}

// A supplier with an order on its way (shows in Recepción).
const supplier = await must(
  "proveedor",
  createSupplier(actor, {
    name: "Empaques del Centro",
    contactPerson: "Laura Méndez",
    email: "ventas@empaquesdelcentro.example",
    phone: "55 5555 0101",
  }),
);
// A second supplier: with a single one «Nueva orden» chooses it for the person
// and has nothing to refuse when sent empty (verify:a11y checks that).
await must(
  "segundo proveedor",
  createSupplier(actor, {
    name: "Etiquetas del Norte",
    contactPerson: "Mario Ibarra",
    email: "pedidos@etiquetasdelnorte.example",
    phone: "55 5555 0102",
  }),
);
const order = await must(
  "orden de compra",
  purchasing.createPurchaseOrder(actor, { supplierId: supplier.supplierId }),
);
const purchaseOrderId = (order as unknown as { orderId: string }).orderId;
for (const [sku, quantity, unitCost] of [
  ["CIN-002", "60", "18.50"],
  ["ETI-002", "30", "42.00"],
  ["FLE-001", "20", "310.00"],
  // A product by lot: receiving it asks for its lot and expiry.
  ["LIM-001", "48", "35.00"],
] as const) {
  await must(
    `línea ${sku}`,
    purchasing.addOrderLine(actor, purchaseOrderId, {
      productId: products[sku]!,
      capture: "base",
      quantity,
      unitCost,
    }),
  );
}
await must(
  "confirmar orden",
  purchasing.submitPurchaseOrder(actor, purchaseOrderId),
);

// An outbound order released (its picking tasks appear in Tareas) and a draft.
const outbound = await must(
  "pedido",
  inventory.createOutboundOrder(actor, {
    recipient: "Sucursal Norte",
    reference: "Reposición semanal",
    priority: "URGENT",
  }),
);
const outboundId = (outbound as unknown as { orderId: string }).orderId;
for (const [sku, quantity] of [
  ["CAJ-001", "50"],
  ["CIN-001", "12"],
  ["GUA-001", "10"],
  // By lot: picked from the lot that expires first.
  ["LIM-001", "12"],
] as const) {
  await must(
    `línea de pedido ${sku}`,
    inventory.setOutboundLine(actor, outboundId, {
      productId: products[sku]!,
      quantity,
    }),
  );
}
await must("liberar pedido", inventory.releaseOutboundOrder(actor, outboundId));
const draft = await must(
  "pedido en borrador",
  inventory.createOutboundOrder(actor, { recipient: "Sucursal Sur" }),
);
await must(
  "línea de borrador",
  inventory.setOutboundLine(
    actor,
    (draft as unknown as { orderId: string }).orderId,
    { productId: products["CAJ-002"]!, quantity: "40" },
  ),
);

// A transfer task and an open count.
await must(
  "tarea de traslado",
  inventory.createTask(actor, {
    productId: products["TAR-001"]!,
    fromLocationId: locations["B1-1"]!,
    toLocationId: locations["A2-1"]!,
    quantity: "10",
  }),
);
await must(
  "conteo",
  inventory.openCount(actor, { locationId: locations["A1-2"]! }),
);

// A picking place (WMS-78C), so «Nueva regla de reposición» has where to
// replenish; and Producción and Calidad: an area, a kit with its recipe, a
// released order, an inspection plan and a defect.
await must(
  "ubicación de surtido",
  createLocation(actor, {
    level: 3,
    name: "Estante 2",
    parentId: locations["A2"],
    code: "A-02-02",
    type: "PICKING",
  }),
);
{
  const area = await must(
    "área de producción",
    createLocation(actor, {
      level: 1,
      name: "Línea de ensamble",
      code: "PROD-01",
      type: "PRODUCTION",
    }),
  );
  const areaId = (area as unknown as { locationId: string }).locationId;
  const kit = await must(
    "producto KIT-001",
    createProduct(actor, {
      sku: "KIT-001",
      name: "Kit de envío mediano",
      category: "Empaque",
      unit: "piece",
    }),
  );
  await must(
    "mínimo KIT-001",
    inventory.setMinimum(actor, { productId: kit.productId, quantity: "20" }),
  );
  const recipe = await must(
    "receta",
    production.createRecipe(actor, kit.productId, { baseQuantity: "1" }),
  );
  for (const [sku, quantity] of [
    ["CAJ-002", "1"],
    ["CIN-001", "2"],
    ["ETI-001", "1"],
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
    production.setRecipeArea(actor, kit.productId, areaId),
  );
  const order = await must(
    "orden de producción",
    production.createProductionOrder(actor, {
      productId: kit.productId,
      quantity: "10",
      areaLocationId: areaId,
    }),
  );
  await must(
    "liberar orden",
    production.releaseProductionOrder(
      actor,
      (order as unknown as { orderId: string }).orderId,
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
      label: "Caja sin golpes",
      kind: "CHECK",
      required: true,
    }),
  );
  await must("publicar plan", quality.publishPlanDraft(actor, planVersion));
  await must(
    "defecto",
    quality.createDefect(actor, { name: "Caja aplastada", severity: "MAJOR" }),
  );
}

// WMS-87: stock that waits for a decision («Por inspeccionar» and «En
// restauración») and a process with a stage on production orders, so those
// screens and `/procesos/[id]` can be reviewed with data.
{
  const at = {
    productId: products["GUA-001"]!,
    locationId: locations["B1-1"]!,
  };
  for (const [to, reason] of [
    ["INSPECTION", "Revisar el lote al recibirlo"],
    ["REPAIR", "Coser costuras sueltas"],
  ] as const) {
    await must(
      `existencias ${to}`,
      inventory.changeStockStatus(actor, {
        ...at,
        from: "AVAILABLE",
        to,
        quantity: "3",
        reason,
        idempotencyKey: newId(),
      }),
    );
  }
  const processes = await import("@/platform/processes");
  const documents = (await import("@/modules/registry")).processDocuments;
  await must(
    "proceso de órdenes de producción",
    processes.saveProcessDraft(
      actor,
      documents,
      "production.order",
      {
        stages: [
          {
            name: "Revisar los materiales",
            kind: "MANUAL",
            milestone: "DRAFT",
            roles: ["production_supervisor"],
            children: [
              { name: "Contar las cajas" },
              { name: "Revisar la cinta" },
            ],
          },
        ],
      },
      { publish: true },
    ),
  );
  const area = await db.location.findFirstOrThrow({
    where: { organizationId, type: "PRODUCTION" },
  });
  const kit = await db.product.findFirstOrThrow({
    where: { organizationId, sku: "KIT-001" },
  });
  // A new order starts its process (the first one was made before it).
  await must(
    "orden con proceso",
    production.createProductionOrder(actor, {
      productId: kit.id,
      quantity: "5",
      areaLocationId: area.id,
    }),
  );
}

console.log(
  `Datos de ejemplo listos en «${organization.name}». Personas sin dos pasos (misma contraseña demo): ${people.map((p) => `${p.local}@${domain}`).join(", ")}.`,
);
await db.$disconnect();
