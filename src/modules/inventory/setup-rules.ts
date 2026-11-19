/**
 * Order of the setup guide (WMS-43, ADR 0083): pure, without database, so
 * the guide on Inicio and the full guide in Configuración decide the same.
 */
import type { Permission } from "@/platform/authorization";

import type { FirstSteps } from "./first-steps";

/** The steps of the guide, in the order they are offered. */
export const SETUP_STEP_KEYS = [
  "almacen",
  "ubicaciones",
  "equipo",
  "operacion",
  "productos",
  "existencias",
  "movimiento",
] as const;

export type SetupStepKey = (typeof SETUP_STEP_KEYS)[number];

export function isSetupStepKey(value: unknown): value is SetupStepKey {
  return (
    typeof value === "string" &&
    (SETUP_STEP_KEYS as readonly string[]).includes(value)
  );
}

/**
 * done: what it asks exists. skipped: not done, but a later step is (the
 * person chose to go on without it). current: the next one to do.
 * pending: after the current one.
 */
export type SetupStepStatus = "done" | "skipped" | "current" | "pending";

export type PlannedStep = { key: SetupStepKey; status: SetupStepStatus };

export type SetupPlan = {
  steps: PlannedStep[];
  /** The next step to do; null when nothing is left after the last done. */
  current: SetupStepKey | null;
  done: number;
};

/**
 * Orders the steps the person may do (`offered`) and tells each one's
 * status from `done`. A step not done before the last step done counts as
 * skipped: nothing is stored to remember a skip (ADR 0083).
 */
export function planSetupSteps(
  done: Readonly<Record<SetupStepKey, boolean>>,
  offered: ReadonlySet<SetupStepKey>,
): SetupPlan {
  const keys = SETUP_STEP_KEYS.filter((key) => offered.has(key));
  let last = -1;
  keys.forEach((key, index) => {
    if (done[key]) last = index;
  });
  let current: SetupStepKey | null = null;
  const steps = keys.map((key, index): PlannedStep => {
    if (done[key]) return { key, status: "done" };
    if (index < last) return { key, status: "skipped" };
    if (current === null) {
      current = key;
      return { key, status: "current" };
    }
    return { key, status: "pending" };
  });
  return {
    steps,
    current,
    done: steps.filter((step) => step.status === "done").length,
  };
}

/** The step after `key` among the planned ones, to skip to it. */
export function stepAfter(
  plan: SetupPlan,
  key: SetupStepKey,
): SetupStepKey | null {
  const index = plan.steps.findIndex((step) => step.key === key);
  return index < 0 ? null : (plan.steps[index + 1]?.key ?? null);
}

/** The step before `key` among the planned ones. */
export function stepBefore(
  plan: SetupPlan,
  key: SetupStepKey,
): SetupStepKey | null {
  const index = plan.steps.findIndex((step) => step.key === key);
  return index <= 0 ? null : (plan.steps[index - 1]?.key ?? null);
}

/** What the person may do, decided on the server from their access. */
export type SetupAbilities = {
  reviewFacilities: boolean;
  createLocation: boolean;
  changeLevels: boolean;
  invite: boolean;
  chooseSettings: boolean;
  importProducts: boolean;
  createProduct: boolean;
  openingBalance: boolean;
  entry: boolean;
  exit: boolean;
};

/**
 * WMS-43 (ADR 0083): each action of the guide is offered only if the
 * screen it opens may be used — the same permission that screen asks for.
 */
export function setupAbilities(
  allows: (permission: Permission) => boolean,
): SetupAbilities {
  return {
    reviewFacilities: allows("inventory.location.update"),
    createLocation: allows("inventory.location.create"),
    changeLevels: allows("inventory.location.update"),
    invite: allows("platform.team.invite") && allows("platform.team.read"),
    chooseSettings: allows("platform.organization.update"),
    importProducts: allows("inventory.import.create"),
    createProduct: allows("inventory.product.create"),
    openingBalance: allows("inventory.opening.create"),
    entry: allows("inventory.entry.create"),
    exit: allows("inventory.exit.create"),
  };
}

/** The steps that have at least one thing the person may do. */
export function offeredSteps(can: SetupAbilities): Set<SetupStepKey> {
  const offered = new Set<SetupStepKey>();
  if (can.reviewFacilities) offered.add("almacen");
  if (can.createLocation) offered.add("ubicaciones");
  if (can.invite) offered.add("equipo");
  if (can.chooseSettings) offered.add("operacion");
  if (can.importProducts || can.createProduct) offered.add("productos");
  if (can.openingBalance || can.importProducts) offered.add("existencias");
  if (can.entry || can.exit) offered.add("movimiento");
  return offered;
}

/** What is done, step by step, from what exists in the company. */
export function doneSteps(steps: FirstSteps): Record<SetupStepKey, boolean> {
  return {
    almacen: steps.facilityReady,
    ubicaciones: steps.hasOwnLocations,
    equipo: steps.hasTeam === true,
    operacion: steps.settingsChosen === true,
    productos: steps.hasProducts,
    existencias: steps.hasStock,
    movimiento: steps.hasMovement,
  };
}
