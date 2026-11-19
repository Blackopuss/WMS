import { expect } from "vitest";

import { newId } from "@/lib";
import {
  reconcileStock,
  reconcileValue,
  registerEntry,
} from "@/modules/inventory";
import {
  activateRecipeVersion,
  createProductionOrder,
  createRecipe,
  setRecipeInput,
  type ProductionActor,
} from "@/modules/production";
import { moduleRegistry, operationSettings } from "@/modules/registry";
import type { Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import { createLocation } from "@/platform/locations";
import { updateOperationSetting } from "@/platform/settings";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// Fixtures of the production tests (WMS-28, WMS-29): a company with
// Producción, people with roles and scopes, products, places, stock,
// recipes and orders. Shared by the report tests (ADR 0087).

const stamp = Date.now();
let counter = 0;
let staff = "";

export async function newUser(name = "Persona") {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: `${name} ${++counter}`,
      email: `prod.report.${counter}.${stamp}@example.test`,
      emailVerified: true,
      twoFactorEnabled: true,
    },
  });
  return user.id;
}

export async function company(modules = ["inventory", "production"]) {
  const owner = await newUser("Titular");
  const created = await createOrganization(owner, {
    name: `Producción ${counter}`,
    timeZone: "",
  });
  if (!created.ok) throw new Error("company setup failed");
  if (!staff) {
    staff = await newUser("Plataforma");
    await db.platformStaff.create({ data: { userId: staff } });
  }
  const result = await provisionCompany(
    moduleRegistry,
    staff,
    created.organizationId,
    {
      productLimit: 400,
      users: 30,
      facilities: 60,
      modules,
      validUntil: null,
      reason: "Prueba de órdenes de producción",
    },
  );
  if (!result.ok) throw new Error(`provision failed ${JSON.stringify(result)}`);
  const owner_ = { organizationId: created.organizationId, userId: owner };
  const facility = await db.facility.findFirstOrThrow({
    where: { organizationId: created.organizationId, isDefault: true },
    select: { id: true },
  });
  return { owner: owner_, facilityId: facility.id };
}

export async function member(
  organizationId: string,
  roles: Role[],
  scope: { facilityId: string; locationId?: string }[] = [],
): Promise<ProductionActor> {
  const userId = await newUser(roles.join("-"));
  const membership = await db.membership.create({
    data: { id: newId(), organizationId, userId, status: "ACTIVE" },
  });
  for (const role of roles) {
    await db.membershipRole.create({
      data: { id: newId(), organizationId, membershipId: membership.id, role },
    });
  }
  for (const row of scope) {
    await db.membershipScope.create({
      data: {
        id: newId(),
        organizationId,
        membershipId: membership.id,
        facilityId: row.facilityId,
        locationId: row.locationId ?? null,
      },
    });
  }
  return { organizationId, userId };
}

let skus = 0;
export async function product(
  actor: ProductionActor,
  name: string,
  card: {
    unit?: string;
    step?: string;
    tracking?: "NONE" | "LOT" | "SERIAL";
    lotExpiry?: "NONE" | "OPTIONAL" | "REQUIRED";
  } = {},
) {
  const created = await createProduct(actor, {
    sku: `OP-${++skus}-${stamp % 100000}`,
    name: `${name} ${skus}`,
    ...card,
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  return created.productId;
}

export async function place(
  actor: ProductionActor,
  name: string,
  extra: { type?: string; parentId?: string; level?: number } = {},
) {
  const created = await createLocation(actor, {
    level: extra.level ?? (extra.parentId ? 3 : 1),
    name: `${name} ${++counter}`,
    ...(extra.type ? { type: extra.type } : {}),
    ...(extra.parentId ? { parentId: extra.parentId } : {}),
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  return created.locationId;
}

export async function enter(
  actor: ProductionActor,
  productId: string,
  locationId: string,
  quantity: string,
  extra: { lotCode?: string; lotExpiresOn?: string; serials?: string } = {},
) {
  const entered = await registerEntry(actor, {
    productId,
    locationId,
    quantity,
    acceptRepeat: true,
    ...extra,
  });
  if (!entered.ok) throw new Error(JSON.stringify(entered));
}

/** A recipe in force: `makes` (base `base`) with each material. */
export async function recipe(
  actor: ProductionActor,
  makes: string,
  uses: [string, string][],
  base = "1",
) {
  const created = await createRecipe(actor, makes, { baseQuantity: base });
  if (!created.ok) throw new Error(JSON.stringify(created));
  for (const [productId, quantity] of uses) {
    const added = await setRecipeInput(actor, created.versionId, {
      productId,
      quantity,
    });
    if (!added.ok) throw new Error(JSON.stringify(added));
  }
  const activated = await activateRecipeVersion(actor, created.versionId);
  if (!activated.ok) throw new Error(JSON.stringify(activated));
  return created;
}

export async function order(
  actor: ProductionActor,
  productId: string,
  areaLocationId: string,
  quantity: string,
  extra: { assigneeIds?: string[] } = {},
) {
  const made = await createProductionOrder(actor, {
    productId,
    quantity,
    areaLocationId,
    ...extra,
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.orderId;
}

export async function setting(actor: ProductionActor, key: string, value: string) {
  const result = await updateOperationSetting(
    actor,
    operationSettings,
    key,
    value,
  );
  if (!result.ok) throw new Error(result.error);
}

export const reservedOf = async (lineId: string, locationId?: string) =>
  (
    await db.stockReservation.findMany({
      where: {
        sourceType: "production_order_line",
        sourceId: lineId,
        state: "ACTIVE",
        ...(locationId ? { locationId } : {}),
      },
      select: { remaining: true, locationId: true, lotId: true },
      orderBy: { id: "asc" },
    })
  ).map((row) => ({
    remaining: row.remaining.toString(),
    locationId: row.locationId,
    lotId: row.lotId,
  }));

export const linesOf = (orderId: string) =>
  db.productionOrderLine.findMany({
    where: { orderId },
    orderBy: { lineNumber: "asc" },
  });

export async function balanced(organizationId: string) {
  expect(await reconcileStock(organizationId)).toEqual([]);
  expect(await reconcileValue(organizationId)).toEqual([]);
}

/** A crate made of boards and screws, with stock of both on a shelf. */
export async function workshop(modules?: string[]) {
  const { owner, facilityId } = await company(modules);
  const area = await place(owner, "Línea", { type: "PRODUCTION" });
  const shelf = await place(owner, "Rack");
  const crate = await product(owner, "Crate");
  const board = await product(owner, "Tabla");
  const screw = await product(owner, "Pija");
  await recipe(owner, crate, [
    [board, "4"],
    [screw, "5"],
  ]);
  await enter(owner, board, shelf, "100");
  await enter(owner, screw, shelf, "100");
  return { owner, facilityId, area, shelf, crate, board, screw };
}

