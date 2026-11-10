import "server-only";

import { newId } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import { assertModulePermission } from "@/platform/billing";
import { parseQuantity } from "@/platform/catalog";
import {
  buildCsv,
  buildXlsx,
  deleteFile,
  readSpreadsheet,
  readStoredFile,
  storeFile,
  type Cell,
} from "@/platform/files";
import { activeFacilityOf } from "@/platform/locations";
import { LOCKING_TRANSACTION, forOrganization, lockRows } from "@/server";

import { formatExitDay, parseExitDay } from "./exit-import";
import { foldName } from "./import-validation";
import { normalizeDecimal, type DecimalSeparator } from "./imports";
import { formatStock, type InventoryActor } from "./movements";
import { OUTBOUND_MAX_LINES } from "./outbound-orders";
import { formatOutboundNumber } from "./outbound-states";

/**
 * Import of outbound orders (WMS-13B): orders kept in another system arrive
 * as a file, one row per line, and become drafts. Same road as the other
 * imports: the file is kept as a private file of the company, every
 * opening checks it again without writing, and confirming creates every
 * draft of the file in one transaction — or none.
 *
 * The «Pedido» of each row says which order it belongs to. It is kept as
 * the order's reference and, folded, as its `sourceKey`, unique in the
 * company: uploading the same file again, or confirming it twice, never
 * creates an order twice.
 *
 * Drafts reserve nothing: releasing each one (WMS-13) is still a person's
 * decision.
 */

/** Orders and rows a file may bring at once. */
export const OUTBOUND_IMPORT_MAX_ORDERS = 200;
export const OUTBOUND_IMPORT_MAX_ROWS = 5000;

export const OUTBOUND_IMPORT_COLUMNS = [
  {
    key: "order",
    header: "Pedido",
    required: true,
    help: "El número o folio del pedido en tu sistema. Las filas con el mismo pedido forman un solo pedido; con él sabemos que ya se importó y no se crea dos veces.",
    example: "OV-1001",
  },
  {
    key: "recipient",
    header: "Destinatario",
    required: true,
    help: "Para quién es: cliente, sucursal o línea de producción. Basta en la primera fila del pedido.",
    example: "Comercial del Bajío",
  },
  {
    key: "sku",
    header: "Clave (SKU)",
    required: false,
    help: "La clave del producto en tu catálogo. Puedes usar el código de barras en su lugar.",
    example: "TOR-001",
  },
  {
    key: "barcode",
    header: "Código de barras",
    required: false,
    help: "Si solo tienes el código de barras, úsalo en vez de la clave.",
    example: "",
  },
  {
    key: "quantity",
    header: "Cantidad",
    required: true,
    help: "Cuánto se pide, en la unidad del producto.",
    example: "24",
  },
  {
    key: "dueOn",
    header: "Fecha compromiso",
    required: false,
    help: "El día en que debe salir, como 2026-11-20 o 20/11/2026 (día/mes/año).",
    example: "2026-11-20",
  },
  {
    key: "priority",
    header: "Prioridad",
    required: false,
    help: "«Urgente» o «Normal». Vacía = Normal.",
    example: "Normal",
  },
  {
    key: "address",
    header: "Dirección",
    required: false,
    help: "A dónde se entrega, si hace falta.",
    example: "",
  },
  {
    key: "note",
    header: "Notas",
    required: false,
    help: "Indicaciones para el almacén.",
    example: "",
  },
] as const;

export type OutboundColumnKey = (typeof OUTBOUND_IMPORT_COLUMNS)[number]["key"];

/** Columns that describe the order, not the line: equal in all its rows. */
const HEADER_KEYS = [
  "recipient",
  "dueOn",
  "priority",
  "address",
  "note",
] as const satisfies readonly OutboundColumnKey[];

const headerOf = (key: OutboundColumnKey) =>
  OUTBOUND_IMPORT_COLUMNS.find((column) => column.key === key)!.header;

/** Other titles people's systems give these columns. */
const SYNONYMS: Record<OutboundColumnKey, string[]> = {
  order: [
    "pedido",
    "folio",
    "orden",
    "numero de pedido",
    "no pedido",
    "folio de pedido",
    "orden de venta",
  ],
  recipient: ["destinatario", "cliente", "para", "sucursal", "destino"],
  sku: ["clave sku", "clave", "sku", "codigo", "clave producto", "producto"],
  barcode: ["codigo de barras", "codigo barras", "ean", "upc", "barras"],
  quantity: ["cantidad", "piezas", "unidades", "cant"],
  dueOn: [
    "fecha compromiso",
    "fecha",
    "fecha de entrega",
    "entrega",
    "compromiso",
  ],
  priority: ["prioridad", "urgencia"],
  address: ["direccion", "domicilio", "direccion de entrega"],
  note: ["notas", "nota", "observaciones", "comentarios"],
};

const foldTitle = (title: string) =>
  foldName(title)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export type OutboundMapping = Partial<Record<OutboundColumnKey, number>>;

/** Which column of the file is each of ours, by its title. */
export function matchOutboundColumns(headers: readonly string[]): {
  mapping: OutboundMapping;
  missing: string[];
} {
  const titles = headers.map(foldTitle);
  const taken = new Set<number>();
  const mapping: OutboundMapping = {};
  for (const column of OUTBOUND_IMPORT_COLUMNS) {
    const names = [foldTitle(column.header), ...SYNONYMS[column.key]];
    const index = titles.findIndex(
      (title, i) => !taken.has(i) && title !== "" && names.includes(title),
    );
    if (index >= 0) {
      mapping[column.key] = index;
      taken.add(index);
    }
  }
  const missing: string[] = OUTBOUND_IMPORT_COLUMNS.filter(
    (column) => column.required && mapping[column.key] === undefined,
  ).map((column) => column.header);
  if (mapping.sku === undefined && mapping.barcode === undefined) {
    missing.push(`${headerOf("sku")} o ${headerOf("barcode")}`);
  }
  return { mapping, missing };
}

/** What identifies an imported order in the company. */
export const outboundSourceKey = (order: string) => foldName(order);

export type OutboundIssue = {
  /** Row of the file, as the person sees it. */
  row: number;
  column: OutboundColumnKey | null;
  header: string;
  value: string;
  message: string;
};

/** A product of the catalog, as the check needs it. */
export type OutboundImportProduct = {
  id: string;
  sku: string;
  name: string;
  barcode: string | null;
  status: "ACTIVE" | "ARCHIVED";
  unitCode: string;
  quantityStep: string;
};

/** An order of the file that passed, as it will be created. */
export type ImportedOutboundOrder = {
  /** First row of the order in the file. */
  row: number;
  /** As written in the file: becomes the order's reference. */
  order: string;
  sourceKey: string;
  recipient: string;
  /** 2026-11-20. */
  dueOn: string | null;
  priority: "NORMAL" | "URGENT";
  address: string | null;
  note: string | null;
  lines: {
    row: number;
    productId: string;
    sku: string;
    productName: string;
    unitCode: string;
    quantity: string;
  }[];
};

export type OutboundRowsValidation = {
  orders: ImportedOutboundOrder[];
  issues: OutboundIssue[];
  invalidRows: number;
};

const hasControl = (text: string) => /[\u0000-\u001f\u007f]/.test(text);

const LIMITS: Record<(typeof HEADER_KEYS)[number], number> = {
  recipient: 160,
  dueOn: 40,
  priority: 20,
  address: 300,
  note: 500,
};

/**
 * Checks the rows of a file of outbound orders. Pure: the products and the
 * orders already imported (by `sourceKey`, with their number) come as
 * arguments. An order with any wrong row is not valid: its rows count as
 * invalid, so a confirmed file never creates half an order.
 */
export function validateOutboundRows(
  rows: { row: number; cells: string[] }[],
  options: {
    headers: string[];
    mapping: OutboundMapping;
    decimalSeparator: DecimalSeparator;
    products: OutboundImportProduct[];
    /** Orders of the company that came from a file: «PS-0004» by key. */
    imported: Map<string, number>;
  },
): OutboundRowsValidation {
  const { headers, mapping } = options;
  const bySku = new Map(
    options.products.map((product) => [foldName(product.sku), product]),
  );
  const byBarcode = new Map(
    options.products.flatMap((product) =>
      product.barcode ? [[product.barcode, product] as const] : [],
    ),
  );

  const issues: OutboundIssue[] = [];
  type HeaderKey = (typeof HEADER_KEYS)[number];
  type Draft = {
    row: number;
    order: string;
    sourceKey: string;
    /** Each value of the order as its first row wrote it, and that row. */
    header: Partial<Record<HeaderKey, { value: string; row: number }>>;
    lines: ImportedOutboundOrder["lines"];
    failed: boolean;
    rows: number[];
    products: Map<string, number>;
  };
  const drafts = new Map<string, Draft>();
  /** Rows that failed on their own. */
  const badRows = new Set<number>();

  for (const { row, cells } of rows) {
    const cell = (key: OutboundColumnKey) => {
      const index = mapping[key];
      return index === undefined ? "" : (cells[index] ?? "").trim();
    };
    let failed = false;
    const issue = (column: OutboundColumnKey, message: string) => {
      failed = true;
      const index = mapping[column];
      issues.push({
        row,
        column,
        header:
          (index !== undefined && headers[index]) || headerOf(column) || "",
        value: cell(column).slice(0, 80),
        message,
      });
    };

    const orderText = cell("order");
    let draft: Draft | undefined;
    if (orderText === "") {
      issue(
        "order",
        "Falta el pedido. Las filas con el mismo pedido forman un solo pedido.",
      );
    } else if (orderText.length > 64 || hasControl(orderText)) {
      issue("order", "El pedido admite hasta 64 caracteres, sin saltos.");
    } else {
      const key = outboundSourceKey(orderText);
      const existing = options.imported.get(key);
      if (existing !== undefined) {
        issue(
          "order",
          `El pedido «${orderText}» ya se importó como ${formatOutboundNumber(existing)}. Quita sus filas del archivo.`,
        );
      }
      draft = drafts.get(key);
      if (!draft) {
        if (drafts.size >= OUTBOUND_IMPORT_MAX_ORDERS) {
          issue(
            "order",
            `Un archivo admite hasta ${OUTBOUND_IMPORT_MAX_ORDERS} pedidos. Divídelo en varios.`,
          );
        } else {
          draft = {
            row,
            order: orderText,
            sourceKey: key,
            header: {},
            lines: [],
            failed: false,
            rows: [],
            products: new Map(),
          };
          drafts.set(key, draft);
        }
      }
      draft?.rows.push(row);
    }

    // What describes the order: the first row that writes it decides,
    // and any other row of the order must say the same or leave it empty.
    const values: Partial<Record<(typeof HEADER_KEYS)[number], string>> = {};
    for (const key of HEADER_KEYS) {
      const value = cell(key);
      if (value === "") continue;
      if (value.length > LIMITS[key] || (key !== "note" && hasControl(value))) {
        issue(
          key,
          `${headerOf(key)} admite hasta ${LIMITS[key]} caracteres${key === "note" ? "" : ", sin saltos"}.`,
        );
        continue;
      }
      values[key] = value;
    }
    let dueOn: string | null = null;
    if (values.dueOn !== undefined) {
      dueOn = parseExitDay(values.dueOn);
      if (!dueOn) {
        issue(
          "dueOn",
          /^\d{5}(\.\d+)?$/.test(values.dueOn)
            ? "La fecha viene como número de Excel. Da a la columna formato de texto y escríbela como 2026-11-20 o 20/11/2026."
            : "No se entiende la fecha. Escríbela como 2026-11-20 o 20/11/2026 (día/mes/año).",
        );
      }
    }
    let priority: "NORMAL" | "URGENT" | null = null;
    if (values.priority !== undefined) {
      const folded = foldName(values.priority);
      priority =
        folded === "urgente" || folded === "alta"
          ? "URGENT"
          : folded === "normal"
            ? "NORMAL"
            : null;
      if (!priority) {
        issue("priority", "Escribe «Urgente» o «Normal», o déjala vacía.");
      }
    }
    if (draft) {
      const normalized: Partial<Record<HeaderKey, string | null>> = {
        recipient: values.recipient,
        dueOn: values.dueOn === undefined ? undefined : dueOn,
        priority: values.priority === undefined ? undefined : priority,
        address: values.address,
        note: values.note,
      };
      for (const key of HEADER_KEYS) {
        const value = normalized[key];
        if (value === undefined || value === null) continue;
        const first = draft.header[key];
        if (!first) {
          draft.header[key] = { value, row };
        } else if (
          key === "recipient"
            ? foldName(value) !== foldName(first.value)
            : value !== first.value
        ) {
          issue(
            key,
            `No coincide con la fila ${first.row} del mismo pedido. Deja la celda vacía o escribe lo mismo.`,
          );
        }
      }
    }

    const sku = cell("sku");
    const barcode = cell("barcode");
    let product: OutboundImportProduct | undefined;
    if (sku === "" && barcode === "") {
      issue(
        mapping.sku !== undefined ? "sku" : "barcode",
        "Escribe la clave o el código de barras del producto.",
      );
    } else {
      const fromSku = sku === "" ? undefined : bySku.get(foldName(sku));
      const fromBarcode = barcode === "" ? undefined : byBarcode.get(barcode);
      if (sku !== "" && !fromSku) {
        issue("sku", `No hay un producto con la clave «${sku.slice(0, 64)}».`);
      } else if (barcode !== "" && !fromBarcode) {
        issue("barcode", "No hay un producto con ese código de barras.");
      } else if (fromSku && fromBarcode && fromSku.id !== fromBarcode.id) {
        issue(
          "barcode",
          `Ese código de barras es de ${fromBarcode.sku}, no de ${fromSku.sku}. Deja solo uno de los dos.`,
        );
      } else {
        product = fromSku ?? fromBarcode;
        if (product && product.status !== "ACTIVE") {
          issue(
            sku !== "" ? "sku" : "barcode",
            `${product.sku} está archivado. Reactívalo para pedirlo.`,
          );
          product = undefined;
        }
      }
    }

    const quantityText = cell("quantity");
    let quantity: string | null = null;
    if (quantityText === "") {
      issue("quantity", "Falta la cantidad.");
    } else {
      const read = normalizeDecimal(quantityText, options.decimalSeparator);
      if (!read.ok) {
        issue("quantity", read.error);
      } else if (product) {
        const parsed = parseQuantity(
          { unitCode: product.unitCode, quantityStep: product.quantityStep },
          read.value,
        );
        if (!parsed.ok) issue("quantity", parsed.error);
        else quantity = parsed.quantity.toString();
      }
    }

    if (draft && product) {
      const first = draft.products.get(product.id);
      if (first !== undefined) {
        issue(
          sku !== "" ? "sku" : "barcode",
          `${product.sku} ya está en la fila ${first} del mismo pedido. Suma las cantidades en una sola fila.`,
        );
      } else {
        draft.products.set(product.id, row);
        if (draft.products.size > OUTBOUND_MAX_LINES) {
          issue(
            "order",
            `Un pedido admite hasta ${OUTBOUND_MAX_LINES} productos.`,
          );
        }
      }
    }

    if (failed || !draft || !product || !quantity) {
      badRows.add(row);
      if (draft) draft.failed = true;
      continue;
    }
    draft.lines.push({
      row,
      productId: product.id,
      sku: product.sku,
      productName: product.name,
      unitCode: product.unitCode,
      quantity,
    });
  }

  const orders: ImportedOutboundOrder[] = [];
  let invalidRows = badRows.size;
  for (const draft of drafts.values()) {
    if (!draft.failed && !draft.header.recipient) {
      draft.failed = true;
      const index = mapping.recipient;
      issues.push({
        row: draft.row,
        column: "recipient",
        header:
          (index !== undefined && headers[index]) || headerOf("recipient"),
        value: "",
        message: `Falta el destinatario del pedido «${draft.order}». Escríbelo en su primera fila.`,
      });
    }
    if (draft.failed) {
      // Rows that were fine on their own fail with their order.
      invalidRows += draft.rows.filter((row) => !badRows.has(row)).length;
      continue;
    }
    const { header } = draft;
    orders.push({
      row: draft.row,
      order: draft.order,
      sourceKey: draft.sourceKey,
      recipient: header.recipient!.value,
      dueOn: header.dueOn?.value ?? null,
      priority: header.priority?.value === "URGENT" ? "URGENT" : "NORMAL",
      address: header.address?.value ?? null,
      note: header.note?.value ?? null,
      lines: draft.lines,
    });
  }
  issues.sort((a, b) => a.row - b.row);
  return { orders, issues, invalidRows };
}

// ── Template ─────────────────────────────────────────────────────────────

export type OutboundTemplate = {
  name: string;
  contentType: string;
  bytes: Buffer;
};

/** The template of a file of outbound orders: titles, examples and help. */
export async function buildOutboundTemplate(
  actor: InventoryActor,
  format: "xlsx" | "csv",
): Promise<OutboundTemplate> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.outbound.create",
  );
  const headers = OUTBOUND_IMPORT_COLUMNS.map((column) => column.header);
  const examples: Cell[][] = [
    OUTBOUND_IMPORT_COLUMNS.map((column) => column.example),
    ["OV-1001", "", "CAB-012", "", "10", "", "", "", ""],
    [
      "OV-1002",
      "Sucursal Centro",
      "TOR-001",
      "",
      "100",
      "21/11/2026",
      "Urgente",
      "Av. Juárez 15",
      "Entregar por la mañana",
    ],
  ];
  if (format === "csv") {
    return {
      name: "plantilla-pedidos.csv",
      contentType: "text/csv; charset=utf-8",
      bytes: buildCsv([headers, ...examples]),
    };
  }
  const instructions: Cell[][] = [
    ["Cómo llenar el archivo de pedidos"],
    [
      "Cada fila de la hoja «Pedidos» es un producto de un pedido. Las filas con el mismo «Pedido» forman un solo pedido. Borra las filas de ejemplo y no cambies los títulos.",
    ],
    [
      "Destinatario, fecha, prioridad, dirección y notas son del pedido: basta escribirlos en su primera fila.",
    ],
    [
      "El «Pedido» evita duplicados: un pedido que ya se importó no se vuelve a crear.",
    ],
    ["Se crean como borradores: nada se aparta hasta que liberes cada pedido."],
    [
      "Guarda todas las celdas como texto, también la fecha. Decimales con punto (2.75), sin separador de miles.",
    ],
    [""],
    ["Columna", "¿Obligatoria?", "Qué poner", "Ejemplo"],
    ...OUTBOUND_IMPORT_COLUMNS.map((column): Cell[] => [
      column.header,
      column.required
        ? "Sí"
        : column.key === "sku" || column.key === "barcode"
          ? "Una de las dos"
          : "No",
      column.help,
      column.example,
    ]),
  ];
  return {
    name: "plantilla-pedidos.xlsx",
    contentType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    bytes: buildXlsx([
      { name: "Pedidos", rows: [headers, ...examples] },
      { name: "Instrucciones", rows: instructions },
    ]),
  };
}

// ── Upload ───────────────────────────────────────────────────────────────

/** Titles and data of what was read: the first row with text is the titles. */
function shape(rows: string[][]) {
  const headerIndex = rows.findIndex((row) => row.some((cell) => cell !== ""));
  if (headerIndex < 0) return null;
  const data = rows
    .slice(headerIndex + 1)
    .map((cells, offset) => ({ row: headerIndex + 2 + offset, cells }))
    .filter(({ cells }) => cells.some((cell) => cell !== ""));
  return { headers: rows[headerIndex]!, data };
}

export type StartOutboundImportResult =
  | { ok: true; importId: string }
  | { ok: false; reason: "separator" | "file" | "content"; error: string };

/**
 * Receives a file of outbound orders: keeps it as a private file of the
 * company and finds its columns. A file that cannot be read, or that lacks
 * a column, is not kept. Nothing is created here.
 */
export async function startOutboundImport(
  actor: InventoryActor,
  input: { name: string; bytes: Uint8Array; decimalSeparator: unknown },
): Promise<StartOutboundImportResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.outbound.create",
  );
  const separator = input.decimalSeparator;
  if (separator !== "." && separator !== ",") {
    return {
      ok: false,
      reason: "separator",
      error: "Dinos cómo vienen escritos los decimales en tu archivo.",
    };
  }
  const stored = await storeFile(actor, {
    purpose: "outbound_source",
    name: input.name,
    bytes: input.bytes,
  });
  if (!stored.ok) return { ok: false, reason: "file", error: stored.error };

  const refuse = async (error: string): Promise<StartOutboundImportResult> => {
    await deleteFile(actor, stored.fileId);
    return { ok: false, reason: "content", error };
  };
  const content = readSpreadsheet(input.name, input.bytes);
  if (!content.ok) return refuse(content.error);
  const table = shape(content.rows);
  if (!table || table.data.length === 0) {
    return refuse(
      "El archivo solo tiene títulos o está vacío. Agrega al menos una fila debajo de los títulos.",
    );
  }
  if (table.data.length > OUTBOUND_IMPORT_MAX_ROWS) {
    return refuse(
      `El archivo tiene más de ${OUTBOUND_IMPORT_MAX_ROWS.toLocaleString("es-MX")} filas. Divídelo en varios.`,
    );
  }
  const { missing } = matchOutboundColumns(table.headers);
  if (missing.length > 0) {
    return refuse(
      `No encontramos ${missing.length === 1 ? "la columna" : "las columnas"} ${missing.map((title) => `«${title}»`).join(", ")} en la primera fila con texto. Usa los títulos de la plantilla.`,
    );
  }
  const importId = newId();
  await forOrganization(organizationId).outboundImport.create({
    data: {
      id: importId,
      organizationId,
      fileId: stored.fileId,
      decimalSeparator: separator,
      dataRows: table.data.length,
      createdByUserId: userId,
    },
  });
  return { ok: true, importId };
}

// ── Check and review ─────────────────────────────────────────────────────

const CHUNK = 500;

export const OUTBOUND_IMPORT_STATUS_LABELS = {
  READY: "Lista para confirmar",
  CONFIRMED: "Pedidos creados",
  CANCELLED: "Cancelada",
} as const;

export type OutboundImportStatus = keyof typeof OUTBOUND_IMPORT_STATUS_LABELS;

type ImportFailure = {
  ok: false;
  reason: "not_found" | "file";
  error: string;
};

type CheckedOutboundImport = {
  ok: true;
  importId: string;
  status: OutboundImportStatus;
  fileName: string;
  totalRows: number;
  result: OutboundRowsValidation;
};

type Client = ReturnType<typeof forOrganization>;

/** Imported orders of the company with these keys: number by key. */
async function importedByKey(
  client: Pick<Client, "outboundOrder">,
  keys: string[],
): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  for (let start = 0; start < keys.length; start += CHUNK) {
    const rows = await client.outboundOrder.findMany({
      where: { sourceKey: { in: keys.slice(start, start + CHUNK) } },
      select: { sourceKey: true, number: true },
    });
    for (const row of rows) {
      if (row.sourceKey) found.set(row.sourceKey, row.number);
    }
  }
  return found;
}

/**
 * Reads the file of an import again and checks every row against the
 * catalog and the orders already imported, as they are now. Writes
 * nothing; review and confirmation both start from here.
 */
async function checkOutboundImport(
  actor: InventoryActor,
  importId: string,
): Promise<CheckedOutboundImport | ImportFailure> {
  const { organizationId } = actor;
  const client = forOrganization(organizationId);
  const row = await client.outboundImport.findFirst({
    where: { id: String(importId ?? "").slice(0, 36) },
    select: {
      id: true,
      status: true,
      fileId: true,
      decimalSeparator: true,
      file: { select: { name: true } },
    },
  });
  if (!row) {
    return {
      ok: false,
      reason: "not_found",
      error: "Esta importación ya no existe.",
    };
  }
  const file = await readStoredFile(organizationId, row.fileId);
  const content = file ? readSpreadsheet(file.name, file.bytes) : null;
  const table = content?.ok ? shape(content.rows) : null;
  if (!table) {
    return {
      ok: false,
      reason: "file",
      error:
        "El archivo de esta importación ya no se puede leer. Súbelo de nuevo.",
    };
  }
  const { mapping } = matchOutboundColumns(table.headers);
  const column = (key: OutboundColumnKey) => {
    const index = mapping[key];
    return index === undefined
      ? []
      : [
          ...new Set(
            table.data
              .map(({ cells }) => (cells[index] ?? "").trim())
              .filter((text) => text !== "" && text.length <= 64),
          ),
        ];
  };
  // Only the products the file names, in pieces: a catalog can be large.
  const found = new Map<string, OutboundImportProduct>();
  const load = async (field: "sku" | "barcode", values: string[]) => {
    for (let start = 0; start < values.length; start += CHUNK) {
      const chunk = values.slice(start, start + CHUNK);
      const products = await client.product.findMany({
        where:
          field === "sku" ? { sku: { in: chunk } } : { barcode: { in: chunk } },
        select: {
          id: true,
          sku: true,
          name: true,
          barcode: true,
          status: true,
          unitCode: true,
          quantityStep: true,
        },
      });
      for (const product of products) {
        found.set(product.id, {
          ...product,
          quantityStep: product.quantityStep.toString(),
        });
      }
    }
  };
  await load("sku", column("sku"));
  await load("barcode", column("barcode"));
  const imported = await importedByKey(
    client,
    column("order").map(outboundSourceKey),
  );

  return {
    ok: true,
    importId: row.id,
    status: row.status,
    fileName: row.file.name,
    totalRows: table.data.length,
    result: validateOutboundRows(table.data, {
      headers: table.headers,
      mapping,
      decimalSeparator: row.decimalSeparator === "," ? "," : ".",
      products: [...found.values()],
      imported,
    }),
  };
}

const MAX_ISSUES = 200;
const PREVIEW_ORDERS = 20;

export type OutboundImportReview =
  | {
      ok: true;
      id: string;
      status: OutboundImportStatus;
      fileName: string;
      createdAt: Date;
      /** What the file says now; only while it can still be confirmed. */
      check: {
        totalRows: number;
        invalidRows: number;
        issues: OutboundIssue[];
        issueCount: number;
        orders: number;
        lines: number;
        /** How the first orders are understood. */
        preview: {
          order: string;
          recipient: string;
          details: string;
          lines: string[];
        }[];
        ready: boolean;
      } | null;
      /** Once confirmed: the orders it created, newest number last. */
      created: {
        id: string;
        number: string;
        reference: string | null;
        recipient: string;
      }[];
    }
  | ImportFailure;

const PRIORITY_TEXT = { NORMAL: "Normal", URGENT: "Urgente" } as const;

/** An import of outbound orders with what its file says, or what it created. */
export async function reviewOutboundImport(
  actor: InventoryActor,
  importId: string,
): Promise<OutboundImportReview> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.outbound.read",
  );
  const row = await forOrganization(organizationId).outboundImport.findFirst({
    where: { id: String(importId ?? "").slice(0, 36) },
    select: {
      id: true,
      status: true,
      createdAt: true,
      file: { select: { name: true } },
      orders: {
        orderBy: { number: "asc" },
        select: { id: true, number: true, reference: true, recipient: true },
      },
    },
  });
  if (!row) {
    return {
      ok: false,
      reason: "not_found",
      error: "Esta importación ya no existe.",
    };
  }
  let check: Extract<OutboundImportReview, { ok: true }>["check"] = null;
  if (row.status === "READY") {
    const checked = await checkOutboundImport(actor, row.id);
    if (!checked.ok) return checked;
    const { orders, issues, invalidRows } = checked.result;
    check = {
      totalRows: checked.totalRows,
      invalidRows,
      issues: issues.slice(0, MAX_ISSUES),
      issueCount: issues.length,
      orders: orders.length,
      lines: orders.reduce((sum, order) => sum + order.lines.length, 0),
      preview: orders.slice(0, PREVIEW_ORDERS).map((order) => ({
        order: order.order,
        recipient: order.recipient,
        details: [
          order.dueOn ? `sale el ${formatExitDay(order.dueOn)}` : null,
          order.priority === "URGENT" ? PRIORITY_TEXT.URGENT : null,
        ]
          .filter(Boolean)
          .join(" · "),
        lines: order.lines.map(
          (line) =>
            `${formatStock(line.quantity, line.unitCode)} de ${line.productName} (${line.sku})`,
        ),
      })),
      ready: orders.length > 0 && invalidRows === 0,
    };
  }
  return {
    ok: true,
    id: row.id,
    status: row.status,
    fileName: row.file.name,
    createdAt: row.createdAt,
    check,
    created: row.orders.map((order) => ({
      id: order.id,
      number: formatOutboundNumber(order.number),
      reference: order.reference,
      recipient: order.recipient,
    })),
  };
}

// ── Confirm and cancel ───────────────────────────────────────────────────

export type ConfirmOutboundImportResult =
  | { ok: true; orders: number; repeated?: true }
  | { ok: false; reason: "not_found" | "not_ready" | "file"; error: string };

type ConfirmFailure = Extract<ConfirmOutboundImportResult, { ok: false }>;

class Rejected extends Error {
  constructor(readonly result: ConfirmFailure) {
    super("outbound import not confirmed");
  }
}

const NOT_READY =
  "Este archivo todavía tiene filas por corregir. Corrígelo y súbelo de nuevo.";

/**
 * Confirms a file of outbound orders: creates every draft of it in one
 * transaction, or none. Confirming it again answers `repeated`; an order
 * imported meanwhile by another file stops the whole confirmation.
 */
export async function confirmOutboundImport(
  actor: InventoryActor,
  importId: string,
): Promise<ConfirmOutboundImportResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.outbound.create",
  );
  // Read before the transaction (a whole file); the state of the import
  // and what may not be stale are decided inside, under the lock.
  const checked = await checkOutboundImport(actor, importId);
  if (!checked.ok) return checked;
  const { orders, invalidRows } = checked.result;
  const ready = orders.length > 0 && invalidRows === 0;
  // The orders leave from the warehouse of who confirms (WMS-18).
  const facility = await activeFacilityOf(
    forOrganization(organizationId),
    userId,
  );

  for (let attempt = 0; ; attempt++) {
    try {
      return await forOrganization(organizationId).$transaction(async (tx) => {
        // Two confirmations of the same file go one after the other.
        const [id] = await lockRows(tx, "outboundImport", [checked.importId]);
        const row = id
          ? await tx.outboundImport.findFirst({
              where: { id },
              select: { id: true, status: true, ordersCreated: true },
            })
          : null;
        if (!row) {
          throw new Rejected({
            ok: false,
            reason: "not_found",
            error: "Esta importación ya no existe.",
          });
        }
        if (row.status === "CONFIRMED") {
          return {
            ok: true as const,
            orders: row.ordersCreated,
            repeated: true as const,
          };
        }
        if (row.status === "CANCELLED") {
          throw new Rejected({
            ok: false,
            reason: "not_ready",
            error: "Esta importación se canceló. Sube el archivo de nuevo.",
          });
        }
        if (!ready) {
          throw new Rejected({
            ok: false,
            reason: "not_ready",
            error: NOT_READY,
          });
        }
        // Imported meanwhile by another file, or archived since the
        // check: nothing is created.
        const taken = await importedByKey(
          tx,
          orders.map((order) => order.sourceKey),
        );
        const productIds = [
          ...new Set(
            orders.flatMap((order) =>
              order.lines.map((line) => line.productId),
            ),
          ),
        ];
        const active = new Set<string>();
        for (let start = 0; start < productIds.length; start += CHUNK) {
          const rows = await tx.product.findMany({
            where: {
              id: { in: productIds.slice(start, start + CHUNK) },
              status: "ACTIVE",
            },
            select: { id: true },
          });
          for (const product of rows) active.add(product.id);
        }
        if (taken.size > 0 || productIds.some((id) => !active.has(id))) {
          throw new Rejected({
            ok: false,
            reason: "not_ready",
            error:
              "Algo cambió desde que revisaste el archivo (un pedido ya se importó o un producto se archivó). Revisa de nuevo.",
          });
        }

        const last = await tx.outboundOrder.findFirst({
          orderBy: { number: "desc" },
          select: { number: true },
        });
        let number = last?.number ?? 0;
        const orderRows: {
          id: string;
          organizationId: string;
          number: number;
          recipient: string;
          address: string | null;
          reference: string;
          note: string | null;
          dueOn: Date | null;
          priority: "NORMAL" | "URGENT";
          createdByUserId: string;
          importId: string;
          sourceKey: string;
          facilityId: string;
        }[] = [];
        const lineRows: {
          id: string;
          organizationId: string;
          orderId: string;
          lineNumber: number;
          productId: string;
          quantity: string;
          unitCode: string;
        }[] = [];
        for (const order of orders) {
          const orderId = newId();
          orderRows.push({
            id: orderId,
            organizationId,
            number: ++number,
            recipient: order.recipient,
            address: order.address,
            reference: order.order.slice(0, 120),
            note: order.note,
            dueOn: order.dueOn
              ? new Date(`${order.dueOn}T00:00:00.000Z`)
              : null,
            priority: order.priority,
            createdByUserId: userId,
            importId: row.id,
            sourceKey: order.sourceKey,
            facilityId: facility.id,
          });
          order.lines.forEach((line, index) =>
            lineRows.push({
              id: newId(),
              organizationId,
              orderId,
              lineNumber: index + 1,
              productId: line.productId,
              quantity: line.quantity,
              unitCode: line.unitCode,
            }),
          );
        }
        await tx.outboundOrder.createMany({ data: orderRows });
        for (let start = 0; start < lineRows.length; start += CHUNK) {
          await tx.outboundOrderLine.createMany({
            data: lineRows.slice(start, start + CHUNK),
          });
        }
        await tx.outboundImport.update({
          where: { id: row.id },
          data: {
            status: "CONFIRMED",
            ordersCreated: orders.length,
            confirmedAt: new Date(),
            confirmedByUserId: userId,
          },
        });
        await recordAuditEvent(tx, {
          organizationId,
          actorUserId: userId,
          action: "inventory.outbound_imported",
          target: { type: "outbound_import", id: row.id },
          metadata: {
            orders: orders.length,
            lines: lineRows.length,
            file: checked.fileName.slice(0, 160),
          },
        });
        return { ok: true as const, orders: orders.length };
      }, LOCKING_TRANSACTION);
    } catch (error) {
      if (error instanceof Rejected) return error.result;
      // An order written by hand took the same number at once: again. A
      // key taken by another file is caught by the check inside.
      if ((error as { code?: string }).code === "P2002" && attempt < 4) {
        continue;
      }
      throw error;
    }
  }
}

export type CancelOutboundImportResult =
  | { ok: true; repeated?: true }
  | { ok: false; reason: "not_found" | "not_allowed"; error: string };

/** Cancels a file that was not confirmed: nothing was created from it. */
export async function cancelOutboundImport(
  actor: InventoryActor,
  importId: string,
): Promise<CancelOutboundImportResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.outbound.create",
  );
  return forOrganization(organizationId).$transaction(async (tx) => {
    const [id] = await lockRows(tx, "outboundImport", [
      String(importId ?? "").slice(0, 36),
    ]);
    const row = id
      ? await tx.outboundImport.findFirst({
          where: { id },
          select: { id: true, status: true },
        })
      : null;
    if (!row) {
      return {
        ok: false as const,
        reason: "not_found" as const,
        error: "Esta importación ya no existe.",
      };
    }
    if (row.status === "CANCELLED")
      return { ok: true as const, repeated: true as const };
    if (row.status === "CONFIRMED") {
      return {
        ok: false as const,
        reason: "not_allowed" as const,
        error:
          "Sus pedidos ya se crearon. Cancela en cada pedido los que no quieras.",
      };
    }
    await tx.outboundImport.update({
      where: { id: row.id },
      data: { status: "CANCELLED" },
    });
    return { ok: true as const };
  }, LOCKING_TRANSACTION);
}

export type OutboundImportSummary = {
  id: string;
  fileName: string;
  status: OutboundImportStatus;
  dataRows: number;
  ordersCreated: number;
  createdAt: Date;
};

/** The latest files of outbound orders of the company. */
export async function listOutboundImports(
  actor: InventoryActor,
): Promise<OutboundImportSummary[]> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.outbound.read",
  );
  const rows = await forOrganization(
    actor.organizationId,
  ).outboundImport.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 10,
    select: {
      id: true,
      status: true,
      dataRows: true,
      ordersCreated: true,
      createdAt: true,
      file: { select: { name: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    fileName: row.file.name,
    status: row.status,
    dataRows: row.dataRows,
    ordersCreated: row.ordersCreated,
    createdAt: row.createdAt,
  }));
}
