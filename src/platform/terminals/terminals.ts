import "server-only";

import { z } from "zod";

import { newId } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import {
  hashTerminalSecret,
  newTerminalSecret,
  terminalCookieValue,
  terminalOfDevice,
} from "@/platform/auth";
import { assertAllowed, loadScope } from "@/platform/authorization";
import { db, forOrganization, LOCKING_TRANSACTION, lockRows } from "@/server";

/**
 * Shared terminals of a company (WMS-38, ADR 0061 §1-2): register this
 * device as one, list them and remove them. Registering and removing need
 * `platform.terminal.manage` (titular, administration); seeing them,
 * `platform.terminal.read` (also Gerencia). A person limited to warehouses
 * (WMS-20) only sees and manages the terminals of theirs.
 */

export type TerminalActor = { organizationId: string; userId: string };

export const TERMINAL_NAME_MAX = 60;
export const TERMINAL_REMOVE_REASON_MAX = 500;
/** At most this many terminals are listed. */
export const TERMINALS_MAX = 200;

export type TerminalView = {
  id: string;
  name: string;
  facilityId: string;
  facilityName: string;
  createdByName: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  /** This very browser is that terminal. */
  thisDevice: boolean;
};

export type RegisterTerminalResult =
  | {
      ok: true;
      terminalId: string;
      /** Value of the terminal cookie: the action sets it on this browser. */
      cookieValue: string;
    }
  | {
      ok: false;
      formError?: string;
      fieldErrors?: Partial<Record<"name" | "facilityId", string>>;
    };

export type RemoveTerminalResult =
  { ok: true; closedSessions: number } | { ok: false; error: string };

const registerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Escribe un nombre para la terminal.")
    .max(
      TERMINAL_NAME_MAX,
      `El nombre puede tener hasta ${TERMINAL_NAME_MAX} caracteres.`,
    ),
  facilityId: z.string().trim().min(1, "Elige un almacén.").max(36),
});

function inScope(
  scope: Awaited<ReturnType<typeof loadScope>>,
  facilityId: string,
): boolean {
  return scope === null || scope.facilities.has(facilityId);
}

/** Warehouses where the person may register a terminal: active, in scope. */
export async function terminalFacilities(
  actor: TerminalActor,
): Promise<{ id: string; name: string }[]> {
  await assertAllowed(
    actor.organizationId,
    actor.userId,
    "platform.terminal.manage",
  );
  const client = forOrganization(actor.organizationId);
  const [facilities, scope] = await Promise.all([
    client.facility.findMany({
      where: { archivedAt: null },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }, { id: "asc" }],
      select: { id: true, name: true },
    }),
    loadScope(client, actor.userId),
  ]);
  return facilities.filter((f) => inScope(scope, f.id));
}

/**
 * Registers the browser the person is using as a terminal of a warehouse.
 * Returns the cookie value; the caller sets it (HttpOnly) and closes its
 * own session on this device.
 */
export async function registerTerminal(
  actor: TerminalActor,
  input: { name: unknown; facilityId: unknown },
): Promise<RegisterTerminalResult> {
  await assertAllowed(
    actor.organizationId,
    actor.userId,
    "platform.terminal.manage",
  );
  const parsed = registerSchema.safeParse({
    name: String(input.name ?? ""),
    facilityId: String(input.facilityId ?? ""),
  });
  if (!parsed.success) {
    const fieldErrors: Partial<Record<"name" | "facilityId", string>> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if ((field === "name" || field === "facilityId") && !fieldErrors[field]) {
        fieldErrors[field] = issue.message;
      }
    }
    return { ok: false, fieldErrors };
  }
  const { name, facilityId } = parsed.data;
  // Defensive: on a terminal nobody has a full session to get here.
  const device = await terminalOfDevice();
  if (device?.organizationId === actor.organizationId) {
    return {
      ok: false,
      formError: `Este dispositivo ya es la terminal «${device.name}».`,
    };
  }
  const secret = newTerminalSecret();
  const terminalId = newId();
  const client = forOrganization(actor.organizationId);
  return client.$transaction(async (tx) => {
    // The warehouse is locked so it is not archived while it gets a terminal.
    const [locked] = await lockRows(tx, "facility", [facilityId]);
    const facility = locked
      ? await tx.facility.findFirst({
          where: { id: locked, archivedAt: null },
          select: { id: true, name: true },
        })
      : null;
    if (!facility || !inScope(await loadScope(tx, actor.userId), facility.id)) {
      return {
        ok: false as const,
        fieldErrors: { facilityId: "Elige uno de tus almacenes." },
      };
    }
    const sameName = await tx.sharedTerminal.findFirst({
      where: { removedAt: null, name },
      select: { id: true },
    });
    if (sameName) {
      return {
        ok: false as const,
        fieldErrors: { name: "Ya hay una terminal con ese nombre." },
      };
    }
    await tx.sharedTerminal.create({
      data: {
        id: terminalId,
        organizationId: actor.organizationId,
        facilityId: facility.id,
        name,
        createdByUserId: actor.userId,
      },
    });
    // Its first secret; it counts as presented once a request brings it.
    await tx.sharedTerminalSecret.create({
      data: {
        id: newId(),
        organizationId: actor.organizationId,
        terminalId,
        secretHash: hashTerminalSecret(secret),
        issuedAt: new Date(),
      },
    });
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: "terminal.registered",
      target: { type: "shared_terminal", id: terminalId },
      metadata: { name, facility: facility.name },
    });
    return {
      ok: true as const,
      terminalId,
      cookieValue: terminalCookieValue(terminalId, secret),
    };
  }, LOCKING_TRANSACTION);
}

async function viewsOf(
  actor: TerminalActor,
  where: { id?: string },
): Promise<TerminalView[]> {
  const client = forOrganization(actor.organizationId);
  const [rows, scope, device] = await Promise.all([
    client.sharedTerminal.findMany({
      where: { removedAt: null, ...where },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: TERMINALS_MAX,
      select: {
        id: true,
        name: true,
        facilityId: true,
        facility: { select: { name: true } },
        createdByUserId: true,
        createdAt: true,
        lastUsedAt: true,
      },
    }),
    loadScope(client, actor.userId),
    terminalOfDevice(),
  ]);
  const visible = rows.filter((row) => inScope(scope, row.facilityId));
  // Names of members only: the scoped client reads this company's people.
  const people = await client.membership.findMany({
    where: {
      userId: { in: [...new Set(visible.map((r) => r.createdByUserId))] },
    },
    select: { userId: true, user: { select: { name: true } } },
  });
  const names = new Map(people.map((p) => [p.userId, p.user.name]));
  return visible.map((row) => ({
    id: row.id,
    name: row.name,
    facilityId: row.facilityId,
    facilityName: row.facility.name,
    createdByName: names.get(row.createdByUserId)?.trim() || "Alguien",
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    thisDevice: device?.id === row.id,
  }));
}

/** Active terminals the person may see, by name. */
export async function listTerminals(
  actor: TerminalActor,
): Promise<TerminalView[]> {
  await assertAllowed(
    actor.organizationId,
    actor.userId,
    "platform.terminal.read",
  );
  return viewsOf(actor, {});
}

/** One active terminal, or null when it does not exist for this person. */
export async function getTerminal(
  actor: TerminalActor,
  terminalId: string,
): Promise<TerminalView | null> {
  await assertAllowed(
    actor.organizationId,
    actor.userId,
    "platform.terminal.read",
  );
  const [view] = await viewsOf(actor, { id: String(terminalId).slice(0, 36) });
  return view ?? null;
}

/**
 * Removes a terminal: its secret stops working and every session opened
 * on it is closed, in one transaction. The row stays (the audit trail and
 * security events name it).
 */
export async function removeTerminal(
  actor: TerminalActor,
  terminalId: string,
  reason?: string,
): Promise<RemoveTerminalResult> {
  await assertAllowed(
    actor.organizationId,
    actor.userId,
    "platform.terminal.manage",
  );
  const why = String(reason ?? "").trim();
  if (why.length > TERMINAL_REMOVE_REASON_MAX) {
    return {
      ok: false,
      error: `El motivo puede tener hasta ${TERMINAL_REMOVE_REASON_MAX} caracteres.`,
    };
  }
  const gone = "Esa terminal ya no está registrada.";
  const client = forOrganization(actor.organizationId);
  const removed = await client.$transaction(async (tx) => {
    const [locked] = await lockRows(tx, "sharedTerminal", [
      String(terminalId).slice(0, 36),
    ]);
    if (!locked) return null;
    const terminal = await tx.sharedTerminal.findFirst({
      where: { id: locked, removedAt: null },
      select: { id: true, name: true, facilityId: true },
    });
    if (
      !terminal ||
      !inScope(await loadScope(tx, actor.userId), terminal.facilityId)
    ) {
      return null;
    }
    await tx.sharedTerminal.update({
      where: { id: terminal.id },
      data: { removedAt: new Date(), removedByUserId: actor.userId },
    });
    return terminal;
  }, LOCKING_TRANSACTION);
  if (!removed) return { ok: false, error: gone };
  // Its sessions: rows of people (the scoped client refuses `session`),
  // found by the terminal, which is of this company. The secret no longer
  // matches any active terminal, so none could open meanwhile.
  const closed = await db.$transaction(async (tx) => {
    const { count } = await tx.session.deleteMany({
      where: { terminalId: removed.id },
    });
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: "terminal.removed",
      target: { type: "shared_terminal", id: removed.id },
      reason: why || undefined,
      metadata: { name: removed.name, sessionsClosed: count },
    });
    return count;
  });
  return { ok: true, closedSessions: closed };
}
