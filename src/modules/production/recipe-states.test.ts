import { describe, expect, it } from "vitest";

import {
  RECIPE_VERSION_STATUSES,
  RECIPE_VERSION_TRANSITIONS,
  canRecipeTransition,
  formatRecipeVersion,
  isRecipeVersionStatus,
  recipeTransitionProblem,
} from "./recipe-states";

// WMS-27 (ADR 0066): draft → active → retired, or draft → discarded. The
// trigger `recipe_version_transition` repeats this table.

describe("states of a recipe version", () => {
  it("allows exactly the moves of the flow", () => {
    const allowed = RECIPE_VERSION_STATUSES.flatMap((from) =>
      RECIPE_VERSION_STATUSES.filter((to) => canRecipeTransition(from, to)).map(
        (to) => `${from} → ${to}`,
      ),
    );
    expect(allowed).toEqual([
      "DRAFT → ACTIVE",
      "DRAFT → DISCARDED",
      "ACTIVE → RETIRED",
    ]);
  });

  it("nothing leaves a final state, goes back to draft, or stays", () => {
    expect(RECIPE_VERSION_TRANSITIONS.RETIRED).toEqual([]);
    expect(RECIPE_VERSION_TRANSITIONS.DISCARDED).toEqual([]);
    for (const status of RECIPE_VERSION_STATUSES) {
      expect(canRecipeTransition(status, status), status).toBe(false);
      expect(canRecipeTransition(status, "DRAFT"), status).toBe(false);
    }
    expect(canRecipeTransition("RETIRED", "ACTIVE")).toBe(false);
  });

  it("says why, in Spanish, when a move is not allowed", () => {
    expect(recipeTransitionProblem("DRAFT", "ACTIVE")).toBeNull();
    expect(recipeTransitionProblem("ACTIVE", "DRAFT")).toMatch(
      /Cambiar receta/,
    );
    expect(recipeTransitionProblem("RETIRED", "ACTIVE")).toMatch(/retiró/);
    expect(recipeTransitionProblem("DISCARDED", "ACTIVE")).toMatch(/descartó/);
  });

  it("names versions and recognizes states", () => {
    expect(formatRecipeVersion(3)).toBe("v3");
    expect(isRecipeVersionStatus("ACTIVE")).toBe(true);
    expect(isRecipeVersionStatus("PUBLISHED")).toBe(false);
    expect(isRecipeVersionStatus("toString")).toBe(false);
  });
});
