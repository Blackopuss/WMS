"use server";

import { revalidatePath } from "next/cache";

import { isAppError } from "@/lib";
import {
  archiveLocation,
  createLocation,
  editLocation,
  moveLocation,
  restoreLocation,
  saveLocationLevels,
  setLocationLimits,
  type LocationField,
  type LocationResult,
} from "@/platform/locations";
import { customFieldsFromForm } from "@/platform/custom-fields";
import { requireOrganizationContext } from "@/platform/tenancy";

const LOCATIONS_PATH = "/ubicaciones";

/** Capacity and restrictions as the form sends them (WMS-22B). */
export type LimitValues = {
  maxUnits: string;
  maxWeight: string;
  maxVolume: string;
  /** Codes (SKU) of the only products admitted, one per line. */
  products: string;
  /** Ids of the only categories admitted. */
  categoryIds: string[];
};

export type LocationFormState = {
  /** True right after the change was applied (the dialog closes). */
  done?: boolean;
  fieldErrors: Partial<Record<LocationField, string>>;
  formError?: string;
  /** WMS-58: problems of the custom fields, by key. */
  customErrors?: Record<string, string>;
  values: {
    name: string;
    /** Depth of the level, as the select sends it. */
    level: string;
    parentId: string;
    code: string;
    type: string;
    limits: LimitValues;
    /** WMS-58: custom fields as typed, by key. */
    custom: Record<string, string>;
  };
};

const NO_LIMITS: LimitValues = {
  maxUnits: "",
  maxWeight: "",
  maxVolume: "",
  products: "",
  categoryIds: [],
};

const NO_VALUES: LocationFormState["values"] = {
  name: "",
  level: "",
  parentId: "",
  code: "",
  type: "",
  limits: NO_LIMITS,
  custom: {},
};

export type LocationActionResult = { ok: true } | { ok: false; error: string };

/**
 * Runs a change with the person and the company of the session (never
 * from the form) and turns "not allowed" into a message.
 */
async function change(
  run: (actor: {
    organizationId: string;
    userId: string;
  }) => Promise<LocationResult>,
): Promise<LocationResult> {
  const { user, organization } = await requireOrganizationContext();
  try {
    const result = await run({
      organizationId: organization.id,
      userId: user.id,
    });
    if (result.ok) revalidatePath(LOCATIONS_PATH, "layout");
    return result;
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return {
        ok: false,
        reason: "not_allowed",
        fieldErrors: {},
        formError: error.message,
      };
    }
    throw error;
  }
}

const formState = (
  result: LocationResult,
  values: LocationFormState["values"],
): LocationFormState =>
  result.ok
    ? { done: true, fieldErrors: {}, values }
    : {
        fieldErrors: result.fieldErrors,
        formError: result.formError,
        customErrors: result.customErrors,
        values,
      };

const simple = (result: LocationResult): LocationActionResult =>
  result.ok
    ? { ok: true }
    : {
        ok: false,
        error:
          result.formError ??
          Object.values(result.fieldErrors)[0] ??
          "No se pudo aplicar el cambio.",
      };

const text = (formData: FormData, name: string) =>
  String(formData.get(name) ?? "");

/** The capacity and restriction fields of a form, bounded. */
const limitsOf = (formData: FormData): LimitValues => ({
  maxUnits: text(formData, "maxUnits").slice(0, 40),
  maxWeight: text(formData, "maxWeight").slice(0, 40),
  maxVolume: text(formData, "maxVolume").slice(0, 40),
  products: text(formData, "products").slice(0, 20_000),
  categoryIds: formData
    .getAll("categoryIds")
    .filter((value): value is string => typeof value === "string")
    .slice(0, 500)
    .map((value) => value.slice(0, 36)),
});

/** Adds a location in the warehouse the person works in. */
export async function createLocationAction(
  _prev: LocationFormState,
  formData: FormData,
): Promise<LocationFormState> {
  const values = {
    name: text(formData, "name"),
    level: text(formData, "level"),
    parentId: text(formData, "parentId"),
    code: text(formData, "code"),
    type: text(formData, "type"),
    limits: limitsOf(formData),
    custom: customFieldsFromForm(formData) as Record<string, string>,
  };
  const result = await change((actor) =>
    createLocation(actor, { ...values, customFields: values.custom }),
  );
  // After adding, ready for the next one in the same place; after a
  // refusal, what was typed stays.
  return formState(
    result,
    result.ok
      ? { ...values, name: "", code: "", limits: NO_LIMITS, custom: {} }
      : values,
  );
}

/** Changes the name, code or use of a location. Its id is bound by the
 * page and looked for only inside the company of the session. */
export async function editLocationAction(
  locationId: string,
  _prev: LocationFormState,
  formData: FormData,
): Promise<LocationFormState> {
  const values = {
    ...NO_VALUES,
    name: text(formData, "name"),
    code: text(formData, "code"),
    type: text(formData, "type"),
    custom: customFieldsFromForm(formData) as Record<string, string>,
  };
  return formState(
    await change((actor) =>
      editLocation(actor, String(locationId), {
        name: values.name,
        code: values.code,
        type: values.type,
        customFields: values.custom,
      }),
    ),
    values,
  );
}

/**
 * Sets the capacity and the restrictions of a location (WMS-22B). Its id
 * is bound by the page and looked for only inside the company of the
 * session; products and categories too.
 */
export async function setLocationLimitsAction(
  locationId: string,
  _prev: LocationFormState,
  formData: FormData,
): Promise<LocationFormState> {
  const values = { ...NO_VALUES, limits: limitsOf(formData) };
  return formState(
    await change((actor) =>
      setLocationLimits(actor, String(locationId), values.limits),
    ),
    values,
  );
}

/** Moves a location into another one, or to the facility itself. */
export async function moveLocationAction(
  locationId: string,
  _prev: LocationFormState,
  formData: FormData,
): Promise<LocationFormState> {
  const values = { ...NO_VALUES, parentId: text(formData, "parentId") };
  return formState(
    await change((actor) =>
      moveLocation(actor, String(locationId), { parentId: values.parentId }),
    ),
    values,
  );
}

export async function archiveLocationAction(
  locationId: string,
): Promise<LocationActionResult> {
  return simple(
    await change((actor) => archiveLocation(actor, String(locationId))),
  );
}

export async function restoreLocationAction(
  locationId: string,
): Promise<LocationActionResult> {
  return simple(
    await change((actor) => restoreLocation(actor, String(locationId))),
  );
}

export type LevelsFormState = {
  done?: boolean;
  error?: string;
  /** What was sent, so a refused form keeps it. */
  levels: { id: string; name: string }[];
  answers: number;
};

/**
 * Saves the levels of the warehouse the person works in. The form sends
 * them as JSON (`levels`): ids of the ones that exist and the names typed.
 */
export async function saveLevelsAction(
  prev: LevelsFormState,
  formData: FormData,
): Promise<LevelsFormState> {
  let levels: { id: string; name: string }[] = [];
  try {
    const parsed: unknown = JSON.parse(
      text(formData, "levels").slice(0, 10_000),
    );
    if (Array.isArray(parsed)) {
      levels = parsed.slice(0, 20).map((each) => ({
        id: String((each as { id?: unknown })?.id ?? "").slice(0, 36),
        name: String((each as { name?: unknown })?.name ?? "").slice(0, 80),
      }));
    }
  } catch {
    levels = [];
  }
  const result = await change((actor) => saveLocationLevels(actor, { levels }));
  const answers = prev.answers + 1;
  if (result.ok) return { done: true, levels, answers };
  return {
    error:
      result.formError ??
      Object.values(result.fieldErrors)[0] ??
      "No se pudieron guardar los niveles.",
    levels,
    answers,
  };
}
