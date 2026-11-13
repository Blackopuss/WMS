import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// PLT-15: every server action is an HTTP endpoint anyone can call with any
// body. Each one is reviewed here: what it takes from the client, where
// the user/company come from, and which test proves it cannot reach other
// people's data. A new action fails this test until it is added.

type Review = {
  /** What the client can send. */
  input: string;
  /** Where the account/company used by the action come from. */
  identity: string;
  /** Test that covers the cross-account / cross-company case. */
  coveredBy: string;
};

const REVIEWED: Record<string, Review> = {
  packAction: {
    input:
      "producto y tarima (fijados por la página), ubicación y lote elegidos, etiqueta y tipo de una tarima nueva, cantidad y series",
    identity:
      "sesión y empresa activa (requireOrganizationContext); producto, ubicación y tarima se bloquean solo en esa empresa y dentro del alcance de la persona",
    coveredBy: "tests/inventory/containers.int.test.ts",
  },
  moveContainerAction: {
    input:
      "tarima (fijada por la página, o su etiqueta escaneada), etiqueta del lugar, clave de confirmación y la aceptación de un aviso de capacidad",
    identity:
      "sesión y empresa activa (requireOrganizationContext); la tarima y el lugar se buscan solo en esa empresa y dentro del alcance de la persona",
    coveredBy: "tests/inventory/containers.int.test.ts",
  },
  unpackAction: {
    input:
      "tarima (fijada por la página), renglón que se saca, cantidad y series",
    identity:
      "sesión y empresa activa (requireOrganizationContext); la tarima se bloquea solo en esa empresa y dentro del alcance de la persona",
    coveredBy: "tests/inventory/containers.int.test.ts",
  },
  closeContainerAction: {
    input: "tarima (fijada por la página)",
    identity:
      "sesión y empresa activa (requireOrganizationContext); la tarima se bloquea solo en esa empresa y dentro del alcance de la persona",
    coveredBy: "tests/inventory/containers.int.test.ts",
  },
  changeLotExpiryAction: {
    input:
      "id del lote (fijado por la página), caducidad nueva (o vacía) y motivo",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el lote se busca solo en esa empresa",
    coveredBy: "tests/inventory/lots.int.test.ts",
  },
  createOutboundAction: {
    input:
      "destinatario, referencia, dirección, día de salida, prioridad e indicaciones",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el pedido nace en esa empresa",
    coveredBy: "tests/inventory/outbound-orders.int.test.ts",
  },
  addOutboundLineAction: {
    input:
      "id del pedido (fijado por la página), nombre, clave o código de barras (o la clave elegida entre varios parecidos) y cantidad",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el producto se busca y el pedido se bloquea solo en esa empresa",
    coveredBy: "tests/inventory/outbound-orders.int.test.ts",
  },
  removeOutboundLineAction: {
    input: "id del pedido y de la línea",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el pedido se bloquea solo en esa empresa",
    coveredBy: "tests/inventory/outbound-orders.int.test.ts",
  },
  releaseOutboundAction: {
    input: "id del pedido y si se libera con lo que hay",
    identity:
      "sesión y empresa activa (requireOrganizationContext); productos y pedido se bloquean solo en esa empresa",
    coveredBy: "tests/inventory/outbound-orders.int.test.ts",
  },
  cancelOutboundAction: {
    input: "id del pedido y el motivo",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el pedido se bloquea solo en esa empresa",
    coveredBy: "tests/inventory/outbound-orders.int.test.ts",
  },
  startPackingAction: {
    input: "id del pedido",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el pedido y sus bultos se bloquean solo en esa empresa y dentro del alcance de la persona",
    coveredBy: "tests/inventory/packing.int.test.ts",
  },
  packScanAction: {
    input:
      "id del pedido, lo escaneado (serie, clave, código de barras o lote) y la cantidad",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el pedido y sus bultos se bloquean solo en esa empresa y dentro del alcance de la persona",
    coveredBy: "tests/inventory/packing.int.test.ts",
  },
  unpackPackageAction: {
    input: "id del pedido, del bulto y del renglón, cantidad y series",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el pedido y sus bultos se bloquean solo en esa empresa y dentro del alcance de la persona",
    coveredBy: "tests/inventory/packing.int.test.ts",
  },
  sealPackageAction: {
    input: "id del pedido y del bulto, tipo y peso",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el pedido y sus bultos se bloquean solo en esa empresa y dentro del alcance de la persona",
    coveredBy: "tests/inventory/packing.int.test.ts",
  },
  reopenPackageAction: {
    input: "id del pedido y del bulto",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el pedido y sus bultos se bloquean solo en esa empresa y dentro del alcance de la persona",
    coveredBy: "tests/inventory/packing.int.test.ts",
  },
  reportPackShortageAction: {
    input: "id del pedido y de la línea, y el motivo",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el pedido y sus bultos se bloquean solo en esa empresa y dentro del alcance de la persona",
    coveredBy: "tests/inventory/packing.int.test.ts",
  },
  finishPackingAction: {
    input: "id del pedido",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el pedido y sus bultos se bloquean solo en esa empresa y dentro del alcance de la persona",
    coveredBy: "tests/inventory/packing.int.test.ts",
  },
  createShipmentAction: {
    input:
      "ids de los pedidos marcados y los datos del transporte (transportista, guía, placas, quién se lo lleva, notas)",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el embarque y sus pedidos se bloquean solo en esa empresa y dentro del alcance de la persona",
    coveredBy: "tests/inventory/shipments.int.test.ts",
  },
  updateShipmentAction: {
    input: "id del embarque (fijado por la página) y los datos del transporte",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el embarque y sus pedidos se bloquean solo en esa empresa y dentro del alcance de la persona",
    coveredBy: "tests/inventory/shipments.int.test.ts",
  },
  addShipmentOrdersAction: {
    input: "id del embarque (fijado por la página) e ids de los pedidos",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el embarque y sus pedidos se bloquean solo en esa empresa y dentro del alcance de la persona",
    coveredBy: "tests/inventory/shipments.int.test.ts",
  },
  removeShipmentOrderAction: {
    input: "id del embarque y del pedido",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el embarque y sus pedidos se bloquean solo en esa empresa y dentro del alcance de la persona",
    coveredBy: "tests/inventory/shipments.int.test.ts",
  },
  cancelShipmentAction: {
    input: "id del embarque y el motivo",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el embarque y sus pedidos se bloquean solo en esa empresa y dentro del alcance de la persona",
    coveredBy: "tests/inventory/shipments.int.test.ts",
  },
  dispatchShipmentAction: {
    input: "id del embarque",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el embarque y sus pedidos se bloquean solo en esa empresa y dentro del alcance de la persona",
    coveredBy: "tests/inventory/shipments.int.test.ts",
  },
  checkShipmentAction: {
    input: "id del embarque",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el embarque se busca solo en esa empresa y dentro del alcance de la persona",
    coveredBy: "tests/inventory/shipments.int.test.ts",
  },
  receiveReturnAction: {
    input:
      "pedido o producto (fijados por la página), por renglón cantidad y series, lote y caducidad sin pedido, quién devuelve, motivo, notas, ubicación, clave de confirmación y la aceptación del aviso de capacidad",
    identity:
      "sesión y empresa activa (requireOrganizationContext); pedido, productos y ubicación se bloquean solo en esa empresa, el pedido dentro del alcance de la persona y la ubicación en su almacén activo",
    coveredBy: "tests/inventory/customer-returns.int.test.ts",
  },
  checkCustomerReturnAction: {
    input: "clave de confirmación",
    identity:
      "sesión y empresa activa (requireOrganizationContext); solo devoluciones de esa persona en esa empresa y dentro de su alcance",
    coveredBy: "tests/inventory/customer-returns.int.test.ts",
  },
  decideReturnAction: {
    input:
      "devolución y renglón (fijados por la página), resultado, cantidad, motivo, destino, series, clave de confirmación y la aceptación del aviso de capacidad",
    identity:
      "sesión y empresa activa (requireOrganizationContext); la devolución se bloquea solo en esa empresa y dentro del alcance de la persona; los permisos de cambio de estado se comprueban en el servicio",
    coveredBy: "tests/inventory/customer-returns.int.test.ts",
  },
  checkDecisionAction: {
    input: "clave de confirmación",
    identity:
      "sesión y empresa activa (requireOrganizationContext); solo movimientos de esa persona en esa empresa",
    coveredBy: "tests/inventory/customer-returns.int.test.ts",
  },
  changeStatusAction: {
    input:
      "id del producto (fijado por la página), ubicación y estado de origen, estado nuevo, ubicación donde queda (WMS-22B), cantidad, motivo, clave de confirmación y la aceptación del aviso de capacidad",
    identity:
      "sesión y empresa activa (requireOrganizationContext); producto y ubicaciones se bloquean solo en esa empresa",
    coveredBy:
      "tests/inventory/status-change.int.test.ts, tests/inventory/capacity.int.test.ts",
  },
  createTaskAction: {
    input:
      "id del producto, ubicaciones de origen y destino, cantidad, prioridad, a quién se asigna, una nota y la aceptación del aviso de capacidad (WMS-22B)",
    identity:
      "sesión y empresa activa (requireOrganizationContext); producto, ubicaciones y la persona asignada se buscan solo en esa empresa",
    coveredBy:
      "tests/inventory/tasks.int.test.ts, tests/inventory/capacity.int.test.ts",
  },
  taskStepAction: {
    input: "id de la tarea y el paso (tomar, recoger o entregar)",
    identity:
      "sesión y empresa activa (requireOrganizationContext); la tarea se bloquea solo en esa empresa y debe ser de esa persona",
    coveredBy: "tests/inventory/tasks.int.test.ts",
  },
  pickUpSerialsAction: {
    input:
      "id de la tarea de traslado y las series de las unidades que se toman (WMS-21B)",
    identity:
      "sesión y empresa activa (requireOrganizationContext); producto, pedido y tarea se bloquean solo en esa empresa y la tarea debe ser de esa persona; las series se buscan solo entre las unidades de esa empresa",
    coveredBy: "tests/inventory/serials.int.test.ts",
  },
  putawayAction: {
    input:
      "id de la tarea de acomodo, la ubicación donde quedó (código, ruta o nombre, escaneado o escrito) y, tras el aviso, la marca que acepta pasar la capacidad (WMS-52)",
    identity:
      "sesión y empresa activa (requireOrganizationContext); la tarea, el producto y las ubicaciones se buscan y bloquean solo en esa empresa, la ubicación solo dentro del almacén de la tarea y del alcance de esa persona, y la tarea debe ser suya",
    coveredBy: "tests/inventory/putaway.int.test.ts",
  },
  createPutawayTasksAction: {
    input: "nada: crea las tareas de acomodo que faltan (WMS-52)",
    identity:
      "sesión y empresa activa (requireOrganizationContext); almacén activo y zonas de esa persona, permiso inventory.task.create en el servicio",
    coveredBy: "tests/inventory/putaway.int.test.ts",
  },
  confirmPickAction: {
    input:
      "id de la tarea de surtido, clave o código de barras del producto, ubicación y cantidad surtida (y motivo si es menos)",
    identity:
      "sesión y empresa activa (requireOrganizationContext); la tarea y su pedido se bloquean solo en esa empresa y la tarea debe ser de esa persona",
    coveredBy: "tests/inventory/picking.int.test.ts",
  },
  blockTaskAction: {
    input: "id de la tarea y qué pasó",
    identity:
      "sesión y empresa activa (requireOrganizationContext); solo la persona que tiene la tarea en esa empresa",
    coveredBy: "tests/inventory/tasks.int.test.ts",
  },
  cancelTaskAction: {
    input: "id de la tarea y el motivo",
    identity:
      "sesión y empresa activa (requireOrganizationContext); la tarea se bloquea solo en esa empresa",
    coveredBy: "tests/inventory/tasks.int.test.ts",
  },
  releaseTaskAction: {
    input: "id de la tarea",
    identity:
      "sesión y empresa activa (requireOrganizationContext); la tarea se bloquea solo en esa empresa",
    coveredBy: "tests/inventory/tasks.int.test.ts",
  },
  assignTaskAction: {
    input: "id de la tarea y de la persona (o vacío para dejarla disponible)",
    identity:
      "sesión y empresa activa (requireOrganizationContext); la tarea se bloquea solo en esa empresa y la persona debe poder hacer tareas ahí",
    coveredBy: "tests/inventory/tasks.int.test.ts",
  },
  receivePurchaseOrderAction: {
    input:
      "id de orden, id de ubicación, remisión, clave de confirmación y la aceptación del aviso de capacidad (WMS-22B); si llegó en tarima, su etiqueta y tipo (WMS-53)",
    identity:
      "sesión y empresa activa (requireOrganizationContext); la orden y la ubicación se buscan solo en esa empresa",
    coveredBy:
      "tests/purchasing/receipts.int.test.ts, tests/inventory/capacity.int.test.ts",
  },
  checkReceiptAction: {
    input: "clave de confirmación",
    identity:
      "sesión y empresa activa (requireOrganizationContext); solo encuentra recepciones de esa persona en esa empresa",
    coveredBy: "tests/purchasing/receipts.int.test.ts",
  },
  sendPurchaseOrderAction: {
    input: "id de orden",
    identity:
      "sesión y empresa activa (requireOrganizationContext); la orden se busca solo en esa empresa y el destinatario sale de la ficha del proveedor, nunca del navegador",
    coveredBy: "tests/purchasing/order-delivery.int.test.ts",
  },
  submitPurchaseOrderAction: {
    input: "id de orden",
    identity:
      "sesión y empresa activa (requireOrganizationContext); la orden se busca solo en esa empresa",
    coveredBy: "tests/purchasing/order-transitions.int.test.ts",
  },
  cancelPurchaseOrderAction: {
    input: "id de orden y motivo",
    identity:
      "sesión y empresa activa (requireOrganizationContext); la orden se busca solo en esa empresa",
    coveredBy: "tests/purchasing/order-transitions.int.test.ts",
  },
  returnToSupplierAction: {
    input:
      "id de orden, id de recepción, cantidades por línea, ubicaciones, motivo y clave de confirmación",
    identity:
      "sesión y empresa activa (requireOrganizationContext); recepción y ubicaciones se buscan solo en esa empresa",
    coveredBy: "tests/purchasing/returns.int.test.ts",
  },
  checkReturnAction: {
    input: "clave de confirmación",
    identity:
      "sesión y empresa activa (requireOrganizationContext); solo devoluciones de esa persona en esa empresa",
    coveredBy: "tests/purchasing/returns.int.test.ts",
  },
  generateSuggestedOrdersAction: {
    input: "ids de productos",
    identity:
      "sesión y empresa activa (requireOrganizationContext); productos, mínimos, proveedores y cantidades se calculan en el servidor solo en esa empresa",
    coveredBy: "tests/purchasing/suggestions.int.test.ts",
  },
  closePurchaseOrderAction: {
    input: "id de orden y motivo",
    identity:
      "sesión y empresa activa (requireOrganizationContext); la orden se busca solo en esa empresa",
    coveredBy: "tests/purchasing/order-close.int.test.ts",
  },
  createPurchaseOrderAction: {
    input: "id de proveedor, día esperado y notas",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el proveedor se busca solo entre los de esa empresa",
    coveredBy: "tests/purchasing/orders.int.test.ts",
  },
  updatePurchaseOrderAction: {
    input: "id de orden, día esperado y notas",
    identity:
      "sesión y empresa activa (requireOrganizationContext); la orden se busca solo en esa empresa",
    coveredBy: "tests/purchasing/orders.int.test.ts",
  },
  addOrderLineAction: {
    input: "id de orden, id de producto, forma de pedirlo, cantidad y costo",
    identity:
      "sesión y empresa activa (requireOrganizationContext); orden, producto y presentación se buscan solo en esa empresa; el costo exige además el permiso de registrar costos",
    coveredBy: "tests/purchasing/orders.int.test.ts",
  },
  updateOrderLineAction: {
    input:
      "id de orden (solo para volver a su pantalla), id de línea, forma de pedirlo, cantidad y costo",
    identity:
      "sesión y empresa activa (requireOrganizationContext); la línea y su orden se buscan solo en esa empresa; el costo exige además el permiso de registrar costos",
    coveredBy: "tests/purchasing/orders.int.test.ts",
  },
  removeOrderLineAction: {
    input: "id de orden (solo para repintar su pantalla) e id de línea",
    identity:
      "sesión y empresa activa (requireOrganizationContext); la línea y su orden se buscan solo en esa empresa",
    coveredBy: "tests/purchasing/orders.int.test.ts",
  },
  linkProductSupplierAction: {
    input:
      "id de proveedor, id de producto, código del proveedor e id de presentación",
    identity:
      "sesión y empresa activa (requireOrganizationContext); proveedor, producto y presentación se buscan solo en esa empresa",
    coveredBy: "tests/purchasing/product-suppliers.int.test.ts",
  },
  updateProductSupplierAction: {
    input:
      "id de proveedor (solo para volver a su pantalla), id del vínculo, código del proveedor e id de presentación",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el vínculo y la presentación se buscan solo en esa empresa",
    coveredBy: "tests/purchasing/product-suppliers.int.test.ts",
  },
  createSupplierAction: {
    input:
      "datos del proveedor (nombre, razón social, RFC, contacto, correo, teléfono, dirección, notas) y si acepta guardar un posible duplicado",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el proveedor se crea en esa empresa",
    coveredBy: "tests/platform/suppliers.int.test.ts",
  },
  updateSupplierAction: {
    input:
      "id del proveedor, sus datos y si acepta guardar un posible duplicado",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el proveedor se busca solo entre los de esa empresa",
    coveredBy: "tests/platform/suppliers.int.test.ts",
  },
  switchFacilityAction: {
    input: "id del almacén en que se quiere trabajar",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el almacén se busca solo en esa empresa, se rechaza si está fuera del alcance de la persona (WMS-20) y se guarda en su membresía",
    coveredBy:
      "tests/platform/facilities.int.test.ts, tests/platform/member-scope.int.test.ts",
  },
  createFacilityAction: {
    input: "nombre, código y dirección del almacén",
    identity:
      "sesión y empresa activa (requireOrganizationContext); se crea en esa empresa, dentro del cupo de su plan",
    coveredBy: "tests/platform/facilities.int.test.ts",
  },
  updateFacilityAction: {
    input: "id del almacén, nombre, código y dirección",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el almacén se busca solo en esa empresa",
    coveredBy: "tests/platform/facilities.int.test.ts",
  },
  archiveFacilityAction: {
    input: "id del almacén",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el almacén se busca solo en esa empresa y se archiva solo vacío",
    coveredBy: "tests/platform/facilities.int.test.ts",
  },
  updateSettingAction: {
    input: "clave del ajuste y la opción elegida",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el servicio exige platform.organization.update y el módulo del ajuste, y escribe solo en esa empresa",
    coveredBy: "tests/platform/operation-settings.int.test.ts",
  },
  setStagingAction: {
    input: "id de la ubicación de preparación",
    identity:
      "sesión y empresa activa (requireOrganizationContext); la ubicación se busca y bloquea solo en esa empresa",
    coveredBy: "tests/platform/operation-settings.int.test.ts",
  },
  startOutboundImportAction: {
    input: "archivo .csv o .xlsx de pedidos de salida y separador decimal",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el archivo se guarda como privado de esa empresa",
    coveredBy: "tests/inventory/outbound-import.int.test.ts",
  },
  confirmOutboundImportAction: {
    input: "id de importación de pedidos",
    identity:
      "sesión y empresa activa (requireOrganizationContext); la importación se busca solo en esa empresa y bajo su candado",
    coveredBy: "tests/inventory/outbound-import.int.test.ts",
  },
  cancelOutboundImportAction: {
    input: "id de importación de pedidos",
    identity:
      "sesión y empresa activa (requireOrganizationContext); la importación se busca solo en esa empresa y bajo su candado",
    coveredBy: "tests/inventory/outbound-import.int.test.ts",
  },
  startExitImportAction: {
    input: "archivo .csv o .xlsx de salidas y separador decimal",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el archivo se guarda como privado de esa empresa",
    coveredBy: "tests/inventory/exit-import.int.test.ts",
  },
  confirmExitImportAction: {
    input: "id de importación de salidas",
    identity:
      "sesión y empresa activa (requireOrganizationContext); la importación se busca solo en esa empresa",
    coveredBy: "tests/inventory/exit-import.int.test.ts",
  },
  cancelExitImportAction: {
    input: "id de importación de salidas",
    identity:
      "sesión y empresa activa (requireOrganizationContext); la importación se busca solo en esa empresa",
    coveredBy: "tests/inventory/exit-import.int.test.ts",
  },
  cancelImportAction: {
    input: "id de importación",
    identity:
      "sesión y empresa activa (requireOrganizationContext); la importación se busca solo en esa empresa",
    coveredBy: "tests/inventory/import-release.int.test.ts",
  },
  confirmImportAction: {
    input: "id de importación",
    identity:
      "sesión y empresa activa (requireOrganizationContext); la importación se busca solo en esa empresa",
    coveredBy: "tests/inventory/import-confirmation.int.test.ts",
  },
  startImportAction: {
    input: "archivo .xlsx o .csv",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el archivo se guarda como privado de esa empresa",
    coveredBy: "tests/inventory/imports.int.test.ts",
  },
  saveMappingAction: {
    input:
      "id de importación, columna del archivo para cada dato y separador decimal",
    identity:
      "sesión y empresa activa (requireOrganizationContext); la importación se busca solo en esa empresa",
    coveredBy: "tests/inventory/imports.int.test.ts",
  },
  applyCountAction: {
    input: "id de conteo y motivo",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el conteo se busca solo en esa empresa",
    coveredBy: "tests/inventory/count-apply.int.test.ts",
  },
  openCountAction: {
    input: "id de ubicación y nota",
    identity:
      "sesión y empresa activa (requireOrganizationContext); la ubicación se busca solo en esa empresa",
    coveredBy: "tests/inventory/counts.int.test.ts",
  },
  captureCountAction: {
    input: "id de conteo, id de producto, forma de captura y cantidad",
    identity:
      "sesión y empresa activa (requireOrganizationContext); conteo, producto y presentación se buscan solo en esa empresa",
    coveredBy: "tests/inventory/counts.int.test.ts",
  },
  removeCaptureAction: {
    input: "id de conteo e id de captura",
    identity:
      "sesión y empresa activa (requireOrganizationContext); la captura se busca solo dentro de ese conteo y esa empresa",
    coveredBy: "tests/inventory/counts.int.test.ts",
  },
  cancelCountAction: {
    input: "id de conteo",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el conteo se busca solo en esa empresa",
    coveredBy: "tests/inventory/counts.int.test.ts",
  },
  findCountProductsAction: {
    input: "texto de búsqueda (nombre, clave o código de barras)",
    identity:
      "sesión y empresa activa (getModuleAccess); solo lee productos de esa empresa",
    coveredBy: "tests/inventory/counts.int.test.ts",
  },
  loadCountProductAction: {
    input: "id de producto",
    identity:
      "sesión y empresa activa (getModuleAccess); el producto se busca solo en esa empresa",
    coveredBy: "tests/inventory/counts.int.test.ts",
  },
  setMinimumAction: {
    input: "id de producto y cantidad mínima (vacía = quitarla)",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el producto se busca solo en esa empresa",
    coveredBy: "tests/inventory/minimums.int.test.ts",
  },
  registerQuickExitAction: {
    input:
      "líneas (id de producto, ubicación, cantidad, forma de captura), motivo, referencia y clave de la confirmación",
    identity:
      "sesión y empresa activa (requireOrganizationContext); productos, presentaciones y ubicaciones se buscan solo en esa empresa",
    coveredBy: "tests/inventory/quick-exit.int.test.ts",
  },
  findExitProductsAction: {
    input: "texto de búsqueda (nombre, clave o código de barras)",
    identity:
      "sesión y empresa activa (getModuleAccess); solo lee productos de esa empresa",
    coveredBy: "tests/inventory/quick-exit.int.test.ts",
  },
  loadExitProductAction: {
    input: "id de producto",
    identity:
      "sesión y empresa activa (getModuleAccess); el producto se busca solo en esa empresa",
    coveredBy: "tests/inventory/quick-exit.int.test.ts",
  },
  reverseMovementAction: {
    input: "id del movimiento, clave de la confirmación y motivo",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el movimiento se busca solo en esa empresa",
    coveredBy: "tests/inventory/reversals.int.test.ts",
  },
  registerAdjustmentAction: {
    input:
      "id de producto, ubicación, cantidad contada, forma de captura, motivo y clave de la confirmación",
    identity:
      "sesión y empresa activa (requireOrganizationContext); producto y ubicación se buscan solo en esa empresa",
    coveredBy: "tests/inventory/adjustments.int.test.ts",
  },
  registerTransferAction: {
    input:
      "id de producto, ubicación de origen y de destino, cantidad, forma de captura, nota, clave de la confirmación y la aceptación del aviso de capacidad (WMS-22B)",
    identity:
      "sesión y empresa activa (requireOrganizationContext); producto y ubicaciones se buscan solo en esa empresa",
    coveredBy:
      "tests/inventory/transfers.int.test.ts, tests/inventory/capacity.int.test.ts",
  },
  checkConfirmationAction: {
    input: "clave de la confirmación",
    identity:
      "sesión y empresa activa (requireOrganizationContext); solo responde por movimientos confirmados por la misma persona",
    coveredBy: "tests/inventory/lost-answer.int.test.ts",
  },
  registerExitAction: {
    input:
      "id de producto, id de ubicación, cantidad, forma de captura, referencia y nota (sin factor ni saldo)",
    identity:
      "sesión y empresa activa (requireOrganizationContext); producto y ubicación se buscan solo en esa empresa",
    coveredBy: "tests/inventory/exits.int.test.ts",
  },
  registerInitialBalanceAction: {
    input:
      "id de producto, id de ubicación, cantidad, forma de captura, nota y la aceptación del aviso de capacidad (WMS-22B; sin factor ni saldo)",
    identity:
      "sesión y empresa activa (requireOrganizationContext); producto y ubicación se buscan solo en esa empresa",
    coveredBy:
      "tests/inventory/initial-balance.int.test.ts, tests/inventory/capacity.int.test.ts",
  },
  previewEntryAction: {
    input:
      "id de producto, forma de captura (id de presentación o código de unidad) y cantidad; solo lee",
    identity:
      "sesión y empresa activa (requireOrganizationContext); producto y presentación se buscan solo en esa empresa",
    coveredBy: "tests/platform/conversion.int.test.ts",
  },
  registerEntryAction: {
    input:
      "id de producto, id de ubicación, cantidad, forma de captura (id de presentación o código de unidad), referencia, nota y la aceptación de los avisos de entrada repetida (WMS-71) y de capacidad (WMS-22B; sin factor ni saldo)",
    identity:
      "sesión y empresa activa (requireOrganizationContext); producto y ubicación se buscan solo en esa empresa, y la entrada reciente también",
    coveredBy:
      "tests/inventory/entries.int.test.ts, tests/inventory/entry-repeat.int.test.ts, tests/inventory/capacity.int.test.ts",
  },
  createLocationAction: {
    input:
      "nombre, nivel (profundidad), código, uso, id de la ubicación que la contiene y, opcionales, capacidad y restricciones (claves de productos e ids de categorías; WMS-22B)",
    identity:
      "sesión y empresa activa (requireOrganizationContext); la ubicación se busca solo en esa empresa y el nivel en su almacén; productos y categorías, solo en esa empresa",
    coveredBy:
      "tests/platform/location-hierarchy.int.test.ts, tests/platform/location-limits.int.test.ts",
  },
  setLocationLimitsAction: {
    input:
      "id de ubicación (fijado por la página), unidades, peso y volumen máximos, claves de los productos e ids de las categorías que admite",
    identity:
      "sesión y empresa activa (requireOrganizationContext); la ubicación, los productos y las categorías se buscan solo en esa empresa",
    coveredBy: "tests/platform/location-limits.int.test.ts",
  },
  editLocationAction: {
    input: "id de ubicación, nombre, código y uso",
    identity:
      "sesión y empresa activa (requireOrganizationContext); la ubicación se busca solo en esa empresa",
    coveredBy: "tests/platform/location-levels.int.test.ts",
  },
  saveLevelsAction: {
    input:
      "lista de niveles (id de los que existen y nombre); el almacén es el activo de la persona",
    identity:
      "sesión y empresa activa (requireOrganizationContext); los niveles se buscan solo en el almacén activo de esa empresa",
    coveredBy: "tests/platform/location-levels.int.test.ts",
  },
  moveLocationAction: {
    input: "id de ubicación e id del destino",
    identity:
      "sesión y empresa activa (requireOrganizationContext); la ubicación se busca solo en esa empresa",
    coveredBy: "tests/platform/location-hierarchy.int.test.ts",
  },
  archiveLocationAction: {
    input: "id de ubicación",
    identity:
      "sesión y empresa activa (requireOrganizationContext); la ubicación se busca solo en esa empresa",
    coveredBy: "tests/platform/location-hierarchy.int.test.ts",
  },
  restoreLocationAction: {
    input: "id de ubicación",
    identity:
      "sesión y empresa activa (requireOrganizationContext); la ubicación se busca solo en esa empresa",
    coveredBy: "tests/platform/location-hierarchy.int.test.ts",
  },
  changePresentationFactorAction: {
    input:
      "id de producto (solo para refrescar), id de presentación y contenido nuevo",
    identity:
      "sesión y empresa activa (requireOrganizationContext); la presentación se busca solo en esa empresa",
    coveredBy: "tests/platform/presentation-versions.int.test.ts",
  },
  createPresentationAction: {
    input: "id de producto, nombre de la presentación y contenido",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el producto se busca solo en esa empresa",
    coveredBy: "tests/platform/presentations.int.test.ts",
  },
  archiveProductAction: {
    input: "id de producto y motivo",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el producto se busca solo en esa empresa",
    coveredBy: "tests/platform/product-archive.int.test.ts",
  },
  reactivateProductAction: {
    input: "id de producto",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el producto se busca solo en esa empresa",
    coveredBy: "tests/platform/product-archive.int.test.ts",
  },
  updateProductAction: {
    input:
      "id de producto y los campos de la ficha, con peso y volumen por unidad (WMS-22B; sin cantidades)",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el producto se busca solo en esa empresa",
    coveredBy: "tests/platform/product-update.int.test.ts",
  },
  createProductAction: {
    input:
      "clave, nombre, descripción, categoría, marca, código de barras y, opcionales, peso y volumen por unidad (WMS-22B)",
    identity:
      "sesión y empresa activa (requireOrganizationContext); el servicio comprueba rol, módulo y cupo",
    coveredBy: "tests/platform/products.int.test.ts",
  },
  provisionAction: {
    input:
      "id de empresa (cualquiera: es personal de plataforma), cupos, módulos, vigencia y motivo",
    identity:
      "sesión con MFA + fila activa en platform_staff (requirePlatformStaff); el servicio lo vuelve a comprobar",
    coveredBy: "tests/platform/provisioning.int.test.ts",
  },
  recordPaymentAction: {
    input:
      "id de empresa (cualquiera: es personal de plataforma), importe, día, clave de rastreo, meses y notas",
    identity:
      "sesión con MFA + fila activa en platform_staff (requirePlatformStaff); el servicio lo vuelve a comprobar",
    coveredBy: "tests/platform/payments.int.test.ts",
  },
  reversePaymentAction: {
    input:
      "id de empresa e id de pago (el pago se busca dentro de esa empresa) y motivo",
    identity:
      "sesión con MFA + fila activa en platform_staff (requirePlatformStaff); el servicio lo vuelve a comprobar",
    coveredBy: "tests/platform/payments.int.test.ts",
  },
  inviteAction: {
    input:
      "correo, roles y, si se limita, ids de almacenes y zonas (se comprueban en la empresa de la sesión y contra lo que tiene quien invita)",
    identity: "sesión y empresa activa (requireOrganizationContext)",
    coveredBy:
      "tests/platform/invitations.int.test.ts y tests/platform/member-scope.int.test.ts",
  },
  resendInvitationAction: {
    input: "id de invitación",
    identity: "sesión y empresa activa (requireOrganizationContext)",
    coveredBy: "tests/platform/invitations.int.test.ts",
  },
  cancelInvitationAction: {
    input: "id de invitación",
    identity: "sesión y empresa activa (requireOrganizationContext)",
    coveredBy: "tests/platform/invitations.int.test.ts",
  },
  assignRolesAction: {
    input: "id de usuario y roles",
    identity: "sesión y empresa activa (requireOrganizationContext)",
    coveredBy: "tests/platform/team.int.test.ts",
  },
  setMemberScopeAction: {
    input:
      "id de usuario, «todos» o ids de almacenes y, por almacén, ids de zonas",
    identity:
      "sesión y empresa activa (requireOrganizationContext); cada almacén y zona se busca solo en esa empresa y quien está limitado solo reparte lo suyo",
    coveredBy: "tests/platform/member-scope.int.test.ts",
  },
  disableMemberAction: {
    input: "id de usuario y motivo",
    identity: "sesión y empresa activa (requireOrganizationContext)",
    coveredBy: "tests/platform/team-disable.int.test.ts",
  },
  reactivateMemberAction: {
    input: "id de usuario",
    identity: "sesión y empresa activa (requireOrganizationContext)",
    coveredBy: "tests/platform/team-disable.int.test.ts",
  },
  acceptInvitationAction: {
    input: "token de la invitación",
    identity:
      "sesión (requireSession); el correo de la cuenta debe ser el invitado",
    coveredBy: "tests/platform/invitation-accept.int.test.ts",
  },
  joinAsNewUserAction: {
    input:
      "token de la invitación, nombre, contraseña y aceptación de documentos",
    identity: "el token (un solo uso, vence); el correo sale de la invitación",
    coveredBy: "tests/platform/invitation-accept.int.test.ts",
  },
  invitationSignOutAction: {
    input: "token (solo para volver a la misma pantalla)",
    identity: "sesión propia",
    coveredBy: "tests/platform/session.int.test.ts",
  },
  signInAction: {
    input: "correo y contraseña",
    identity: "ninguna sesión previa",
    coveredBy: "tests/platform/throttle.int.test.ts, session.int.test.ts",
  },
  acceptLegalAction: {
    input: "casilla de aceptación (las versiones salen del código)",
    identity: "sesión (requireSession); la persona sale de la sesión",
    coveredBy: "tests/platform/legal-acceptance.int.test.ts",
  },
  registerAction: {
    input: "nombre, correo, contraseña y aceptación de documentos",
    identity: "ninguna",
    coveredBy: "tests/platform/register.int.test.ts",
  },
  resendAction: {
    input: "correo",
    identity: "ninguna (respuesta neutral)",
    coveredBy: "tests/platform/register.int.test.ts",
  },
  recoverAction: {
    input: "correo",
    identity: "ninguna (respuesta neutral)",
    coveredBy: "tests/platform/recovery.int.test.ts",
  },
  resetAction: {
    input: "token del correo y contraseña nueva",
    identity: "el token (un solo uso, vence)",
    coveredBy: "tests/platform/recovery.int.test.ts",
  },
  verifyCodeAction: {
    input: "código y método",
    identity: "cookie firmada del desafío MFA",
    coveredBy:
      "tests/platform/mfa-challenge.int.test.ts, mfa-recovery.int.test.ts",
  },
  createOrganizationAction: {
    input: "nombre y zona horaria",
    identity: "sesión (requireSession)",
    coveredBy: "tests/platform/organizations.int.test.ts",
  },
  signOutAction: {
    input: "nada",
    identity: "sesión propia",
    coveredBy: "tests/platform/session.int.test.ts",
  },
  grantSupportAccessAction: {
    input: "nada",
    identity:
      "sesión y empresa activa (requireOrganizationContext); solo el titular (assertOwnerAction)",
    coveredBy: "tests/platform/support-access.int.test.ts",
  },
  revokeSupportAccessAction: {
    input: "nada",
    identity:
      "sesión y empresa activa (requireOrganizationContext); solo el titular (assertOwnerAction)",
    coveredBy: "tests/platform/support-access.int.test.ts",
  },
  enterSupportAction: {
    input: "id de empresa",
    identity:
      "sesión de personal de plataforma (requirePlatformStaff); entra solo si el titular de esa empresa tiene abierto el acceso, y solo a leer",
    coveredBy: "tests/platform/support-access.int.test.ts",
  },
  leaveSupportAction: {
    input: "nada",
    identity:
      "sesión propia; solo deja la empresa donde la persona no es miembro",
    coveredBy: "tests/platform/support-access.int.test.ts",
  },
  switchOrganizationAction: {
    input: "id de empresa",
    identity: "sesión; membresía activa revisada en servidor",
    coveredBy: "tests/isolation/two-companies.int.test.ts",
  },
  revokeSessionAction: {
    input: "id de sesión",
    identity: "sesión; solo sesiones del mismo usuario",
    coveredBy: "tests/isolation/two-companies.int.test.ts",
  },
  revokeOtherSessionsAction: {
    input: "nada",
    identity: "sesión propia",
    coveredBy: "tests/platform/sessions.int.test.ts",
  },
  mfaSetupAction: {
    input: "contraseña o código",
    identity: "sesión propia (allowMissingMfa solo aquí)",
    coveredBy: "tests/platform/mfa.int.test.ts",
  },
  regenerateBackupCodesAction: {
    input: "contraseña",
    identity: "sesión propia",
    coveredBy: "tests/platform/mfa-recovery.int.test.ts",
  },
  disableMfaAction: {
    input: "contraseña y código",
    identity: "sesión propia; prohibido si la MFA es obligatoria",
    coveredBy: "tests/platform/mfa-recovery.int.test.ts",
  },
};

function actionFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return actionFiles(full);
    return name === "actions.ts" ? [full] : [];
  });
}

function exportedActions(): string[] {
  return actionFiles(path.join(process.cwd(), "src/app"))
    .flatMap((file) => [
      ...readFileSync(file, "utf8").matchAll(
        /^export (?:async function|const) (\w+)/gm,
      ),
    ])
    .map(([, name]) => name!)
    .sort();
}

describe("server actions", () => {
  it("every action has an isolation review", () => {
    expect(exportedActions()).toEqual(Object.keys(REVIEWED).sort());
  });

  it("every review points to existing tests", () => {
    for (const [action, review] of Object.entries(REVIEWED)) {
      for (const ref of review.coveredBy.split(",")) {
        const name = path.basename(ref.trim());
        const found = [
          path.join(process.cwd(), "tests/platform", name),
          path.join(process.cwd(), "tests/isolation", name),
          path.join(process.cwd(), ref.trim()),
        ].some((candidate) => {
          try {
            return statSync(candidate).isFile();
          } catch {
            return false;
          }
        });
        expect(found, `${action}: ${ref}`).toBe(true);
      }
    }
  });
});
