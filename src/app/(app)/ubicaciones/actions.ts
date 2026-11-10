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
  type LocationField,
  type LocationResult,
} from "@/platform/locations";
import { requireOrganizationContext } from "@/platform/tenancy";

const LOCATIONS_PATH = "/ubicaciones";

export type LocationFormState = {
  /** True right after the change was applied (the dialog closes). */
  done?: boolean;
  fieldErrors: Partial<Record<LocationField, string>>;
  formError?: string;
  values: {
    name: string;
    /** Depth of the level, as the select sends it. */
    level: string;
    parentId: string;
    code: string;
    type: string;
  };
};

const NO_VALUES: LocationFormState["values"] = {
  name: "",
  level: "",
  parentId: "",
  code: "",
  type: "",
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
  };
  const result = await change((actor) => createLocation(actor, values));
  // After adding, ready for the next one in the same place; after a
  // refusal, what was typed stays.
  return formState(
    result,
    result.ok ? { ...values, name: "", code: "" } : values,
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
  };
  return formState(
    await change((actor) =>
      editLocation(actor, String(locationId), {
        name: values.name,
        code: values.code,
        type: values.type,
      }),
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
