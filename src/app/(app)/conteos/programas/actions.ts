"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isAppError } from "@/lib";
import {
  createCountProgram,
  generateTodayCounts,
  setCountProgramPaused,
  updateCountProgram,
  type ProgramField,
} from "@/modules/inventory";
import { requireOrganizationContext } from "@/platform/tenancy";

export type ProgramFormValues = {
  name: string;
  rootLocationId: string;
  basis: string;
  everyDays: string;
  everyDaysB: string;
  everyDaysC: string;
  locationsPerDay: string;
};

export type ProgramFormState = {
  error?: string;
  field?: ProgramField;
  values: ProgramFormValues;
  /** Answers so far: remounts the selects after a rejected send. */
  answers: number;
};

const text = (formData: FormData, name: string, max: number) =>
  String(formData.get(name) ?? "").slice(0, max);

/**
 * Creates a cycle count program or changes one (WMS-55). Person and
 * company come from the session; the program, when it is a change, is
 * looked for only inside that company and the person's scope.
 */
export async function saveCountProgramAction(
  prev: ProgramFormState,
  formData: FormData,
): Promise<ProgramFormState> {
  const { user, organization } = await requireOrganizationContext();
  const programId = text(formData, "programId", 36);
  const values: ProgramFormValues = {
    name: text(formData, "name", 120),
    rootLocationId: text(formData, "rootLocationId", 36),
    basis: text(formData, "basis", 8),
    everyDays: text(formData, "everyDays", 6),
    everyDaysB: text(formData, "everyDaysB", 6),
    everyDaysC: text(formData, "everyDaysC", 6),
    locationsPerDay: text(formData, "locationsPerDay", 6),
  };
  const actor = { organizationId: organization.id, userId: user.id };
  const input = {
    ...values,
    basis: values.basis as "EVEN" | "ABC",
  };
  let result;
  try {
    result = programId
      ? await updateCountProgram(actor, programId, input)
      : await createCountProgram(actor, input);
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { error: error.message, values, answers: prev.answers + 1 };
    }
    throw error;
  }
  if (!result.ok) {
    return {
      error: result.error,
      field: result.field,
      values,
      answers: prev.answers + 1,
    };
  }
  revalidatePath("/conteos/programas");
  redirect(`/conteos/programas/${result.programId}?guardado=1`);
}

export type ProgramChangeState =
  { ok: true; summary: string } | { ok: false; error: string };

/** Pauses a program or puts it back to work. */
export async function pauseCountProgramAction(
  programId: string,
  paused: boolean,
): Promise<ProgramChangeState> {
  const { user, organization } = await requireOrganizationContext();
  try {
    const result = await setCountProgramPaused(
      { organizationId: organization.id, userId: user.id },
      String(programId).slice(0, 36),
      paused === true,
    );
    if (!result.ok) return { ok: false, error: result.error };
    revalidatePath("/conteos/programas");
    revalidatePath(`/conteos/programas/${String(programId).slice(0, 36)}`);
    return {
      ok: true,
      summary: paused
        ? "Programa en pausa: no generará conteos."
        : "Programa reanudado: generará los conteos que le toquen.",
    };
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

/** Generates now the counts of today of a program (what the round does). */
export async function generateTodayCountsAction(
  programId: string,
): Promise<ProgramChangeState> {
  const { user, organization } = await requireOrganizationContext();
  try {
    const result = await generateTodayCounts(
      { organizationId: organization.id, userId: user.id },
      String(programId).slice(0, 36),
    );
    if (!result.ok) return { ok: false, error: result.error };
    revalidatePath("/conteos");
    revalidatePath(`/conteos/programas/${String(programId).slice(0, 36)}`);
    return { ok: true, summary: result.summary };
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}
