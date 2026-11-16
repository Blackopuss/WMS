import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import { listAuditEvents } from "@/platform/audit";
import { listActiveSessions, revokeSession } from "@/platform/auth";
import {
  createOrganization,
  resolveActiveOrganization,
  switchOrganization,
} from "@/platform/tenancy";
import { TENANT_MODELS, db, forOrganization } from "@/server";

// PLT-15: two companies, and every way a person of company A could reach
// company B by changing an identifier, a request body or stored state.

const stamp = Date.now();
const ids = { ana: "", beto: "", worker: "" };
let orgA = "";
let orgB = "";
let workerSession = "";
let betoSession = "";

async function newUser(label: string) {
  return (
    await db.user.create({
      data: {
        id: newId(),
        name: label,
        email: `${label}.iso.${stamp}@example.test`,
        emailVerified: true,
      },
    })
  ).id;
}

async function newSession(userId: string) {
  return (
    await db.session.create({
      data: {
        id: newId(),
        userId,
        token: randomBytes(24).toString("hex"),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    })
  ).id;
}

beforeAll(async () => {
  ids.ana = await newUser("ana");
  ids.beto = await newUser("beto");
  ids.worker = await newUser("trabajador");
  const a = await createOrganization(ids.ana, {
    name: "Empresa A",
    timeZone: "",
  });
  const b = await createOrganization(ids.beto, {
    name: "Empresa B",
    timeZone: "",
  });
  if (!a.ok || !b.ok) throw new Error("setup failed");
  orgA = a.organizationId;
  orgB = b.organizationId;
  const membership = await db.membership.create({
    data: { id: newId(), organizationId: orgA, userId: ids.worker },
  });
  // Some data in every company table of both companies.
  const betoMembership = await db.membership.findFirstOrThrow({
    where: { organizationId: orgB },
  });
  await db.membershipRole.createMany({
    data: [
      {
        id: newId(),
        organizationId: orgA,
        membershipId: membership.id,
        role: "viewer",
      },
      {
        id: newId(),
        organizationId: orgB,
        membershipId: betoMembership.id,
        role: "viewer",
      },
    ],
  });
  await db.ownershipTransfer.createMany({
    data: [
      {
        id: newId(),
        organizationId: orgA,
        fromUserId: ids.ana,
        toMembershipId: membership.id,
        previousOwnerRoles: ["viewer"],
        expiresAt: new Date(Date.now() + 3_600_000),
      },
      {
        id: newId(),
        organizationId: orgB,
        fromUserId: ids.beto,
        toMembershipId: betoMembership.id,
        previousOwnerRoles: ["viewer"],
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    ],
  });
  await db.invitation.createMany({
    data: [orgA, orgB].map((organizationId, index) => ({
      id: newId(),
      organizationId,
      email: `invitado.${index}.iso.${stamp}@example.test`,
      tokenHash: randomBytes(32).toString("hex"),
      roles: ["viewer"],
      invitedByUserId: index === 0 ? ids.ana : ids.beto,
      expiresAt: new Date(Date.now() + 3_600_000),
    })),
  });
  // Commercial rows (MOD-03) in both companies.
  const plan = await db.planVersion.create({
    data: {
      id: newId(),
      tier: `iso${stamp % 100000}`,
      version: 1,
      name: "Aislamiento",
      productLimit: 100,
      includedUsers: 2,
      extraUserPrice: "49.00",
      effectiveFrom: new Date(),
    },
  });
  for (const organizationId of [orgA, orgB]) {
    const subscription = await db.subscription.create({
      data: {
        id: newId(),
        organizationId,
        planVersionId: plan.id,
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 86_400_000),
      },
    });
    await db.subscriptionItem.create({
      data: {
        id: newId(),
        organizationId,
        subscriptionId: subscription.id,
        moduleId: "inventory",
        monthlyPrice: "149.00",
        activeFrom: new Date(),
      },
    });
    const category = await db.productCategory.create({
      data: { id: newId(), organizationId, name: "Tornillería" },
    });
    const brand = await db.productBrand.create({
      data: { id: newId(), organizationId, name: "Truper" },
    });
    const productId = newId();
    await db.product.create({
      data: {
        id: productId,
        organizationId,
        sku: "TOR-001",
        name: "Tornillo 1/4",
        categoryId: category.id,
        brandId: brand.id,
        barcode: "7501234567890",
      },
    });
    const presentation = await db.productPresentation.create({
      data: { id: newId(), organizationId, productId, name: "Caja" },
    });
    await db.presentationVersion.create({
      data: {
        id: newId(),
        organizationId,
        presentationId: presentation.id,
        version: 1,
        factor: "100",
        createdByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    await db.quotaUsage.create({
      data: { id: newId(), organizationId, key: "active_products", taken: 1 },
    });
    // Stock (INV-15): a movement with one line and its balance.
    const location = await db.location.findFirstOrThrow({
      where: { organizationId, isDefault: true },
    });
    const movementId = newId();
    await db.stockMovement.create({
      data: {
        id: movementId,
        organizationId,
        type: "ENTRY",
        createdByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    await db.stockMovementLine.create({
      data: {
        id: newId(),
        organizationId,
        movementId,
        lineNumber: 1,
        productId,
        locationId: location.id,
        direction: "IN",
        capturedQuantity: "5",
        factor: "1",
        baseQuantity: "5",
        unitCode: "piece",
      },
    });
    await db.stockBalance.create({
      data: {
        id: newId(),
        organizationId,
        productId,
        locationId: location.id,
        quantity: "5",
      },
    });
    await db.stockMinimum.create({
      data: {
        id: newId(),
        organizationId,
        productId,
        quantity: "2",
        updatedByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    await db.productCost.create({
      data: {
        id: newId(),
        organizationId,
        productId,
        averageCost: "85",
        stockValue: "850",
      },
    });
    const storedFileId = newId();
    await db.storedFile.create({
      data: {
        id: storedFileId,
        organizationId,
        purpose: "import_source",
        name: "productos.csv",
        contentType: "text/csv",
        size: 3,
        sha256: "0".repeat(64),
        storageKey: `${organizationId}/prueba`,
        createdByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    const productImportId = newId();
    await db.productImport.create({
      data: {
        id: productImportId,
        organizationId,
        fileId: storedFileId,
        headerRow: 1,
        headers: ["Clave", "Nombre"],
        dataRows: 1,
        mapping: {},
        createdByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    await db.productImportItem.create({
      data: {
        id: newId(),
        organizationId,
        importId: productImportId,
        position: 1,
        sku: "TOR-001",
        kind: "update",
        data: {},
      },
    });
    const contactId = newId();
    await db.contact.create({
      data: {
        id: contactId,
        organizationId,
        name: "Ferretera del Norte",
        rfc: "FNO010203AB1",
        isSupplier: true,
        createdByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    await db.productSupplier.create({
      data: {
        id: newId(),
        organizationId,
        productId,
        contactId,
        supplierSku: "FN-1",
        createdByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    const purchaseOrderId = newId();
    await db.purchaseOrder.create({
      data: {
        id: purchaseOrderId,
        organizationId,
        number: 1,
        contactId,
        createdByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    const orderLineId = newId();
    await db.purchaseOrderLine.create({
      data: {
        id: orderLineId,
        organizationId,
        orderId: purchaseOrderId,
        lineNumber: 1,
        productId,
        capturedQuantity: "5",
        factor: "1",
        baseQuantity: "5",
        unitCode: "piece",
      },
    });
    // A delivery needs an order that is no longer a draft: its line goes
    // in first, then the order is confirmed.
    await db.purchaseOrder.update({
      where: { id: purchaseOrderId },
      data: {
        status: "SENT",
        sentAt: new Date(),
        sentByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    await db.purchaseOrderDelivery.create({
      data: {
        id: newId(),
        organizationId,
        orderId: purchaseOrderId,
        recipient: "ventas@ferretera.example",
        jobId: newId(),
        requestedByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    // A receipt (CMP-07): its own movement, the receipt and its line.
    const receiptMovementId = newId();
    await db.stockMovement.create({
      data: {
        id: receiptMovementId,
        organizationId,
        type: "RECEIPT",
        createdByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    // WMS-54: a receipt line has its movement line (same number, product
    // and state; trigger).
    await db.stockMovementLine.create({
      data: {
        id: newId(),
        organizationId,
        movementId: receiptMovementId,
        lineNumber: 1,
        productId,
        locationId: location.id,
        direction: "IN",
        capturedQuantity: "5",
        factor: "1",
        baseQuantity: "5",
        unitCode: "piece",
      },
    });
    const receiptId = newId();
    await db.purchaseReceipt.create({
      data: {
        id: receiptId,
        organizationId,
        orderId: purchaseOrderId,
        movementId: receiptMovementId,
        idempotencyKey: newId(),
        receivedByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    const receiptLineId = newId();
    await db.purchaseReceiptLine.create({
      data: {
        id: receiptLineId,
        organizationId,
        receiptId,
        lineNumber: 1,
        orderLineId,
        productId,
        locationId: location.id,
        capturedQuantity: "5",
        factor: "1",
        baseQuantity: "5",
        unitCode: "piece",
      },
    });
    // A return of that receipt (CMP-12): its movement, the return and its line.
    const returnMovementId = newId();
    await db.stockMovement.create({
      data: {
        id: returnMovementId,
        organizationId,
        type: "RETURN",
        createdByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    const returnId = newId();
    await db.purchaseReturn.create({
      data: {
        id: returnId,
        organizationId,
        receiptId,
        movementId: returnMovementId,
        reason: "Llegó dañado",
        idempotencyKey: newId(),
        returnedByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    await db.purchaseReturnLine.create({
      data: {
        id: newId(),
        organizationId,
        returnId,
        lineNumber: 1,
        receiptLineId,
        productId,
        locationId: location.id,
        capturedQuantity: "1",
        factor: "1",
        baseQuantity: "1",
        unitCode: "piece",
      },
    });
    const exitImportId = newId();
    await db.exitImport.create({
      data: {
        id: exitImportId,
        organizationId,
        fileId: storedFileId,
        decimalSeparator: ".",
        dataRows: 1,
        createdByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    await db.exitImportRow.create({
      data: {
        id: newId(),
        organizationId,
        importId: exitImportId,
        row: 2,
        externalId: "T-1",
        day: new Date("2026-10-08T00:00:00.000Z"),
        productId,
        quantity: "1",
        locationId: location.id,
      },
    });
    await db.job.create({
      data: {
        id: newId(),
        organizationId,
        type: "test.noop",
        payload: {},
      },
    });
    // A lot of the product (ADR 0033; filled in by WMS-21).
    await db.lot.create({
      data: {
        id: newId(),
        organizationId,
        productId,
        code: "L-1",
        createdByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    // A reservation of the product for a document (WMS-12).
    await db.stockReservation.create({
      data: {
        id: newId(),
        organizationId,
        productId,
        quantity: "1",
        remaining: "1",
        sourceType: "test",
        sourceId: newId(),
        createdByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    // An operation setting (WMS-49).
    await db.organizationSetting.create({
      data: {
        id: newId(),
        organizationId,
        key: "inventory.picking.strategy",
        value: "emptiest",
        updatedByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    // A file of outbound orders (WMS-13B).
    await db.outboundImport.create({
      data: {
        id: newId(),
        organizationId,
        fileId: storedFileId,
        decimalSeparator: ".",
        dataRows: 1,
        createdByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    // An outbound order with a line (WMS-13).
    const outboundId = newId();
    await db.outboundOrder.create({
      data: {
        id: outboundId,
        organizationId,
        facilityId: (
          await db.facility.findFirstOrThrow({
            where: { organizationId, isDefault: true },
          })
        ).id,
        number: 1,
        recipient: "Sucursal",
        createdByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    const outboundLineId = newId();
    await db.outboundOrderLine.create({
      data: {
        id: outboundLineId,
        organizationId,
        orderId: outboundId,
        lineNumber: 1,
        productId,
        quantity: "1",
        unitCode: "piece",
      },
    });
    // What was missing when packing it (WMS-15).
    await db.outboundPackShortage.create({
      data: {
        id: newId(),
        organizationId,
        orderId: outboundId,
        lineId: outboundLineId,
        productId,
        locationId: location.id,
        quantity: "1",
        reason: "No apareció",
        createdByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    // A shipment that took the order out (WMS-16): its exit, its order and
    // what left.
    const shipmentId = newId();
    const outboundFacility = (
      await db.outboundOrder.findUniqueOrThrow({ where: { id: outboundId } })
    ).facilityId;
    await db.shipment.create({
      data: {
        id: shipmentId,
        organizationId,
        number: 1,
        facilityId: outboundFacility,
        carrier: "Fletes",
        createdByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    await db.shipmentOrder.create({
      data: {
        id: newId(),
        organizationId,
        shipmentId,
        orderId: outboundId,
        openOrderId: outboundId,
        createdByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    // A picking wave with the order (WMS-25).
    const waveId = newId();
    await db.pickWave.create({
      data: {
        id: waveId,
        organizationId,
        number: 1,
        facilityId: outboundFacility,
        createdByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    await db.pickWaveOrder.create({
      data: {
        id: newId(),
        organizationId,
        waveId,
        orderId: outboundId,
        openOrderId: outboundId,
      },
    });
    const shipmentMovementId = newId();
    await db.stockMovement.create({
      data: {
        id: shipmentMovementId,
        organizationId,
        type: "SHIPMENT",
        reference: "EM-0001",
        createdByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    const shipmentMovementLineId = newId();
    await db.stockMovementLine.create({
      data: {
        id: shipmentMovementLineId,
        organizationId,
        movementId: shipmentMovementId,
        lineNumber: 1,
        productId,
        locationId: location.id,
        direction: "OUT",
        capturedQuantity: "1",
        factor: "1",
        baseQuantity: "1",
        unitCode: "piece",
      },
    });
    await db.shipmentLine.create({
      data: {
        id: newId(),
        organizationId,
        shipmentId,
        orderId: outboundId,
        orderLineId: outboundLineId,
        productId,
        locationId: location.id,
        quantity: "1",
        unitCode: "piece",
        movementLineId: shipmentMovementLineId,
      },
    });
    // A customer return of that order (WMS-17): its entry into inspection,
    // its line and a decision (a change of state out of inspection).
    const customerReturnMovementId = newId();
    await db.stockMovement.create({
      data: {
        id: customerReturnMovementId,
        organizationId,
        type: "CUSTOMER_RETURN",
        reference: "DV-0001",
        reason: "No lo quiso",
        createdByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    const customerReturnId = newId();
    await db.customerReturn.create({
      data: {
        id: customerReturnId,
        organizationId,
        number: 1,
        facilityId: outboundFacility,
        locationId: location.id,
        orderId: outboundId,
        returnedBy: "Sucursal",
        reason: "No lo quiso",
        movementId: customerReturnMovementId,
        idempotencyKey: newId(),
        createdByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    const customerReturnMovementLineId = newId();
    await db.stockMovementLine.create({
      data: {
        id: customerReturnMovementLineId,
        organizationId,
        movementId: customerReturnMovementId,
        lineNumber: 1,
        productId,
        locationId: location.id,
        direction: "IN",
        status: "INSPECTION",
        capturedQuantity: "1",
        factor: "1",
        baseQuantity: "1",
        unitCode: "piece",
      },
    });
    const customerReturnLineId = newId();
    await db.customerReturnLine.create({
      data: {
        id: customerReturnLineId,
        organizationId,
        returnId: customerReturnId,
        lineNumber: 1,
        productId,
        orderLineId: outboundLineId,
        quantity: "1",
        unitCode: "piece",
        movementLineId: customerReturnMovementLineId,
      },
    });
    const decisionMovementId = newId();
    await db.stockMovement.create({
      data: {
        id: decisionMovementId,
        organizationId,
        type: "STATUS_CHANGE",
        reason: "Devolución DV-0001: en buen estado",
        reference: "DV-0001",
        createdByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    for (const [lineNumber, direction, status] of [
      [1, "OUT", "INSPECTION"],
      [2, "IN", "AVAILABLE"],
    ] as const) {
      await db.stockMovementLine.create({
        data: {
          id: newId(),
          organizationId,
          movementId: decisionMovementId,
          lineNumber,
          productId,
          locationId: location.id,
          direction,
          status,
          capturedQuantity: "1",
          factor: "1",
          baseQuantity: "1",
          unitCode: "piece",
        },
      });
    }
    await db.customerReturnDecision.create({
      data: {
        id: newId(),
        organizationId,
        returnId: customerReturnId,
        lineId: customerReturnLineId,
        outcome: "AVAILABLE",
        quantity: "1",
        reason: "En buen estado",
        locationId: location.id,
        movementId: decisionMovementId,
        decidedByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    // A transfer between warehouses (WMS-19), sent and received: a second
    // warehouse with its transit location and a receiving place, the draft
    // and its line, the send into transit and the receipt out of it.
    const by = organizationId === orgA ? ids.ana : ids.beto;
    const otherFacilityId = newId();
    await db.facility.create({
      data: {
        id: otherFacilityId,
        organizationId,
        name: "Bodega de traslados",
        code: "TRAS",
      },
    });
    const otherLevelId = newId();
    await db.locationLevel.create({
      data: {
        id: otherLevelId,
        organizationId,
        facilityId: otherFacilityId,
        depth: 1,
        name: "Zona",
      },
    });
    const transitId = newId();
    const arrivalId = newId();
    for (const [id, name, isTransit] of [
      [transitId, "En tránsito entre almacenes", true],
      [arrivalId, "Recepción", null],
    ] as const) {
      await db.location.create({
        data: {
          id,
          organizationId,
          facilityId: otherFacilityId,
          name,
          levelId: otherLevelId,
          isTransit,
        },
      });
    }
    const transferId = newId();
    await db.facilityTransfer.create({
      data: {
        id: transferId,
        organizationId,
        number: 1,
        fromFacilityId: location.facilityId,
        toFacilityId: otherFacilityId,
        transitLocationId: transitId,
        idempotencyKey: newId(),
        createdByUserId: by,
      },
    });
    const transferLineId = newId();
    await db.facilityTransferLine.create({
      data: {
        id: transferLineId,
        organizationId,
        transferId,
        lineNumber: 1,
        productId,
        fromLocationId: location.id,
        quantity: "1",
        unitCode: "piece",
      },
    });
    const transferLeg = async (
      movementId: string,
      lineNumber: number,
      direction: "IN" | "OUT",
      locationId: string,
      status: "AVAILABLE" | "IN_TRANSIT",
    ) => {
      const id = newId();
      await db.stockMovementLine.create({
        data: {
          id,
          organizationId,
          movementId,
          lineNumber,
          productId,
          locationId,
          direction,
          status,
          capturedQuantity: "1",
          factor: "1",
          baseQuantity: "1",
          unitCode: "piece",
        },
      });
      return id;
    };
    const sendMovementId = newId();
    await db.stockMovement.create({
      data: {
        id: sendMovementId,
        organizationId,
        type: "FACILITY_TRANSFER",
        reference: "TR-0001",
        createdByUserId: by,
      },
    });
    await transferLeg(sendMovementId, 1, "OUT", location.id, "AVAILABLE");
    const intoTransitId = await transferLeg(
      sendMovementId,
      2,
      "IN",
      transitId,
      "IN_TRANSIT",
    );
    await db.facilityTransferLine.update({
      where: { id: transferLineId },
      data: { transitLineId: intoTransitId },
    });
    await db.facilityTransfer.update({
      where: { id: transferId },
      data: {
        status: "SENT",
        sendMovementId,
        sentByUserId: by,
        sentAt: new Date(),
      },
    });
    const arrivalMovementId = newId();
    await db.stockMovement.create({
      data: {
        id: arrivalMovementId,
        organizationId,
        type: "FACILITY_TRANSFER",
        reference: "TR-0001",
        createdByUserId: by,
      },
    });
    await transferLeg(arrivalMovementId, 1, "OUT", transitId, "IN_TRANSIT");
    const arrivedId = await transferLeg(
      arrivalMovementId,
      2,
      "IN",
      arrivalId,
      "AVAILABLE",
    );
    const transferReceiptId = newId();
    await db.facilityTransferReceipt.create({
      data: {
        id: transferReceiptId,
        organizationId,
        transferId,
        kind: "RECEIVED",
        locationId: arrivalId,
        movementId: arrivalMovementId,
        idempotencyKey: newId(),
        createdByUserId: by,
      },
    });
    await db.facilityTransferReceiptLine.create({
      data: {
        id: newId(),
        organizationId,
        receiptId: transferReceiptId,
        lineId: transferLineId,
        status: "AVAILABLE",
        quantity: "1",
        movementLineId: arrivedId,
      },
    });
    await db.facilityTransfer.update({
      where: { id: transferId },
      data: { status: "RECEIVED", closedAt: new Date() },
    });
    // A transfer task (WMS-06) from the default location to a rack.
    const rackId = newId();
    await db.location.create({
      data: {
        id: rackId,
        organizationId,
        facilityId: location.facilityId,
        name: "Rack de tareas",
        // The default levels of the warehouse (WMS-22A): its finest one.
        levelId: (
          await db.locationLevel.findFirstOrThrow({
            where: {
              organizationId,
              facilityId: location.facilityId,
              depth: 3,
            },
          })
        ).id,
      },
    });
    await db.warehouseTask.create({
      data: {
        id: newId(),
        organizationId,
        number: 1,
        productId,
        fromLocationId: location.id,
        toLocationId: rackId,
        quantity: "2",
        unitCode: "piece",
        createdByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    // A replenishment rule of that rack (WMS-23).
    await db.replenishmentRule.create({
      data: {
        id: newId(),
        organizationId,
        productId,
        locationId: rackId,
        minQuantity: "2",
        maxQuantity: "6",
        createdByUserId: organizationId === orgA ? ids.ana : ids.beto,
        updatedByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    // A product by serial with one unit inside, its move and a task that
    // took it (WMS-21B): the move is written before its line.
    const serialProductId = newId();
    await db.product.create({
      data: {
        id: serialProductId,
        organizationId,
        sku: "EQ-001",
        name: "Equipo con serie",
        tracking: "SERIAL",
      },
    });
    const serialUnitId = newId();
    await db.serialUnit.create({
      data: {
        id: serialUnitId,
        organizationId,
        productId: serialProductId,
        serial: "SN-1",
        createdByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    const serialMovementId = newId();
    await db.stockMovement.create({
      data: {
        id: serialMovementId,
        organizationId,
        type: "ENTRY",
        createdByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    const serialLineId = newId();
    await db.serialMove.create({
      data: {
        id: newId(),
        organizationId,
        serialUnitId,
        movementLineId: serialLineId,
        productId: serialProductId,
        locationId: location.id,
        status: "AVAILABLE",
        direction: "IN",
      },
    });
    await db.stockMovementLine.create({
      data: {
        id: serialLineId,
        organizationId,
        movementId: serialMovementId,
        lineNumber: 1,
        productId: serialProductId,
        locationId: location.id,
        direction: "IN",
        capturedQuantity: "1",
        factor: "1",
        baseQuantity: "1",
        unitCode: "piece",
      },
    });
    await db.stockBalance.create({
      data: {
        id: newId(),
        organizationId,
        productId: serialProductId,
        locationId: location.id,
        quantity: "1",
      },
    });
    const serialTaskId = newId();
    await db.warehouseTask.create({
      data: {
        id: serialTaskId,
        organizationId,
        number: 2,
        productId: serialProductId,
        fromLocationId: location.id,
        toLocationId: rackId,
        quantity: "1",
        unitCode: "piece",
        createdByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    await db.warehouseTaskSerial.create({
      data: {
        id: newId(),
        organizationId,
        taskId: serialTaskId,
        serialUnitId,
      },
    });
    // A hold of stock that is not available, with its unit (WMS-30-0).
    const holdId = newId();
    await db.stockHold.create({
      data: {
        id: holdId,
        organizationId,
        productId: serialProductId,
        locationId: location.id,
        status: "INSPECTION",
        quantity: "1",
        remaining: "1",
        sourceType: "test",
        sourceId: newId(),
        sourceText: "T-1",
        createdByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    await db.stockHoldUnit.create({
      data: { id: newId(), organizationId, holdId, serialUnitId },
    });
    // A pallet holding that unit, and its history (WMS-53).
    const containerId = newId();
    await db.container.create({
      data: {
        id: containerId,
        organizationId,
        number: 1,
        code: "C-0001",
        kind: "Tarima",
        locationId: location.id,
        createdByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    await db.containerItem.create({
      data: {
        id: newId(),
        organizationId,
        containerId,
        productId: serialProductId,
        locationId: location.id,
        quantity: "1",
      },
    });
    await db.serialUnit.update({
      where: { id: serialUnitId },
      data: { containerId },
    });
    await db.containerEvent.create({
      data: {
        id: newId(),
        organizationId,
        containerId,
        kind: "CREATED",
        locationId: location.id,
        createdByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    // A capacity and a restriction of that rack (WMS-22B).
    await db.locationCapacity.create({
      data: { id: newId(), organizationId, locationId: rackId, maxUnits: "50" },
    });
    await db.locationRestriction.create({
      data: { id: newId(), organizationId, locationId: rackId, productId },
    });
    // A limit to a warehouse (WMS-20). In B it hangs from the only
    // membership there is; the services never write one for a titular.
    await db.membershipScope.create({
      data: {
        id: newId(),
        organizationId,
        membershipId:
          organizationId === orgA ? membership.id : betoMembership.id,
        facilityId: location.facilityId,
      },
    });
    const countId = newId();
    await db.stockCount.create({
      data: {
        id: countId,
        organizationId,
        locationId: location.id,
        openLocationId: location.id,
        startedByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    // A cycle count program and a count it generated (WMS-55).
    const programId = newId();
    await db.countProgram.create({
      data: {
        id: programId,
        organizationId,
        facilityId: location.facilityId,
        name: "Ciclo",
        everyDays: 7,
        locationsPerDay: 5,
        createdByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    await db.stockCount.create({
      data: {
        id: newId(),
        organizationId,
        locationId: location.id,
        status: "CANCELLED",
        closedAt: new Date(),
        programId,
        programDay: new Date("2026-11-13T00:00:00Z"),
        startedByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    // An approval rule and a request (WMS-56).
    await db.approvalRule.create({
      data: {
        id: newId(),
        organizationId,
        typeKey: "inventory.adjustment",
        enabled: true,
        approverRoles: "supervisor",
        updatedByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    await db.approvalRequest.create({
      data: {
        id: newId(),
        organizationId,
        typeKey: "inventory.count_apply",
        sourceType: "stock_count",
        sourceId: countId,
        openKey: `count:${countId}`,
        facilityId: location.facilityId,
        locationId: location.id,
        summary: "Aplicar el conteo",
        payload: { v: 1 },
        requestedByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    // A purchase request with its line (WMS-57).
    const purchaseRequestId = newId();
    await db.purchaseRequest.create({
      data: {
        id: purchaseRequestId,
        organizationId,
        number: 1,
        facilityId: location.facilityId,
        requestedByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    await db.purchaseRequestLine.create({
      data: {
        id: newId(),
        organizationId,
        requestId: purchaseRequestId,
        lineNumber: 1,
        productId,
        capturedQuantity: "2",
        factor: "1",
        baseQuantity: "2",
        unitCode: "piece",
      },
    });
    // A recipe with a version, a material, what comes out and the lock
    // of its activations (WMS-27).
    const recipeId = newId();
    const recipeVersionId = newId();
    const author = organizationId === orgA ? ids.ana : ids.beto;
    await db.recipe.create({
      data: {
        id: recipeId,
        organizationId,
        productId,
        createdByUserId: author,
      },
    });
    await db.recipeVersion.create({
      data: {
        id: recipeVersionId,
        organizationId,
        recipeId,
        number: 1,
        draftRecipeId: recipeId,
        baseQuantity: "1",
        unitCode: "piece",
        createdByUserId: author,
      },
    });
    await db.recipeInput.create({
      data: {
        id: newId(),
        organizationId,
        versionId: recipeVersionId,
        lineNumber: 1,
        productId: serialProductId,
        capturedQuantity: "2",
        factor: "1",
        baseQuantity: "2",
        unitCode: "piece",
      },
    });
    await db.recipeOutput.create({
      data: {
        id: newId(),
        organizationId,
        versionId: recipeVersionId,
        lineNumber: 1,
        productId,
        quantity: "1",
        unitCode: "piece",
        costShare: "100",
      },
    });
    await db.recipeLock.create({
      data: { id: organizationId, organizationId },
    });
    // A notice, a preference, and an incident with its note (WMS-39).
    const who = organizationId === orgA ? ids.ana : ids.beto;
    await db.notification.create({
      data: {
        id: newId(),
        organizationId,
        recipientUserId: who,
        typeKey: "inventory.task_assigned",
        text: "Te asignaron una tarea.",
        href: "/tareas",
        dedupeKey: `iso:${organizationId}`,
      },
    });
    await db.notificationPreference.create({
      data: {
        id: newId(),
        organizationId,
        userId: who,
        typeKey: "inventory.task_blocked",
        enabled: false,
      },
    });
    // A notice by mail and a daily summary (WMS-39B).
    await db.notificationEmail.create({
      data: {
        id: newId(),
        organizationId,
        notificationId: newId(),
        recipientUserId: who,
        typeKey: "inventory.task_assigned",
        text: "Te asignaron una tarea.",
        href: "/tareas",
        requirement: {},
      },
    });
    await db.dailyDigest.create({
      data: {
        id: newId(),
        organizationId,
        userId: who,
        day: new Date("2026-11-14T00:00:00.000Z"),
      },
    });
    const incidentId = newId();
    await db.incident.create({
      data: {
        id: incidentId,
        organizationId,
        number: 1,
        facilityId: location.facilityId,
        locationId: location.id,
        productId,
        kind: "DAMAGED_GOODS",
        description: "Caja aplastada",
        idempotencyKey: `iso-${incidentId}`,
        reportedByUserId: who,
      },
    });
    await db.incidentNote.create({
      data: {
        id: newId(),
        organizationId,
        incidentId,
        text: "Revisado",
        createdByUserId: who,
      },
    });
    // A photo linked as evidence of the incident (WMS-37).
    const photoFileId = newId();
    await db.storedFile.create({
      data: {
        id: photoFileId,
        organizationId,
        purpose: "incident_photo",
        name: "foto.jpg",
        contentType: "image/jpeg",
        size: 3,
        sha256: "0".repeat(64),
        storageKey: `${organizationId}/${photoFileId}`,
        createdByUserId: who,
        width: 24,
        height: 16,
      },
    });
    await db.evidencePhoto.create({
      data: {
        id: newId(),
        organizationId,
        fileId: photoFileId,
        purpose: "incident_photo",
        incidentId,
        position: 0,
        createdByUserId: who,
      },
    });
    // A key of the storage waiting for cleanup (WMS-67).
    await db.storageCleanup.create({
      data: {
        id: newId(),
        organizationId,
        storageKey: `${organizationId}/${newId()}`,
        reason: "UPLOAD",
      },
    });
    // A type of equipment, a piece of equipment and its maintenance (WMS-42).
    const equipmentTypeId = newId();
    await db.equipmentType.create({
      data: {
        id: equipmentTypeId,
        organizationId,
        name: "Montacargas",
        createdByUserId: who,
      },
    });
    const equipmentId = newId();
    await db.equipment.create({
      data: {
        id: equipmentId,
        organizationId,
        facilityId: location.facilityId,
        typeId: equipmentTypeId,
        code: "MC-01",
        name: "Montacargas 1",
        createdByUserId: who,
      },
    });
    await db.equipmentMaintenance.create({
      data: {
        id: newId(),
        organizationId,
        equipmentId,
        performedOn: new Date("2026-11-10T00:00:00.000Z"),
        description: "Cambio de aceite",
        recordedByUserId: who,
      },
    });
    // An API key, a webhook destination, an event and its delivery (WMS-60).
    await db.apiKey.create({
      data: {
        id: newId(),
        organizationId,
        name: "ERP",
        prefix: `wms_iso${organizationId === orgA ? "a" : "b"}`,
        secretHash: newId().replace(/-/g, "").padEnd(64, "0"),
        capabilities: ["stock.read"],
        facilityId: location.facilityId,
        requestsPerMinute: 60,
        createdByUserId: who,
      },
    });
    const endpointId = newId();
    await db.webhookEndpoint.create({
      data: {
        id: endpointId,
        organizationId,
        url: "https://hooks.ejemplo.com/iso",
        events: ["inventory.adjustment.applied"],
        secretCiphertext: "v1.x.y.z",
        createdByUserId: who,
      },
    });
    const webhookEventId = newId();
    await db.webhookEvent.create({
      data: {
        id: webhookEventId,
        organizationId,
        type: "inventory.adjustment.applied",
        payload: {},
      },
    });
    await db.webhookDelivery.create({
      data: {
        id: newId(),
        organizationId,
        endpointId,
        eventId: webhookEventId,
      },
    });
    // A custom field of products, a list option and a value (WMS-58).
    const customFieldId = newId();
    await db.customField.create({
      data: {
        id: customFieldId,
        organizationId,
        entity: "PRODUCT",
        key: "color",
        label: "Color",
        type: "CHOICE",
        position: 0,
        createdByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    const customOptionId = newId();
    await db.customFieldOption.create({
      data: {
        id: customOptionId,
        organizationId,
        fieldId: customFieldId,
        label: "Rojo",
        position: 0,
      },
    });
    await db.customFieldValue.create({
      data: {
        id: newId(),
        organizationId,
        fieldId: customFieldId,
        entity: "PRODUCT",
        productId,
        optionId: customOptionId,
        updatedByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    // WMS-38: a shared terminal and a PIN.
    const sharedTerminalId = newId();
    await db.sharedTerminal.create({
      data: {
        id: sharedTerminalId,
        organizationId,
        facilityId: outboundFacility,
        name: "Andén",
        createdByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    await db.sharedTerminalSecret.create({
      data: {
        id: newId(),
        organizationId,
        terminalId: sharedTerminalId,
        secretHash: newId().replace(/-/g, "").padEnd(64, "0"),
        issuedAt: new Date(),
      },
    });
    await db.memberPin.create({
      data: {
        id: newId(),
        organizationId,
        userId: organizationId === orgA ? ids.ana : ids.beto,
        pinHash: "scrypt$1$1$1$AA==$AA==",
        setAt: new Date(),
      },
    });
    // WMS-74: a process with a stage, a document following it and a step.
    const processOwner = organizationId === orgA ? ids.ana : ids.beto;
    const definitionId = newId();
    await db.processDefinition.create({
      data: {
        id: definitionId,
        organizationId,
        documentKey: "test.document",
        createdByUserId: processOwner,
      },
    });
    const versionId = newId();
    await db.processVersion.create({
      data: {
        id: versionId,
        organizationId,
        definitionId,
        number: 1,
        status: "DRAFT",
        draftKey: definitionId,
        createdByUserId: processOwner,
      },
    });
    const stageId = newId();
    await db.processStage.create({
      data: {
        id: stageId,
        organizationId,
        versionId,
        position: 0,
        name: "Revisión",
        kind: "MANUAL",
        milestoneKey: "OPEN",
      },
    });
    await db.processStageRole.create({
      data: { id: newId(), organizationId, stageId, role: "operator" },
    });
    await db.processVersion.update({
      where: { id: versionId },
      data: {
        status: "PUBLISHED",
        draftKey: null,
        currentKey: definitionId,
        publishedAt: new Date(),
      },
    });
    const progressId = newId();
    await db.processProgress.create({
      data: {
        id: progressId,
        organizationId,
        documentKey: "test.document",
        documentId: newId(),
        versionId,
        facilityId: location.facilityId,
        milestoneKey: "OPEN",
        label: "DOC-1",
      },
    });
    await db.processStageState.create({
      data: {
        id: newId(),
        organizationId,
        progressId,
        stageId,
        kind: "MANUAL",
      },
    });
    await db.processStep.create({
      data: {
        id: newId(),
        organizationId,
        progressId,
        stageId,
        action: "TAKEN",
        actorUserId: processOwner,
      },
    });
    // WMS-30A: an inspection plan with a draft, a point, an option and a defect.
    const qualityPlanId = newId();
    await db.qualityPlan.create({
      data: {
        id: qualityPlanId,
        organizationId,
        productId,
        createdByUserId: author,
      },
    });
    const qualityVersionId = newId();
    await db.qualityPlanVersion.create({
      data: {
        id: qualityVersionId,
        organizationId,
        planId: qualityPlanId,
        number: 1,
        createdByUserId: author,
      },
    });
    const qualityPointId = newId();
    await db.qualityPlanPoint.create({
      data: {
        id: qualityPointId,
        organizationId,
        versionId: qualityVersionId,
        position: 1,
        label: "Acabado",
        kind: "CHOICE",
      },
    });
    await db.qualityPlanPointOption.create({
      data: {
        id: newId(),
        organizationId,
        pointId: qualityPointId,
        position: 1,
        label: "Bueno",
        acceptable: true,
      },
    });
    await db.qualityDefect.create({
      data: {
        id: newId(),
        organizationId,
        name: "Rayado",
        createdByUserId: author,
      },
    });
    await db.qualityDefectCatalog.create({
      data: { id: newId(), organizationId },
    });
    const countLineId = newId();
    await db.stockCountLine.create({
      data: {
        id: countLineId,
        organizationId,
        countId,
        productId,
        countedAt: new Date(),
        systemQuantity: "5",
        unitCode: "piece",
      },
    });
    await db.stockCountCapture.create({
      data: {
        id: newId(),
        organizationId,
        lineId: countLineId,
        productId,
        capturedQuantity: "4",
        factor: "1",
        baseQuantity: "4",
        createdByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    await db.entitlement.create({
      data: {
        id: newId(),
        organizationId,
        kind: "MODULE",
        key: "inventory",
        validFrom: new Date(),
        subscriptionId: subscription.id,
      },
    });
    await db.manualPayment.create({
      data: {
        id: newId(),
        organizationId,
        amount: "1499.00",
        paidOn: new Date("2026-10-01T00:00:00Z"),
        reference: "SPEI-ISO",
        months: 1,
        validUntilBefore: new Date("2026-10-31T00:00:00Z"),
        validUntilAfter: new Date("2026-11-30T00:00:00Z"),
        recordedByUserId: organizationId === orgA ? ids.ana : ids.beto,
      },
    });
    await db.checkoutOrder.create({
      data: {
        id: newId(),
        organizationId,
        transactionId: `AL-ISO${organizationId === orgA ? "A" : "B"}${stamp % 1000}`,
        userId: organizationId === orgA ? ids.ana : ids.beto,
        tier: "t100",
        productLimit: 100,
        includedUsers: 2,
        modules: "inventory",
        months: 1,
        subtotal: "349.00",
        discount: "0.00",
        tax: "55.84",
        total: "404.84",
        provider: "STRIPE",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    await db.supportAccess.create({
      data: {
        id: newId(),
        organizationId,
        grantedByUserId: organizationId === orgA ? ids.ana : ids.beto,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
  }
  workerSession = await newSession(ids.worker);
  betoSession = await newSession(ids.beto);
}, 60_000);

afterAll(async () => {
  await db.$disconnect();
});

describe("company A never sees company B's data", () => {
  it.each(TENANT_MODELS)("%s through the company client", async (model) => {
    const delegate = forOrganization(orgA)[
      (model.charAt(0).toLowerCase() + model.slice(1)) as "membership"
    ] as unknown as {
      findMany(): Promise<{ organizationId: string }[]>;
    };
    const rows = await delegate.findMany();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.organizationId === orgA)).toBe(true);
    const fromB = await (
      db[
        (model.charAt(0).toLowerCase() + model.slice(1)) as "membership"
      ] as unknown as {
        count(args: unknown): Promise<number>;
      }
    ).count({ where: { organizationId: orgB } });
    expect(fromB).toBeGreaterThan(0); // B really has rows to leak
  });

  it("the audit log of A does not show B's events", async () => {
    const events = await listAuditEvents(forOrganization(orgA));
    const idsOfB = new Set(
      (await db.auditEvent.findMany({ where: { organizationId: orgB } })).map(
        (e) => e.id,
      ),
    );
    expect(idsOfB.size).toBeGreaterThan(0);
    expect(events.some((e) => idsOfB.has(e.id))).toBe(false);
  });
});

describe("changing identifiers", () => {
  it("switching to company B with its real id is refused", async () => {
    expect(
      await switchOrganization(ids.worker, workerSession, orgB),
    ).toMatchObject({ ok: false });
    expect(
      (await resolveActiveOrganization(ids.worker, workerSession))?.id,
    ).toBe(orgA);
  });

  it("using another person's session id changes nothing", async () => {
    expect(
      await switchOrganization(ids.worker, betoSession, orgA),
    ).toMatchObject({ ok: false });
    expect(await resolveActiveOrganization(ids.worker, betoSession)).toBeNull();
  });

  it("closing another person's session by id does nothing", async () => {
    expect(await revokeSession(ids.worker, betoSession, workerSession)).toBe(
      false,
    );
    expect(await db.session.count({ where: { id: betoSession } })).toBe(1);
  });

  it("the session list only shows the person's own sessions", async () => {
    const sessions = await listActiveSessions(ids.worker, workerSession);
    expect(sessions.map((s) => s.id)).toEqual([workerSession]);
  });
});

describe("tampered stored state", () => {
  it("a session pointing to company B is re-checked and sent back to A", async () => {
    await db.session.update({
      where: { id: workerSession },
      data: { activeOrganizationId: orgB },
    });
    const active = await resolveActiveOrganization(ids.worker, workerSession);
    expect(active?.id).toBe(orgA);
    const row = await db.session.findUniqueOrThrow({
      where: { id: workerSession },
    });
    expect(row.activeOrganizationId).toBe(orgA);
  });
});
