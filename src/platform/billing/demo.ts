import "server-only";

import { z } from "zod";

import { DEFAULT_TIME_ZONE, log, newId } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import {
  FILE_STORAGE_LIMIT_KEY,
  ensureQuotaRows,
  invalidateEntitlements,
} from "@/platform/entitlements";
import { demoCompanyEmail, sendEmail } from "@/platform/email";
import { enqueueJob } from "@/platform/jobs";
import { ensureDefaultLocation } from "@/platform/locations";
import {
  LOCKING_TRANSACTION,
  db,
  forOrganization,
  type TenantDb,
} from "@/server";

import { isPlatformStaff, setEntitlement } from "./provisioning";
import type { ModuleRegistry } from "./registry";

/**
 * Demonstration companies (WMS-44, ADR 0089). Platform staff create one,
 * from the internal console, for an account that already exists, has its
 * email confirmed and belongs to no company: that account becomes its
 * titular, as if it had created its company. In the same transaction the
 * company gets a fixed plan (every available module, small limits, two
 * weeks) and a job that loads a data set through the real services.
 *
 * Nothing is deleted: a demonstration expires with its plan and stays
 * read-only, marked; another one is made with another account.
 */

/** Job that loads the data of a demonstration (handler in the modules). */
export const DEMO_PREPARE_JOB = "platform.demo_prepare";

/** The fixed plan of a demonstration (the founder may change it). */
export const DEMO_PLAN = {
  productLimit: 100,
  users: 3,
  facilities: 1,
  storageGb: 1,
  days: 14,
} as const;

/** Default name in the console form; staff may write another. */
export const DEMO_DEFAULT_NAME = "Empresa de demostración";

const demoSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Escribe el correo de la cuenta.")
    .max(254, "El correo es demasiado largo.")
    .pipe(z.email("Escribe un correo válido.")),
  name: z
    .string()
    .trim()
    .min(2, "Escribe el nombre de la empresa (mínimo 2 caracteres).")
    .max(120, "El nombre es demasiado largo (máximo 120 caracteres)."),
  dataset: z.string().max(40),
});

export type DemoInput = { email: string; name: string; dataset: string };
export type DemoField = "email" | "name" | "dataset";

export type CreateDemoResult =
  | { ok: true; organizationId: string }
  | {
      ok: false;
      fieldErrors: Partial<Record<DemoField, string>>;
      formError?: string;
    };

/** End of the day, `days` from today, in central Mexico (UTC-6). */
export function demoValidUntil(now: Date, days: number = DEMO_PLAN.days) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const [year, month, day] = today.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const last = new Date(Date.UTC(year, month - 1, day + days));
  return new Date(`${last.toISOString().slice(0, 10)}T23:59:59.999-06:00`);
}

class Refused extends Error {
  constructor(readonly result: Extract<CreateDemoResult, { ok: false }>) {
    super("refused");
  }
}

/**
 * Creates a demonstration company for an existing account and queues the
 * loading of its data. Concurrent requests for the same account create at
 * most one company (the account row is locked, as in `createOrganization`).
 */
export async function createDemoCompany(
  registry: ModuleRegistry,
  staffUserId: string,
  input: DemoInput,
  options: { datasets: readonly string[] },
): Promise<CreateDemoResult> {
  if (!(await isPlatformStaff(staffUserId))) {
    return {
      ok: false,
      fieldErrors: {},
      formError: "No tienes permiso para hacer esto.",
    };
  }
  const parsed = demoSchema.safeParse({
    email: String(input.email ?? ""),
    name: String(input.name ?? ""),
    dataset: String(input.dataset ?? ""),
  });
  if (!parsed.success) {
    const fieldErrors: Partial<Record<DemoField, string>> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[issue.path[0] as DemoField] ??= issue.message;
    }
    return { ok: false, fieldErrors };
  }
  const { email, name, dataset } = parsed.data;
  if (!options.datasets.includes(dataset)) {
    return {
      ok: false,
      fieldErrors: { dataset: "Ese juego de datos no existe." },
    };
  }
  const modules = registry.all
    .filter((contract) => contract.availability === "available")
    .map((contract) => contract.id);

  const organizationId = newId();
  let ownerOf: { name: string; email: string } | null = null;
  try {
    await db.$transaction(async (tx) => {
      // Lock the account first, before any other read, so two requests
      // cannot both pass the check below (READ COMMITTED: what is read
      // after the lock is what is committed now).
      const [owner] = await tx.$queryRaw<
        { id: string; name: string; emailVerified: number | boolean }[]
      >`SELECT id, name, emailVerified FROM user WHERE email = ${email} FOR UPDATE`;
      const problem = await accountProblem(tx, owner);
      if (problem || !owner) {
        throw new Refused({
          ok: false,
          fieldErrors: { email: problem ?? NO_ACCOUNT },
        });
      }
      ownerOf = { name: owner.name, email };
      const now = new Date();
      const validUntil = demoValidUntil(now);
      await tx.organization.create({
        data: {
          id: organizationId,
          name,
          timeZone: DEFAULT_TIME_ZONE,
          currency: "MXN",
          ownerUserId: owner.id,
          isDemo: true,
          memberships: { create: { id: newId(), userId: owner.id } },
        },
      });
      await ensureDefaultLocation(tx, organizationId);
      await ensureQuotaRows(tx, organizationId);
      const limits = [
        ["active_products", DEMO_PLAN.productLimit],
        ["users", DEMO_PLAN.users],
        ["facilities", DEMO_PLAN.facilities],
        [FILE_STORAGE_LIMIT_KEY, DEMO_PLAN.storageGb],
      ] as const;
      for (const [key, value] of limits) {
        await setEntitlement(
          tx,
          organizationId,
          "LIMIT",
          key,
          value,
          validUntil,
          now,
        );
      }
      for (const id of modules) {
        await setEntitlement(
          tx,
          organizationId,
          "MODULE",
          id,
          null,
          validUntil,
          now,
        );
      }
      const demoId = newId();
      await tx.demoCompany.create({
        data: {
          id: demoId,
          organizationId,
          dataset,
          createdByUserId: staffUserId,
        },
      });
      // Same transaction: the job exists only if the company does. The
      // company is created here, so this is a plain transaction client;
      // `enqueueJob` only inserts one row that names the company itself.
      await enqueueJob(tx as unknown as Pick<TenantDb, "job">, organizationId, {
        type: DEMO_PREPARE_JOB,
        payload: { demoId },
        createdByUserId: staffUserId,
        // Loading again would repeat data that is never deleted.
        maxAttempts: 1,
      });
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId: staffUserId,
        action: "demo.created",
        target: { type: "organization", id: organizationId },
        metadata: {
          name,
          dataset,
          productLimit: DEMO_PLAN.productLimit,
          users: DEMO_PLAN.users,
          facilities: DEMO_PLAN.facilities,
          storageGb: DEMO_PLAN.storageGb,
          modules: registry.all
            .filter((m) => modules.includes(m.id))
            .map((m) => m.name),
          validUntil: validUntil.toISOString(),
          byPlatformStaff: true,
        },
      });
    }, LOCKING_TRANSACTION);
  } catch (error) {
    if (error instanceof Refused) return error.result;
    throw error;
  }
  invalidateEntitlements(organizationId);
  // After the commit, and never undoing it: the person learns that this
  // account is now the titular of a demonstration (and what that means).
  if (ownerOf) {
    const { name: ownerName, email: to } = ownerOf;
    try {
      await sendEmail(
        demoCompanyEmail({
          to,
          name: ownerName,
          organizationName: name,
          days: DEMO_PLAN.days,
        }),
      );
    } catch (error) {
      log.warn("demo_company_email_failed", {
        organizationId,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  return { ok: true, organizationId };
}

const NO_ACCOUNT = "No hay una cuenta con ese correo.";

/**
 * Why an account cannot receive a demonstration, or null. The same rules
 * for the preview (no lock) and for creating it (under the account lock).
 */
async function accountProblem(
  client: Pick<typeof db, "membership" | "platformStaff">,
  owner: { id: string; emailVerified: number | boolean } | undefined,
): Promise<string | null> {
  if (!owner) return NO_ACCOUNT;
  if (!owner.emailVerified) return "Esa cuenta todavía no confirma su correo.";
  const [memberships, staff] = await Promise.all([
    client.membership.count({ where: { userId: owner.id, status: "ACTIVE" } }),
    client.platformStaff.count({ where: { userId: owner.id } }),
  ]);
  // The console and a customer company stay apart: platform staff use a
  // separate account to look at a demonstration.
  if (staff > 0) {
    return "Esa cuenta es del personal de plataforma: usa otra cuenta para la demostración.";
  }
  if (memberships > 0) return "Esa cuenta ya pertenece a una empresa.";
  return null;
}

export type DemoPreviewResult =
  | { ok: true; name: string; email: string }
  | { ok: false; fieldErrors: Partial<Record<DemoField, string>> };

/**
 * The account a demonstration would go to, before creating it (platform
 * staff only): the console shows its name and asks to confirm, so a typo
 * in the email does not tie someone else's account to a demonstration.
 * Writes nothing; creating checks everything again under the lock.
 */
export async function previewDemoAccount(
  staffUserId: string,
  input: { email: string },
): Promise<DemoPreviewResult> {
  if (!(await isPlatformStaff(staffUserId))) {
    return { ok: false, fieldErrors: { email: NO_ACCOUNT } };
  }
  const parsed = demoSchema.shape.email.safeParse(String(input.email ?? ""));
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: { email: parsed.error.issues[0]?.message ?? NO_ACCOUNT },
    };
  }
  const owner = await db.user.findUnique({
    where: { email: parsed.data },
    select: { id: true, name: true, email: true, emailVerified: true },
  });
  const problem = await accountProblem(db, owner ?? undefined);
  if (problem || !owner) {
    return { ok: false, fieldErrors: { email: problem ?? NO_ACCOUNT } };
  }
  return { ok: true, name: owner.name, email: owner.email };
}

// ── Preparation, by the worker ──────────────────────────────────────────

/**
 * Takes the loading of a demonstration, once: the first run of its job
 * claims it; any other run (or a demonstration already finished) gets
 * null and must do nothing.
 */
export async function claimDemoPreparation(
  organizationId: string,
): Promise<{ dataset: string; ownerUserId: string } | null> {
  const client = forOrganization(organizationId);
  const claimed = await client.demoCompany.updateMany({
    where: { status: "PREPARING", claimedAt: null },
    data: { claimedAt: new Date() },
  });
  if (claimed.count !== 1) return null;
  const [demo, organization] = await Promise.all([
    client.demoCompany.findFirstOrThrow({ select: { dataset: true } }),
    db.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { ownerUserId: true },
    }),
  ]);
  return { dataset: demo.dataset, ownerUserId: organization.ownerUserId };
}

/** One line for the console: no stack, no line breaks. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 500) || "Error desconocido";
}

/**
 * Closes the preparation: ready, or failed with why. Only a preparation
 * still running changes (a second call does nothing).
 */
export async function finishDemoPreparation(
  organizationId: string,
  outcome: { ok: true } | { ok: false; failure: string },
): Promise<void> {
  await forOrganization(organizationId).demoCompany.updateMany({
    where: { status: "PREPARING" },
    data: outcome.ok
      ? { status: "READY", finishedAt: new Date() }
      : {
          status: "FAILED",
          finishedAt: new Date(),
          failure: oneLine(outcome.failure),
        },
  });
}

// ── Reading, for the console ─────────────────────────────────────────────

export type DemoCompanyView = {
  organizationId: string;
  name: string;
  ownerName: string;
  ownerEmail: string;
  dataset: string;
  status: "PREPARING" | "READY" | "FAILED";
  failure: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  /** End of its plan (the products limit); null if it has none. */
  validUntil: Date | null;
};

const demoSelect = {
  organizationId: true,
  dataset: true,
  status: true,
  failure: true,
  createdAt: true,
  finishedAt: true,
  organization: {
    select: {
      name: true,
      owner: { select: { name: true, email: true } },
      entitlements: {
        where: { kind: "LIMIT", key: "active_products" },
        select: { validUntil: true },
      },
    },
  },
} as const;

type DemoRow = {
  organizationId: string;
  dataset: string;
  status: "PREPARING" | "READY" | "FAILED";
  failure: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  organization: {
    name: string;
    owner: { name: string; email: string };
    entitlements: { validUntil: Date | null }[];
  };
};

function viewOf(row: DemoRow): DemoCompanyView {
  return {
    organizationId: row.organizationId,
    name: row.organization.name,
    ownerName: row.organization.owner.name,
    ownerEmail: row.organization.owner.email,
    dataset: row.dataset,
    status: row.status,
    failure: row.failure,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
    validUntil: row.organization.entitlements[0]?.validUntil ?? null,
  };
}

/** Demonstrations, newest first (platform staff only). */
export async function listDemoCompanies(
  staffUserId: string,
  limit = 50,
): Promise<DemoCompanyView[]> {
  if (!(await isPlatformStaff(staffUserId))) return [];
  const rows = await db.demoCompany.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: Math.min(Math.max(limit, 1), 100),
    select: demoSelect,
  });
  return rows.map(viewOf);
}

/** One demonstration (platform staff only); null when it is not one. */
export async function getDemoCompany(
  staffUserId: string,
  organizationId: string,
): Promise<DemoCompanyView | null> {
  if (!(await isPlatformStaff(staffUserId))) return null;
  const row = await db.demoCompany.findUnique({
    where: { organizationId: String(organizationId).slice(0, 36) },
    select: demoSelect,
  });
  return row ? viewOf(row) : null;
}
