import "server-only";

import { db, forOrganization } from "@/server";

import { listAuditEvents } from "./events";

/**
 * Company audit trail for people (USR-11): each event with a sentence in
 * Spanish, who did it and to whom. Names are read at display time; the
 * event itself keeps only ids, so the record never changes.
 */

/** What each company action means, as shown in the audit screen. */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  "organization.created": "Creó la empresa",
  "ownership.transfer_offered": "Ofreció transferir la titularidad",
  "ownership.transfer_cancelled": "Canceló la transferencia de titularidad",
  "ownership.transferred": "Aceptó la titularidad de la empresa",
  "inventory.adjusted": "Ajustó existencias",
  "inventory.count_applied": "Aplicó un conteo físico",
  "inventory.import_confirmed": "Confirmó una importación de productos",
  "inventory.import_applied": "Se aplicó una importación de productos",
  "inventory.import_cancelled": "Canceló una importación de productos",
  "inventory.exit_import_confirmed": "Confirmó una importación de salidas",
  "inventory.exit_import_applied": "Se registraron las salidas de un archivo",
  "inventory.exit_import_cancelled": "Canceló una importación de salidas",
  "inventory.exit_import_failed":
    "Una importación de salidas se detuvo antes de terminar",
  "inventory.import_failed":
    "Una importación de productos se detuvo antes de terminar",
  "inventory.export_created": "Exportó información a un archivo",
  "inventory.reversed": "Reversó un movimiento",
  "inventory.task_cancelled": "Canceló una tarea de traslado",
  "inventory.status_changed": "Cambió el estado de existencias",
  "inventory.lot_expiry_changed": "Corrigió la caducidad de un lote",
  "inventory.outbound_cancelled": "Canceló un pedido de salida",
  "inventory.outbound_pack_short": "Registró un faltante al empacar un pedido",
  "inventory.outbound_packed": "Terminó de empacar un pedido",
  "inventory.shipment_dispatched": "Confirmó la salida de un embarque",
  "inventory.shipment_cancelled": "Canceló un embarque",
  "inventory.shipment_exported": "Descargó el PDF de un embarque",
  "inventory.customer_return_received": "Registró una devolución de cliente",
  "inventory.customer_return_decided":
    "Decidió qué pasa con lo devuelto por un cliente",
  "inventory.labels_printed": "Imprimió etiquetas",
  "inventory.facility_transfer_sent": "Envió un traslado entre almacenes",
  "inventory.facility_transfer_received": "Recibió un traslado entre almacenes",
  "inventory.facility_transfer_resolved":
    "Resolvió lo que no llegó de un traslado entre almacenes",
  "inventory.facility_transfer_cancelled":
    "Canceló un traslado entre almacenes",
  "inventory.facility_transfer_exported":
    "Descargó el PDF de un traslado entre almacenes",
  "inventory.outbound_imported": "Importó pedidos de salida desde un archivo",
  "inventory.replenishment_rule_saved":
    "Guardó una regla de reposición de surtido",
  "inventory.replenishment_rule_removed":
    "Quitó una regla de reposición de surtido",
  "settings.changed": "Cambió un ajuste de operación",
  "facility.created": "Creó un almacén",
  "facility.updated": "Cambió un almacén",
  "facility.archived": "Archivó un almacén",
  "location.staging_changed": "Cambió la ubicación de preparación",
  "inventory.task_released": "Liberó una tarea de traslado con problema",
  "product_supplier.created": "Vinculó un producto con un proveedor",
  "product_supplier.updated":
    "Cambió el vínculo de un producto con un proveedor",
  "purchase_order.created": "Empezó una orden de compra",
  "purchase_order.sent": "Confirmó una orden de compra como enviada",
  "purchase_order.cancelled": "Canceló una orden de compra",
  "purchase_order.closed": "Cerró una orden de compra con faltante",
  "purchase_order.exported": "Descargó el PDF de una orden de compra",
  "purchase_order.received": "Recibió mercancía de una orden de compra",
  "purchase_order.returned": "Devolvió mercancía al proveedor",
  "purchasing.report_exported": "Exportó un reporte de compras a un archivo",
  "customer.created": "Registró un cliente",
  "customer.email_updated": "Cambió el correo de un cliente",
  "purchase_order.delivery_requested":
    "Pidió enviar una orden de compra por correo",
  "purchase_order.delivered": "Se envió una orden de compra por correo",
  "purchase_order.delivery_failed":
    "No se pudo enviar una orden de compra por correo",
  "supplier.created": "Agregó un proveedor",
  "supplier.updated": "Cambió los datos de un proveedor",
  "product.created": "Creó un producto",
  "product.updated": "Cambió la ficha de un producto",
  "presentation.created": "Agregó una presentación a un producto",
  "presentation.updated": "Cambió el contenido de una presentación",
  "product.archived": "Archivó un producto",
  "product.reactivated": "Reactivó un producto",
  "location.created": "Creó una ubicación",
  "location.renamed": "Cambió el nombre de una ubicación",
  "location.moved": "Movió una ubicación",
  "location.archived": "Archivó una ubicación",
  "location.restored": "Reactivó una ubicación",
  "location.details_changed": "Cambió el código o el uso de una ubicación",
  "location.limits_changed":
    "Cambió la capacidad o las restricciones de una ubicación",
  "location.levels_changed": "Cambió los niveles de ubicación de un almacén",
  "plan.provisioned": "Se asignó el plan de la empresa",
  "payment.recorded": "Se registró un pago",
  "plan.purchased": "Compró el plan en línea",
  "payment.reversed": "Se anuló un pago",
  "support.granted": "Permitió el acceso de soporte",
  "support.revoked": "Quitó el acceso de soporte",
  "support.entered": "Soporte entró a la empresa (solo lectura)",
  "support.left": "Soporte salió de la empresa",
  "module.activated": "Se activó un módulo",
  "module.deactivated": "Se desactivó un módulo",
  "team.invitation_created": "Invitó a una persona",
  "team.invitation_resent": "Reenvió una invitación",
  "team.invitation_cancelled": "Canceló una invitación",
  "team.invitation_accepted": "Aceptó la invitación y entró al equipo",
  "team.roles_changed": "Cambió los roles de una persona",
  "team.scope_changed": "Cambió los almacenes o zonas de una persona",
  "team.member_disabled": "Desactivó a una persona",
  "team.member_reactivated": "Reactivó a una persona",
  "team.session_revoked": "Cerró una sesión de una persona",
  "team.sessions_revoked":
    "Cerró todas las sesiones de una persona en la empresa",
  "terminal.registered": "Registró una terminal compartida",
  "terminal.removed": "Quitó una terminal compartida",
  "terminal.locked": "Una terminal se bloqueó por PIN incorrectos",
  "terminal.cloned":
    "El sistema quitó una terminal porque se usó una copia de su cookie",
  "pin.locked": "Se bloqueó el PIN de una persona por intentos fallidos",
  "pin.set": "Puso su PIN para las terminales",
  "pin.changed": "Cambió su PIN para las terminales",
  "pin.removed": "Quitó su PIN para las terminales",
  "inventory.count_program_created": "Creó un programa de conteo cíclico",
  "inventory.count_program_changed": "Cambió un programa de conteo cíclico",
  "approval.rule_changed": "Cambió una regla de aprobación",
  "approval.requested": "Pidió una autorización",
  "process.draft_saved": "Guardó el borrador de un proceso",
  "process.published": "Publicó una versión de un proceso",
  "approval.approved": "Autorizó una solicitud",
  "approval.rejected": "Rechazó una solicitud",
  "approval.cancelled": "Retiró una solicitud de autorización",
  "approval.expired": "Una solicitud de autorización venció",
  "inventory.wave_created": "Creó una ola de surtido",
  "inventory.wave_cancelled": "Canceló una ola de surtido",
  "purchase_request.created": "Empezó una solicitud de compra",
  "purchase_request.submitted": "Envió una solicitud de compra",
  "purchase_request.approved": "Una solicitud de compra pasó a Compras",
  "purchase_request.rejected": "Rechazó una solicitud de compra",
  "purchase_request.cancelled": "Canceló una solicitud de compra",
  "purchase_request.converted": "Convirtió una solicitud de compra en orden",
  "inventory.incident_reported": "Reportó una incidencia",
  "inventory.incident_attended": "Tomó una incidencia para atenderla",
  "inventory.incident_resolved": "Resolvió una incidencia",
  "inventory.incident_dismissed": "Descartó una incidencia",
  "inventory.equipment_type_created": "Agregó un tipo de equipo",
  "inventory.equipment_type_changed": "Cambió el nombre de un tipo de equipo",
  "inventory.equipment_type_archived": "Archivó un tipo de equipo",
  "inventory.equipment_type_restored": "Volvió a usar un tipo de equipo",
  "inventory.equipment_created": "Registró un equipo",
  "inventory.equipment_changed": "Cambió los datos de un equipo",
  "inventory.equipment_out_of_service": "Dejó un equipo fuera de servicio",
  "inventory.equipment_in_service": "Puso un equipo en servicio",
  "inventory.equipment_retired": "Dio de baja un equipo",
  "inventory.equipment_maintained": "Registró un mantenimiento de un equipo",
  "custom_field.created": "Agregó un campo personalizado",
  "custom_field.changed": "Cambió un campo personalizado",
  "custom_field.archived": "Archivó un campo personalizado",
  "custom_field.restored": "Reactivó un campo personalizado",
  "api_key.created": "Creó una llave de la API",
  "api_key.changed": "Cambió una llave de la API",
  "api_key.revoked": "Revocó una llave de la API",
  "webhook.created": "Agregó un destino de webhooks",
  "webhook.changed": "Cambió un destino de webhooks",
  "webhook.paused": "Pausó un destino de webhooks",
  "webhook.resumed": "Reanudó un destino de webhooks",
  "webhook.secret_rotated": "Cambió el secreto de un destino de webhooks",
  "webhook.removed": "Quitó un destino de webhooks",
};

export function describeAuditAction(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

export type AuditTrailEntry = {
  id: string;
  action: string;
  label: string;
  /** Null when the system made the change or the account no longer exists. */
  actorName: string | null;
  /** Person the change was about, when there is one. */
  targetName: string | null;
  /** Invited address, for invitation events. */
  email: string | null;
  /** Role ids involved: previous and resulting, or the invited ones. */
  rolesFrom: string[];
  rolesTo: string[];
  reason: string | null;
  /**
   * What the event was about, from its metadata: «Clave: TOR-001»,
   * «Archivo: catalogo.xlsx», «Precio: 10 → 12». Only known keys, in a
   * fixed order; internal ids and codes are never shown.
   */
  facts: string[];
  createdAt: Date;
};

/** Metadata keys shown in the audit screen, with their label, in order. */
const FACT_LABELS: readonly (readonly [string, string])[] = [
  ["orden", "Orden"],
  ["proveedor", "Proveedor"],
  ["correo", "Correo"],
  ["sku", "Clave"],
  ["producto", "Producto"],
  ["name", "Nombre"],
  ["nombre", "Nombre"],
  ["presentation", "Presentación"],
  ["content", "Contenido"],
  ["path", "Ruta"],
  ["before", "Antes"],
  ["after", "Ahora"],
  ["module", "Módulo"],
  ["modules", "Módulos"],
  ["productLimit", "Cupo de productos"],
  ["users", "Personas"],
  ["ubicacion", "Ubicación"],
  ["capacidad", "Capacidad"],
  ["admite", "Solo admite"],
  ["antes", "Había"],
  ["contado", "Contado"],
  ["diferencia", "Diferencia"],
  ["productosContados", "Productos contados"],
  ["productosAjustados", "Productos ajustados"],
  ["contenido", "Contenido"],
  ["formato", "Formato"],
  ["desde", "Desde"],
  ["hasta", "Hasta"],
  ["archivo", "Archivo"],
  ["filas", "Filas"],
  ["nuevos", "Nuevos"],
  ["actualizados", "Actualizados"],
  ["reactivados", "Reactivados"],
  ["productos", "Productos"],
  ["productosImportados", "Productos importados"],
  ["sinImportar", "Sin importar"],
  ["salidasRegistradas", "Salidas registradas"],
  ["yaImportadas", "Ya importadas antes"],
  ["conProblemas", "Con problemas"],
  ["lugaresApartados", "Lugares apartados del plan"],
  ["lugaresDevueltos", "Lugares devueltos al plan"],
  ["cambios", "Cambió"],
  ["venta", "Venta"],
  ["pedido", "Pedido"],
  ["cotizacion", "Cotización"],
  ["cliente", "Cliente"],
  ["porcentaje", "Descuento"],
  ["fondo", "Fondo"],
  ["importe", "Importe"],
  ["efectivo", "Efectivo"],
  ["tarjeta", "Tarjeta"],
  ["transferencia", "Transferencia"],
  ["que", "Qué"],
  ["etiquetas", "Etiquetas"],
  ["tipo", "Tipo"],
  ["resumen", "Qué se pidió"],
  ["resultado", "Resultado"],
  ["autorizadoPor", "Autorizó"],
  ["reglaAntes", "Antes"],
  ["reglaAhora", "Ahora"],
];

const shown = (value: unknown): string | null =>
  typeof value === "string"
    ? value.trim() || null
    : typeof value === "number" && Number.isFinite(value)
      ? value.toLocaleString("es-MX")
      : Array.isArray(value)
        ? strings(value).join(", ") || null
        : null;

/** The metadata of an event as short lines for people. */
export function describeAuditFacts(metadata: unknown): string[] {
  const data = record(metadata);
  const facts: string[] = [];
  for (const [key, label] of FACT_LABELS) {
    const value = shown(data[key]);
    if (value !== null) facts.push(`${label}: ${value}`);
  }
  // Field by field changes of a record: { Nombre: { antes, ahora } }.
  for (const [field, change] of Object.entries(record(data.changes))) {
    const { antes, ahora } = record(change);
    facts.push(
      `${field}: ${shown(antes) ?? "(vacío)"} → ${shown(ahora) ?? "(vacío)"}`,
    );
  }
  return facts;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Newest events of the company first, ready to show. */
export async function listAuditTrail(
  organizationId: string,
  options: { limit?: number; before?: Date } = {},
): Promise<AuditTrailEntry[]> {
  const events = await listAuditEvents(
    forOrganization(organizationId),
    options,
  );
  const invitationIds = events
    .filter((e) => e.targetType === "invitation" && e.targetId)
    .map((e) => e.targetId!);
  const userIds = new Set<string>();
  for (const event of events) {
    if (event.actorUserId) userIds.add(event.actorUserId);
    if (event.targetType === "user" && event.targetId) {
      userIds.add(event.targetId);
    }
  }
  const [users, invitations] = await Promise.all([
    db.user.findMany({
      where: { id: { in: [...userIds] } },
      select: { id: true, name: true },
    }),
    forOrganization(organizationId).invitation.findMany({
      where: { id: { in: invitationIds } },
      select: { id: true, email: true, roles: true },
    }),
  ]);
  const names = new Map(users.map((u) => [u.id, u.name]));
  const invited = new Map(invitations.map((i) => [i.id, i]));

  return events.map((event) => {
    const metadata = record(event.metadata);
    const invitation =
      event.targetType === "invitation" && event.targetId
        ? invited.get(event.targetId)
        : undefined;
    const rolesTo = strings(
      metadata.to ??
        metadata.roles ??
        metadata.previousOwnerRoles ??
        invitation?.roles,
    );
    return {
      id: event.id,
      action: event.action,
      label: describeAuditAction(event.action),
      actorName: event.actorUserId
        ? (names.get(event.actorUserId) ?? null)
        : null,
      targetName:
        event.targetType === "user" && event.targetId
          ? (names.get(event.targetId) ?? null)
          : null,
      email:
        typeof metadata.email === "string"
          ? metadata.email
          : (invitation?.email ?? null),
      rolesFrom: strings(metadata.from),
      rolesTo,
      reason: event.reason,
      facts: describeAuditFacts(metadata),
      createdAt: event.createdAt,
    };
  });
}
