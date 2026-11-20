// Data model of the documentation (WMS-51): reads prisma/schema.prisma and
// writes docs/arquitectura/modelo-de-datos.md, every table grouped by area.
// Usage:
//   node scripts/data-model.mjs           (writes the file)
//   node scripts/data-model.mjs --check   (fails if the file is out of date)
// The area of each model is the explicit map below: a model without an
// area stops the script (and tests/docs/data-model.int.test.ts), so a new
// table is never left undocumented in silence.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SCHEMA_PATH = path.join(ROOT, "prisma/schema.prisma");
export const OUTPUT_PATH = path.join(
  ROOT,
  "docs/arquitectura/modelo-de-datos.md",
);

/**
 * Areas of the data model, in the order they are documented. `doc` is the
 * document of the area in docs/arquitectura/modulos/. Every model of the
 * schema belongs to exactly one area.
 */
export const AREAS = [
  {
    id: "auth",
    title: "Plataforma › Cuentas y sesiones",
    doc: "auth",
    summary:
      "Personas, sesiones, MFA y límites de intentos. Tablas de Better Auth y propias; no son de una empresa.",
    models: [
      "User",
      "Session",
      "Account",
      "Verification",
      "TwoFactor",
      "AuthThrottle",
      "RateLimit",
    ],
  },
  {
    id: "tenancy",
    title: "Plataforma › Empresas",
    doc: "tenancy",
    summary:
      "La empresa: todo lo de negocio cuelga de ella por `organizationId`.",
    models: ["Organization"],
  },
  {
    id: "authorization",
    title: "Plataforma › Equipo, permisos y alcance",
    doc: "authorization",
    summary:
      "Membresías, roles, alcance por almacén y zona, invitaciones, titularidad y acceso de soporte.",
    models: [
      "Membership",
      "MembershipRole",
      "MembershipScope",
      "Invitation",
      "OwnershipTransfer",
      "SupportAccess",
    ],
  },
  {
    id: "billing",
    title: "Plataforma › Plan, módulos y pagos",
    doc: "billing",
    summary:
      "Precios versionados, suscripción, pagos manuales y personal de plataforma. `checkout_order`, `promo_code` y `payment_event` quedan como historial del cobro en línea (ADR 0037): nada las escribe.",
    models: [
      "PlanVersion",
      "PlanOffer",
      "PlanModulePrice",
      "Subscription",
      "SubscriptionItem",
      "ManualPayment",
      "PlatformStaff",
      "DemoCompany",
      "CheckoutOrder",
      "PromoCode",
      "PaymentEvent",
    ],
  },
  {
    id: "entitlements",
    title: "Plataforma › Derechos y cupos",
    doc: "entitlements",
    summary:
      "Lo que una empresa puede usar hoy (módulos y límites) y cuánto de cada límite usa.",
    models: ["Entitlement", "QuotaUsage"],
  },
  {
    id: "audit",
    title: "Plataforma › Bitácora",
    doc: "audit",
    summary:
      "Registro solo-agregar de cambios sensibles de empresa y de eventos de cuenta.",
    models: ["AuditEvent", "SecurityEvent", "AccessAlertEmail"],
  },
  {
    id: "legal",
    title: "Plataforma › Aceptación de documentos",
    doc: "legal",
    summary:
      "Qué versión de términos y aviso de privacidad aceptó cada persona.",
    models: ["LegalAcceptance"],
  },
  {
    id: "settings",
    title: "Plataforma › Ajustes de operación",
    doc: "settings",
    summary:
      "Valor elegido por cada empresa para cada ajuste declarado por un módulo.",
    models: ["OrganizationSetting"],
  },
  {
    id: "approvals",
    title: "Plataforma › Aprobaciones",
    doc: "approvals",
    summary:
      "Qué pide autorización en cada empresa (regla por tipo) y cada solicitud con su decisión; los tipos los declara cada módulo.",
    models: ["ApprovalRule", "ApprovalRequest"],
  },
  {
    id: "processes",
    title: "Plataforma › Procesos",
    doc: "processes",
    summary:
      "Procesos de cada empresa por tipo de documento: versiones (borrador, publicada, retirada) con sus etapas, subetapas y áreas; el proceso de cada documento ligado a su versión, el estado de cada etapa con quién la tiene y el rastro inmutable de cada paso. Los documentos los declara cada módulo.",
    models: [
      "ProcessDefinition",
      "ProcessVersion",
      "ProcessStage",
      "ProcessStageRole",
      "ProcessProgress",
      "ProcessStageState",
      "ProcessStep",
    ],
  },
  {
    id: "notifications",
    title: "Plataforma › Avisos",
    doc: "notifications",
    summary:
      "Avisos dentro de la app para una persona (texto y destino fijos al crearse; solo cambia «leído»), los tipos que cada persona apagó o pidió por correo, los avisos que salen por correo y el resumen diario por correo de cada persona; los tipos los declara cada módulo.",
    models: [
      "Notification",
      "NotificationPreference",
      "NotificationEmail",
      "DailyDigest",
      "NoticeUnsubscribe",
    ],
  },
  {
    id: "terminals",
    title: "Plataforma › Terminales compartidas",
    doc: "terminals",
    summary:
      "Dispositivos registrados como terminal compartida de un almacén y cada secreto que se les dio (solo su hash, para detectar una cookie copiada; se quitan, no se borran) y el PIN de cada persona en cada empresa (hash lento, nunca en claro).",
    models: ["SharedTerminal", "SharedTerminalSecret", "MemberPin"],
  },
  {
    id: "api",
    title: "Plataforma › API y webhooks",
    doc: "api",
    summary:
      "Llaves de la API por empresa (solo el hash del secreto), contadores de llamadas por minuto, destinos de webhooks (secreto cifrado), eventos y entregas.",
    models: [
      "ApiKey",
      "ApiRateWindow",
      "WebhookEndpoint",
      "WebhookEvent",
      "WebhookDelivery",
    ],
  },
  {
    id: "custom-fields",
    title: "Plataforma › Campos personalizados",
    doc: "custom-fields",
    summary:
      "Campos que cada empresa agrega a sus productos, ubicaciones y proveedores, sus opciones y el valor de cada registro (sin columnas por cliente).",
    models: ["CustomField", "CustomFieldOption", "CustomFieldValue"],
  },
  {
    id: "files",
    title: "Plataforma › Archivos",
    doc: "files",
    summary:
      "Archivos privados de una empresa (lo que sube para importar, lo que se genera para descargar) y fotos de evidencia ligadas a un registro (WMS-37); llaves del almacenamiento pendientes de limpiar (WMS-67).",
    models: ["StoredFile", "EvidencePhoto", "StorageCleanup"],
  },
  {
    id: "jobs",
    title: "Plataforma › Cola de trabajos",
    doc: "jobs",
    summary: "Trabajos en segundo plano de una empresa; los corre el worker.",
    models: ["Job"],
  },
  {
    id: "locations",
    title: "Plataforma › Almacenes y ubicaciones",
    doc: "locations",
    summary:
      "Almacenes, sus niveles, el árbol de ubicaciones y sus límites (capacidad y restricciones).",
    models: [
      "Facility",
      "LocationLevel",
      "Location",
      "LocationCapacity",
      "LocationRestriction",
    ],
  },
  {
    id: "catalog",
    title: "Plataforma › Catálogo de productos",
    doc: "catalog",
    summary:
      "Productos, categorías, marcas, unidades y presentaciones con su historial de contenido.",
    models: [
      "Product",
      "ProductCategory",
      "ProductBrand",
      "Unit",
      "ProductPresentation",
      "PresentationVersion",
    ],
  },
  {
    id: "contacts",
    title: "Plataforma › Contactos",
    doc: "contacts",
    summary: "Proveedores y clientes en una sola tabla, con facetas.",
    models: ["Contact"],
  },
  {
    id: "inventory-stock",
    title: "Inventario › Existencias y movimientos",
    doc: "inventory",
    summary:
      "Movimientos inmutables, sus líneas, el saldo por producto + ubicación + estado + lote, lotes, unidades por número de serie y sus movimientos, costo promedio y mínimos.",
    models: [
      "StockMovement",
      "StockMovementLine",
      "StockBalance",
      "Lot",
      "SerialUnit",
      "SerialMove",
      "ProductCost",
      "StockMinimum",
    ],
  },
  {
    id: "inventory-containers",
    title: "Inventario › Tarimas y contenedores",
    doc: "inventory",
    summary:
      "Tarimas, cajas y otros contenedores con etiqueta propia, y los bultos de empaque de un pedido: qué parte del saldo de su ubicación agrupan (nunca más que el saldo) y su historia.",
    models: ["Container", "ContainerItem", "ContainerEvent"],
  },
  {
    id: "inventory-counts",
    title: "Inventario › Conteos",
    doc: "inventory",
    summary:
      "Conteos físicos: capturar no mueve nada; aplicar escribe ajustes. Los programas de conteo cíclico generan los conteos de cada día (WMS-55).",
    models: [
      "StockCount",
      "StockCountLine",
      "StockCountCapture",
      "CountProgram",
    ],
  },
  {
    id: "inventory-operation",
    title: "Inventario › Tareas, reservas y pedidos de salida",
    doc: "inventory",
    summary:
      "Tareas de traslado, surtido y reposición (con las series que tomaron), lo apartado para un documento, lo retenido de existencias no disponibles mientras un documento lo decide (WMS-30-0), los pedidos de salida, lo que faltó al empacarlos, las reglas de reposición de las ubicaciones de surtido y las olas que agrupan pedidos para surtirlos juntos (WMS-25).",
    models: [
      "WarehouseTask",
      "WarehouseTaskSerial",
      "StockReservation",
      "StockHold",
      "StockHoldUnit",
      "OutboundOrder",
      "OutboundOrderLine",
      "OutboundLineWait",
      "OutboundPackShortage",
      "ReplenishmentRule",
      "PickWave",
      "PickWaveOrder",
    ],
  },
  {
    id: "inventory-shipments",
    title: "Inventario › Embarques",
    doc: "inventory",
    summary:
      "Embarques que sacan uno o varios pedidos del almacén con su transporte, sus pedidos y lo que salió con cada uno (producto, lote, series y bulto).",
    models: ["Shipment", "ShipmentOrder", "ShipmentLine"],
  },
  {
    id: "inventory-customer-returns",
    title: "Inventario › Devoluciones de clientes",
    doc: "inventory",
    summary:
      "Lo que un cliente regresa (con un pedido despachado o sin él): su entrada en inspección, sus renglones y lo que se decidió de cada uno (disponible, dañado o rechazado), con quién y por qué.",
    models: ["CustomerReturn", "CustomerReturnLine", "CustomerReturnDecision"],
  },
  {
    id: "inventory-facility-transfers",
    title: "Inventario › Traslados entre almacenes",
    doc: "inventory",
    summary:
      "Lo que un almacén envía a otro de la misma empresa: el traslado, sus renglones (producto, ubicación de origen, lote y series) y cada recepción, pérdida o regreso de lo que iba en tránsito.",
    models: [
      "FacilityTransfer",
      "FacilityTransferLine",
      "FacilityTransferReceipt",
      "FacilityTransferReceiptLine",
    ],
  },
  {
    id: "inventory-incidents",
    title: "Inventario › Incidencias",
    doc: "inventory",
    summary:
      "Problemas del almacén que alguien reportó (mercancía dañada, algo fuera de lugar, una ubicación insegura, un equipo descompuesto), quién los atendió y cómo se cerraron, con sus notas; no tocan existencias.",
    models: ["Incident", "IncidentNote"],
  },
  {
    id: "inventory-equipment",
    title: "Inventario › Equipos",
    doc: "inventory",
    summary:
      "Equipos de cada almacén (montacargas, patines, básculas; el tipo lo nombra cada empresa), su estado en servicio o fuera de servicio, su baja y los mantenimientos hechos; las tareas que piden un tipo dicen con cuál se hicieron (WMS-42).",
    models: ["EquipmentType", "Equipment", "EquipmentMaintenance"],
  },
  {
    id: "inventory-imports",
    title: "Inventario › Importaciones",
    doc: "inventory",
    summary:
      "Importación de productos y existencias, de salidas y de pedidos desde Excel o CSV.",
    models: [
      "ProductImport",
      "ProductImportItem",
      "ExitImport",
      "ExitImportRow",
      "OutboundImport",
    ],
  },
  {
    id: "purchasing",
    title: "Compras",
    doc: "purchasing",
    summary:
      "Producto-proveedor, solicitudes y órdenes de compra y sus envíos, recepciones y devoluciones al proveedor.",
    models: [
      "ProductSupplier",
      "PurchaseOrder",
      "PurchaseOrderLine",
      "PurchaseOrderDelivery",
      "PurchaseReceipt",
      "PurchaseReceiptLine",
      "PurchaseReceiptRejection",
      "PurchaseReturn",
      "PurchaseReturnLine",
      "PurchaseRequest",
      "PurchaseRequestLine",
    ],
  },
  {
    id: "quality",
    title: "Calidad",
    doc: "quality",
    summary:
      "Planes de inspección de cada producto, con sus versiones, puntos de revisión y opciones, y el catálogo de defectos de la empresa (WMS-30A); las verificaciones con sus resultados, respuestas y defectos (WMS-30B).",
    models: [
      "QualityPlan",
      "QualityPlanVersion",
      "QualityPlanPoint",
      "QualityPlanPointOption",
      "QualityDefect",
      "QualityDefectCatalog",
      "QualityInspection",
      "QualityInspectionResult",
      "QualityInspectionAnswer",
      "QualityInspectionDefect",
    ],
  },
  {
    id: "production",
    title: "Producción",
    doc: "production",
    summary:
      "Recetas de los productos: una por producto, con versiones (para cuánto, materiales y lo que sale) y el candado que ordena sus activaciones. Órdenes de producción con los materiales y lo que sale copiados de la receta, y sus personas asignadas. Solicitudes de producción desde el piso, de las que puede nacer una orden.",
    models: [
      "Recipe",
      "RecipeVersion",
      "RecipeInput",
      "RecipeOutput",
      "RecipeLock",
      "ProductionOrder",
      "ProductionOrderLine",
      "ProductionOrderOutput",
      "ProductionOrderAssignee",
      "ProductionReport",
      "ProductionReportLine",
      "ProductionScrap",
      "ProductionLotNumbering",
      "ProductionLotSequence",
      "ProductionRequest",
    ],
  },
];

// ── Parser ───────────────────────────────────────────────────────────────

/** Text inside the first balanced parentheses after `start`, or null. */
function balanced(text, start) {
  const open = text.indexOf("(", start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}

function attribute(rest, name) {
  const at = rest.indexOf(`@${name}`);
  if (at < 0) return null;
  const after = rest[at + name.length + 1];
  if (after !== "(") return "";
  return balanced(rest, at);
}

const bracketList = (text) => {
  const match = /\[([^\]]*)\]/.exec(text ?? "");
  return match
    ? match[1]
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
    : [];
};

/**
 * Models and enums of a Prisma schema. Only what the documentation needs:
 * fields, keys, relations and the `///` comments above them.
 */
export function parseSchema(text) {
  const lines = text.split(/\r?\n/);
  const models = [];
  const enums = [];
  let doc = [];
  let block = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (block === null) {
      const head = /^(model|enum)\s+(\w+)\s*\{$/.exec(line);
      if (head) {
        block =
          head[1] === "model"
            ? {
                kind: "model",
                name: head[2],
                table: head[2],
                doc: doc.join(" "),
                fields: [],
                uniques: [],
                indexes: [],
              }
            : { kind: "enum", name: head[2], doc: doc.join(" "), values: [] };
        doc = [];
      } else if (line.startsWith("///")) {
        doc.push(line.slice(3).trim());
      } else {
        doc = [];
      }
      continue;
    }
    if (line === "}") {
      (block.kind === "model" ? models : enums).push(block);
      block = null;
      doc = [];
      continue;
    }
    if (line.startsWith("///")) {
      doc.push(line.slice(3).trim());
      continue;
    }
    if (line === "" || line.startsWith("//")) continue;
    if (block.kind === "enum") {
      block.values.push(line.split(/\s+/)[0]);
      doc = [];
      continue;
    }
    if (line.startsWith("@@")) {
      const name = /^@@(\w+)/.exec(line)[1];
      const args = balanced(line, 0);
      if (name === "map") block.table = /"([^"]+)"/.exec(args)[1];
      else if (name === "unique") block.uniques.push(bracketList(args));
      else if (name === "index") block.indexes.push(bracketList(args));
      else if (name === "id") block.uniques.push(bracketList(args));
      doc = [];
      continue;
    }
    const field = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(line);
    if (!field)
      throw new Error(`Línea no reconocida en ${block.name}: ${line}`);
    const [, name, type, list, optional, rest] = field;
    const db = /@db\.(\w+(?:\([^)]*\))?)/.exec(rest);
    const relation = attribute(rest, "relation");
    block.fields.push({
      name,
      type,
      list: Boolean(list),
      optional: Boolean(optional),
      id: /(^|\s)@id\b/.test(rest),
      unique: /(^|\s)@unique\b/.test(rest),
      updatedAt: /(^|\s)@updatedAt\b/.test(rest),
      default: attribute(rest, "default"),
      dbType: db ? db[1] : null,
      relation:
        relation === null
          ? null
          : {
              fields: bracketList(/fields:\s*(\[[^\]]*\])/.exec(relation)?.[1]),
              references: bracketList(
                /references:\s*(\[[^\]]*\])/.exec(relation)?.[1],
              ),
              onDelete: /onDelete:\s*(\w+)/.exec(relation)?.[1] ?? null,
            },
      doc: doc.join(" "),
    });
    doc = [];
  }
  return { models, enums };
}

// ── Areas ────────────────────────────────────────────────────────────────

/** Problems of the area map against the schema; empty when they match. */
export function areaProblems(schema, areas = AREAS) {
  const problems = [];
  const names = new Set(schema.models.map((model) => model.name));
  const seen = new Map();
  for (const area of areas) {
    for (const model of area.models) {
      if (seen.has(model)) {
        problems.push(
          `${model} está en dos áreas: ${seen.get(model)} y ${area.id}`,
        );
      }
      seen.set(model, area.id);
      if (!names.has(model)) {
        problems.push(`${model} (área ${area.id}) ya no existe en el esquema`);
      }
    }
  }
  for (const model of schema.models) {
    if (!seen.has(model.name)) {
      problems.push(
        `${model.name} no tiene área: agrégalo a AREAS en scripts/data-model.mjs`,
      );
    }
  }
  return problems;
}

// ── Markdown ─────────────────────────────────────────────────────────────

const cell = (text) =>
  String(text).replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
const code = (text) => `\`${text}\``;
const keyList = (fields) =>
  fields.length === 1 ? code(fields[0]) : `(${fields.map(code).join(", ")})`;

function renderModel(model, modelNames) {
  const columns = model.fields.filter((field) => !modelNames.has(field.type));
  const relations = model.fields.filter(
    (field) => modelNames.has(field.type) && field.relation?.fields.length,
  );
  const isTenant = columns.some((field) => field.name === "organizationId");
  const out = [`### ${model.name} · ${code(model.table)}`, ""];
  if (model.doc) out.push(model.doc, "");
  out.push(
    isTenant
      ? "De empresa: lleva `organizationId` y está en `TENANT_MODELS`."
      : "No es de una empresa (sin `organizationId`).",
    "",
    "| Columna | Tipo | Por omisión | Nota |",
    "| --- | --- | --- | --- |",
  );
  for (const field of columns) {
    const type = `${field.type}${field.list ? "[]" : ""}${field.optional ? "?" : ""}`;
    const shown = field.dbType ? `${type} · ${field.dbType}` : type;
    const marks = [
      field.id ? "llave primaria" : "",
      field.unique ? "única" : "",
      field.updatedAt ? "Prisma la actualiza en cada cambio" : "",
    ]
      .filter(Boolean)
      .join(", ");
    const note = [marks, field.doc].filter(Boolean).join(". ");
    out.push(
      `| ${code(field.name)} | ${code(cell(shown))} | ${
        field.default === null ? "" : code(cell(field.default || "sí"))
      } | ${cell(note)} |`,
    );
  }
  out.push("");
  const uniques = model.uniques.filter((fields) => fields.length > 0);
  if (uniques.length) {
    out.push(`- Únicas: ${uniques.map(keyList).join("; ")}.`);
  }
  if (model.indexes.length) {
    out.push(`- Índices: ${model.indexes.map(keyList).join("; ")}.`);
  }
  const shownRelations = relations.filter(
    (field) =>
      !(
        isTenant &&
        field.type === "Organization" &&
        field.name === "organization"
      ),
  );
  if (shownRelations.length) {
    out.push(
      `- Relaciones: ${shownRelations
        .map(
          (field) =>
            `${code(field.name)} → ${code(field.type)} por ${keyList(
              field.relation.fields,
            )}${field.relation.onDelete ? ` (al borrar: ${field.relation.onDelete})` : ""}`,
        )
        .join("; ")}.`,
    );
  }
  if (uniques.length || model.indexes.length || shownRelations.length)
    out.push("");
  return out;
}

/** The whole document, or an error listing the models without area. */
export function renderDataModel(schemaText, areas = AREAS) {
  const schema = parseSchema(schemaText);
  const problems = areaProblems(schema, areas);
  if (problems.length > 0) {
    throw new Error(
      `El mapa de áreas no coincide con el esquema:\n- ${problems.join("\n- ")}`,
    );
  }
  const byName = new Map(schema.models.map((model) => [model.name, model]));
  const modelNames = new Set(byName.keys());
  const enumArea = new Map();
  for (const area of areas) {
    for (const name of area.models) {
      for (const field of byName.get(name).fields) {
        if (!enumArea.has(field.type)) enumArea.set(field.type, area.id);
      }
    }
  }

  const out = [
    "# Modelo de datos",
    "",
    "<!-- Generado por scripts/data-model.mjs a partir de prisma/schema.prisma. No editar a mano: correr `node scripts/data-model.mjs`. -->",
    "",
    `${schema.models.length} tablas en ${areas.length} áreas, en el orden de abajo. Para cada tabla: nombre del modelo de Prisma y de la tabla en MySQL, su comentario del esquema (en inglés, como el código), columnas, llaves únicas, índices y relaciones que guarda (las inversas se ven en la otra tabla). Un tipo con \`?\` admite \`NULL\`. Las reglas que viven en la base (\`CHECK\`, disparadores) están en \`prisma/migrations/\`, no en el esquema.`,
    "",
    "| Área | Tablas | Documento |",
    "| --- | --- | --- |",
  ];
  for (const area of areas) {
    out.push(
      `| ${area.title} | ${area.models.length} | [${area.doc}](modulos/${area.doc}.md) |`,
    );
  }
  out.push("");
  for (const area of areas) {
    out.push(
      `## ${area.title}`,
      "",
      area.summary,
      "",
      `Documento: [modulos/${area.doc}.md](modulos/${area.doc}.md).`,
      "",
    );
    for (const name of area.models)
      out.push(...renderModel(byName.get(name), modelNames));
    const enums = schema.enums.filter(
      (item) => enumArea.get(item.name) === area.id,
    );
    if (enums.length) {
      out.push(`#### Enumeraciones de ${area.title}`, "");
      for (const item of enums) {
        out.push(`- ${code(item.name)}: ${item.values.map(code).join(", ")}.`);
      }
      out.push("");
    }
  }
  const loose = schema.enums.filter((item) => !enumArea.has(item.name));
  if (loose.length) {
    out.push("## Enumeraciones sin tabla", "");
    for (const item of loose) {
      out.push(`- ${code(item.name)}: ${item.values.map(code).join(", ")}.`);
    }
    out.push("");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

/** Table names (`@@map`) listed in a generated document. */
export function documentedTables(markdown) {
  return [...markdown.matchAll(/^### (\w+) · `([^`]+)`$/gm)].map(
    ([, model, table]) => ({
      model,
      table,
    }),
  );
}

// ── Command line ─────────────────────────────────────────────────────────

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const markdown = renderDataModel(readFileSync(SCHEMA_PATH, "utf8"));
  const relative = path.relative(ROOT, OUTPUT_PATH);
  if (process.argv.includes("--check")) {
    const current = readFileSync(OUTPUT_PATH, "utf8");
    if (current !== markdown) {
      console.error(
        `${relative} no está al día: corre node scripts/data-model.mjs`,
      );
      process.exit(1);
    }
    console.log(`${relative} está al día.`);
  } else {
    writeFileSync(OUTPUT_PATH, markdown);
    console.log(`${relative} escrito.`);
  }
}
