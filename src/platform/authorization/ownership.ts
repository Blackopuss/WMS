import "server-only";

import { log, newId } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import {
  assertNotTerminalSession,
  confirmIdentity,
  type StepUpField,
} from "@/platform/auth";
import { ownershipEmail, sendEmail } from "@/platform/email";
import { readModuleStates } from "@/platform/entitlements";
import { notify, type NotifyTx } from "@/platform/notifications";
import { LOCKING_TRANSACTION, db, forOrganization } from "@/server";

import { assertOwnerAction } from "./access";
import { companyModules, type CompanyModuleState } from "./policy";
import { ROLE_MODULE, isRole, type Role } from "./catalog";
import { OWNERSHIP_NOTICE } from "./notices";
import { TEAM_RULE_MESSAGES } from "./team-rules";

/**
 * Ownership transfer (USR-03B, founder's answer 8). Two steps:
 *
 * 1. the titular offers the company to an active member and chooses the
 *    roles they will keep afterwards (Consulta by default, never
 *    Administrador unless chosen);
 * 2. the recipient accepts, with MFA already active.
 *
 * Accepting changes Organization.ownerUserId, the previous titular's roles
 * and the offer in one transaction under a lock on the organization row:
 * there is always exactly one titular, and of two concurrent acceptances
 * only one wins.
 *
 * WMS-90 (ADR 0090): the screen calls only the «WithConfirmation» variants,
 * which ask the password and a current two-step code again (never from a
 * PIN session), and the recipient may also decline. Accepting closes an
 * open support access and refuses a kept role whose module is gone.
 */

export const OWNERSHIP_OFFER_DAYS = 7;
const DEFAULT_PREVIOUS_OWNER_ROLES: Role[] = ["viewer"];

export type OwnershipReason =
  | "not_owner"
  | "invalid_recipient"
  | "invalid_roles"
  | "module_missing"
  | "not_found"
  | "expired"
  | "mfa_required"
  | "demo_company";

export const OWNERSHIP_MESSAGES: Record<OwnershipReason, string> = {
  not_owner: "Solo el titular de la empresa puede hacer esto.",
  invalid_recipient:
    "Elige a una persona activa de tu equipo distinta de ti para recibir la empresa.",
  invalid_roles: "Elige roles válidos para conservar después de transferir.",
  module_missing: TEAM_RULE_MESSAGES.module_missing,
  not_found: "Esta transferencia ya no está disponible.",
  expired: "Esta transferencia venció. Pide al titular que la envíe de nuevo.",
  mfa_required:
    "Activa la verificación en dos pasos antes de aceptar la empresa.",
  demo_company:
    "Una empresa de demostración no se transfiere: la empresa real se crea con otra cuenta.",
};

export type OfferOwnershipResult =
  | { ok: true; transferId: string; expiresAt: Date }
  | { ok: false; reason: OwnershipReason; error: string };

export type OwnershipActionResult =
  { ok: true } | { ok: false; reason: OwnershipReason; error: string };

const fail = <R extends OwnershipReason>(reason: R) =>
  ({ ok: false, reason, error: OWNERSHIP_MESSAGES[reason] }) as const;

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

const OWNERSHIP_HREF = "/configuracion/titularidad";

/** The company's modules, read with the transaction (MOD-08). */
async function modulesUnderLock(tx: Tx, organizationId: string) {
  return companyModules(await readModuleStates(tx, organizationId));
}

/**
 * Name of people, to word notices, and their mail only when the account
 * confirmed it (security mail never goes to an unconfirmed address).
 */
async function peopleOf(tx: Tx, ids: string[]) {
  const rows = await tx.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, email: true, emailVerified: true },
  });
  return new Map(
    rows.map((row) => [
      row.id,
      { name: row.name, email: row.emailVerified ? row.email : null },
    ]),
  );
}

const nameOf = (person: { name: string } | undefined) =>
  person?.name.trim() || "Alguien";

async function tell(
  tx: Tx,
  input: {
    organizationId: string;
    actorUserId: string;
    toUserId: string;
    text: string;
    href: string;
    key: string;
  },
) {
  await notify(tx as unknown as NotifyTx, OWNERSHIP_NOTICE, {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    to: { userIds: [input.toUserId] },
    text: input.text,
    href: input.href,
    key: input.key,
  });
}

type Mail = Parameters<typeof ownershipEmail>[0];

/**
 * Security mail goes out after the transaction commits. A failure is logged:
 * what was done stays done and the notice in the app already says it.
 */
async function sendAfter(mails: Mail[]) {
  for (const mail of mails) {
    try {
      await sendEmail(ownershipEmail(mail));
    } catch (error) {
      log.error("ownership_mail_failed", error);
    }
  }
}

/** Locks the company row and returns its titular; null if it does not exist. */
async function lockOwner(tx: Tx, organizationId: string) {
  const rows = await tx.$queryRaw<
    { ownerUserId: string }[]
  >`SELECT ownerUserId FROM organization WHERE id = ${organizationId} FOR UPDATE`;
  return rows[0]?.ownerUserId ?? null;
}

/** Whether the company is a demonstration (the mark never changes). */
async function isDemoUnderLock(tx: Tx, organizationId: string) {
  const company = await tx.organization.findUnique({
    where: { id: organizationId },
    select: { isDemo: true },
  });
  return company?.isDemo === true;
}

function parseRoles(input: readonly string[] | undefined): Role[] | null {
  if (input === undefined) return DEFAULT_PREVIOUS_OWNER_ROLES;
  if (input.length === 0 || !input.every(isRole)) return null;
  return [...new Set(input)];
}

/** The titular offers the company to an active member. Replaces a pending offer. */
export async function offerOwnershipTransfer(
  organizationId: string,
  actorUserId: string,
  input: { toUserId: string; previousOwnerRoles?: readonly string[] },
): Promise<OfferOwnershipResult> {
  const roles = parseRoles(input.previousOwnerRoles);
  if (!roles) return fail("invalid_roles");
  const toUserId = String(input.toUserId);
  const done = await db.$transaction(async (tx) => {
    const owner = await lockOwner(tx, organizationId);
    if (owner === null || owner !== actorUserId) return fail("not_owner");
    // WMS-44 (ADR 0089): a demonstration is not handed to someone else.
    if (await isDemoUnderLock(tx, organizationId)) return fail("demo_company");
    // WMS-59: a role tied to a module is kept only with that module in full
    // use, unless the titular already has it (same rule as the team). Read
    // under the company lock, which removing a module also takes (WMS-90).
    const modules = await modulesUnderLock(tx, organizationId);
    const ownMembership = await tx.membership.findFirst({
      where: { organizationId, userId: actorUserId, status: "ACTIVE" },
      select: { id: true, roles: { select: { role: true } } },
    });
    if (!ownMembership) return fail("not_owner");
    const held = new Set(ownMembership.roles.map((each) => each.role));
    if (missesModule(roles, held, modules)) return fail("module_missing");

    const recipient =
      toUserId === actorUserId
        ? null
        : await tx.membership.findFirst({
            where: { organizationId, userId: toUserId, status: "ACTIVE" },
            select: { id: true },
          });
    if (!recipient) return fail("invalid_recipient");

    const now = new Date();
    // A new offer replaces the pending one; its recipient is told (WMS-90).
    const replaced = await tx.ownershipTransfer.findMany({
      where: { organizationId, status: "PENDING" },
      select: { id: true, toMembership: { select: { userId: true } } },
    });
    await tx.ownershipTransfer.updateMany({
      where: { organizationId, status: "PENDING" },
      data: { status: "CANCELLED", resolvedAt: now },
    });
    const transferId = newId();
    const expiresAt = new Date(
      now.getTime() + OWNERSHIP_OFFER_DAYS * 24 * 60 * 60 * 1000,
    );
    await tx.ownershipTransfer.create({
      data: {
        id: transferId,
        organizationId,
        fromUserId: actorUserId,
        toMembershipId: recipient.id,
        previousOwnerRoles: roles,
        expiresAt,
      },
    });
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId,
      action: "ownership.transfer_offered",
      target: { type: "user", id: toUserId },
      metadata: { transferId, previousOwnerRoles: roles },
    });
    const [people, company] = await Promise.all([
      peopleOf(tx, [actorUserId, toUserId]),
      companyName(tx, organizationId),
    ]);
    const from = people.get(actorUserId);
    const to = people.get(toUserId);
    for (const old of replaced) {
      await tell(tx, {
        organizationId,
        actorUserId,
        toUserId: old.toMembership.userId,
        text: `${nameOf(from)} canceló la oferta de la titularidad de ${company}.`,
        href: "/configuracion",
        key: `ownership:${old.id}:cancelled`,
      });
    }
    await tell(tx, {
      organizationId,
      actorUserId,
      toUserId,
      text: `${nameOf(from)} te ofrece la titularidad de ${company}.`,
      href: OWNERSHIP_HREF,
      key: `ownership:${transferId}:offered`,
    });
    const mails: Mail[] = [];
    if (from?.email) {
      mails.push({
        to: from.email,
        name: from.name,
        kind: "offered_by_you",
        otherName: nameOf(to),
        organizationName: company,
      });
    }
    if (to?.email) {
      mails.push({
        to: to.email,
        name: to.name,
        kind: "offered_to_you",
        otherName: nameOf(from),
        organizationName: company,
      });
    }
    return { ok: true, transferId, expiresAt, mails } as const;
  }, LOCKING_TRANSACTION);
  if (!done.ok) return done;
  await sendAfter(done.mails);
  return { ok: true, transferId: done.transferId, expiresAt: done.expiresAt };
}

/** True when a role to keep needs a module the company lacks and is not held. */
function missesModule(
  roles: readonly Role[],
  held: ReadonlySet<string>,
  modules: ReadonlyMap<string, CompanyModuleState>,
): boolean {
  return roles.some((role) => {
    const needs = ROLE_MODULE[role];
    return (
      needs !== undefined && !held.has(role) && modules.get(needs) !== "active"
    );
  });
}

async function companyName(tx: Tx, organizationId: string) {
  const row = await tx.organization.findUnique({
    where: { id: organizationId },
    select: { name: true },
  });
  return row?.name.trim() || "la empresa";
}

/** The titular withdraws the pending offer. */
export async function cancelOwnershipTransfer(
  organizationId: string,
  actorUserId: string,
): Promise<OwnershipActionResult> {
  return db.$transaction(async (tx) => {
    const owner = await lockOwner(tx, organizationId);
    if (owner === null || owner !== actorUserId) return fail("not_owner");
    // WMS-44 (ADR 0089): a demonstration is not handed to someone else.
    if (await isDemoUnderLock(tx, organizationId)) return fail("demo_company");
    const pending = await tx.ownershipTransfer.findMany({
      where: { organizationId, status: "PENDING" },
      select: { id: true, toMembership: { select: { userId: true } } },
    });
    const cancelled = await tx.ownershipTransfer.updateMany({
      where: { organizationId, status: "PENDING" },
      data: { status: "CANCELLED", resolvedAt: new Date() },
    });
    if (cancelled.count === 0) return fail("not_found");
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId,
      action: "ownership.transfer_cancelled",
      target: { type: "organization", id: organizationId },
    });
    const [people, company] = await Promise.all([
      peopleOf(tx, [actorUserId]),
      companyName(tx, organizationId),
    ]);
    for (const offer of pending) {
      await tell(tx, {
        organizationId,
        actorUserId,
        toUserId: offer.toMembership.userId,
        text: `${nameOf(people.get(actorUserId))} canceló la oferta de la titularidad de ${company}.`,
        href: "/configuracion",
        key: `ownership:${offer.id}:cancelled`,
      });
    }
    return { ok: true } as const;
  }, LOCKING_TRANSACTION);
}

/** The pending offer for this person, read under the company lock. */
async function offerFor(
  tx: Tx,
  organizationId: string,
  owner: string,
  userId: string,
  transferId: string,
) {
  const transfer = await tx.ownershipTransfer.findFirst({
    where: { id: String(transferId), organizationId, status: "PENDING" },
    select: {
      id: true,
      fromUserId: true,
      previousOwnerRoles: true,
      expiresAt: true,
      toMembership: {
        select: {
          id: true,
          userId: true,
          status: true,
          user: { select: { twoFactorEnabled: true } },
        },
      },
    },
  });
  if (
    !transfer ||
    transfer.toMembership.userId !== userId ||
    transfer.toMembership.status !== "ACTIVE" ||
    // The person who offered is no longer the titular.
    transfer.fromUserId !== owner
  ) {
    return null;
  }
  return transfer;
}

/**
 * The recipient accepts: they become the titular, the previous one keeps
 * only the chosen roles. Same answer for an offer that does not exist, was
 * cancelled, was already used or belongs to someone else.
 */
export async function acceptOwnershipTransfer(
  organizationId: string,
  userId: string,
  transferId: string,
): Promise<OwnershipActionResult> {
  const done = await db.$transaction(async (tx) => {
    const owner = await lockOwner(tx, organizationId);
    if (owner === null) return fail("not_found");
    // WMS-44 (ADR 0089): nor accepted (an offer made before cannot exist,
    // but the rule is checked where it decides).
    if (await isDemoUnderLock(tx, organizationId)) return fail("demo_company");
    // WMS-59 again at the end, under the company lock that removing a
    // module also takes: a module removed since the offer does not hand out
    // a role the previous titular did not have (WMS-90).
    const modules = await modulesUnderLock(tx, organizationId);

    const transfer = await offerFor(
      tx,
      organizationId,
      owner,
      userId,
      transferId,
    );
    if (!transfer) return fail("not_found");
    if (transfer.expiresAt.getTime() <= Date.now()) return fail("expired");
    if (!transfer.toMembership.user.twoFactorEnabled) {
      return fail("mfa_required");
    }

    const stored = transfer.previousOwnerRoles;
    const roles = Array.isArray(stored) ? stored.filter(isRole) : [];
    const previous = await tx.membership.findFirst({
      where: { organizationId, userId: owner },
      select: { id: true, roles: { select: { role: true } } },
    });
    const held = new Set(previous?.roles.map((each) => each.role) ?? []);
    if (missesModule(roles, held, modules)) return fail("module_missing");

    await tx.organization.update({
      where: { id: organizationId },
      data: { ownerUserId: userId },
    });
    // The titular is never limited to warehouses or zones (WMS-20).
    await tx.membershipScope.deleteMany({
      where: { organizationId, membershipId: transfer.toMembership.id },
    });
    // The titular needs no roles; the previous one keeps only the chosen ones.
    await tx.membershipRole.deleteMany({
      where: {
        organizationId,
        membershipId: {
          in: [transfer.toMembership.id, ...(previous ? [previous.id] : [])],
        },
      },
    });
    if (previous && roles.length > 0) {
      await tx.membershipRole.createMany({
        data: roles.map((role) => ({
          id: newId(),
          organizationId,
          membershipId: previous.id,
          role,
        })),
      });
    }
    const now = new Date();
    await tx.ownershipTransfer.update({
      where: { id: transfer.id },
      data: { status: "ACCEPTED", resolvedAt: now },
    });
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "ownership.transferred",
      target: { type: "user", id: userId },
      metadata: {
        transferId: transfer.id,
        previousOwnerUserId: owner,
        previousOwnerRoles: roles,
      },
    });
    // Support access was opened by the previous titular (PIL-12): the new
    // one decides whether to open it again (ADR 0090).
    const support = await tx.supportAccess.findMany({
      where: { organizationId, revokedAt: null, expiresAt: { gt: now } },
      select: { id: true },
    });
    for (const row of support) {
      await tx.supportAccess.update({
        where: { id: row.id },
        data: { revokedAt: now, revokedByUserId: userId },
      });
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId: userId,
        action: "support.revoked",
        target: { type: "support_access", id: row.id },
        reason: "Transferencia de titularidad",
      });
    }

    const [people, company] = await Promise.all([
      peopleOf(tx, [owner, userId]),
      companyName(tx, organizationId),
    ]);
    const before = people.get(owner);
    const after = people.get(userId);
    await tell(tx, {
      organizationId,
      actorUserId: userId,
      toUserId: owner,
      text: `${nameOf(after)} aceptó la titularidad de ${company}.`,
      href: "/configuracion",
      key: `ownership:${transfer.id}:accepted`,
    });
    const mails: Mail[] = [];
    if (before?.email) {
      mails.push({
        to: before.email,
        name: before.name,
        kind: "you_gave",
        otherName: nameOf(after),
        organizationName: company,
      });
    }
    if (after?.email) {
      mails.push({
        to: after.email,
        name: after.name,
        kind: "you_took",
        otherName: nameOf(before),
        organizationName: company,
      });
    }
    return { ok: true, mails } as const;
  }, LOCKING_TRANSACTION);
  if (!done.ok) return done;
  await sendAfter(done.mails);
  return { ok: true };
}

/**
 * The recipient declines (WMS-90). Declining gives power to nobody, so it
 * asks for nothing more; the offer is closed as CANCELLED and the audit
 * trail says who closed it.
 */
export async function declineOwnershipTransfer(
  organizationId: string,
  userId: string,
  transferId: string,
): Promise<OwnershipActionResult> {
  return db.$transaction(async (tx) => {
    const owner = await lockOwner(tx, organizationId);
    if (owner === null) return fail("not_found");
    const transfer = await offerFor(
      tx,
      organizationId,
      owner,
      userId,
      transferId,
    );
    if (!transfer) return fail("not_found");
    await tx.ownershipTransfer.update({
      where: { id: transfer.id },
      data: { status: "CANCELLED", resolvedAt: new Date() },
    });
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "ownership.transfer_declined",
      target: { type: "user", id: owner },
      metadata: { transferId: transfer.id },
    });
    const [people, company] = await Promise.all([
      peopleOf(tx, [userId]),
      companyName(tx, organizationId),
    ]);
    await tell(tx, {
      organizationId,
      actorUserId: userId,
      toUserId: owner,
      text: `${nameOf(people.get(userId))} rechazó la titularidad de ${company}.`,
      href: OWNERSHIP_HREF,
      key: `ownership:${transfer.id}:declined`,
    });
    return { ok: true } as const;
  }, LOCKING_TRANSACTION);
}

export type OwnershipScreenField = StepUpField | "toUserId" | "roles";

export type OwnershipScreenResult =
  { ok: true } | { ok: false; error: string; field?: OwnershipScreenField };

const FIELD_OF: Partial<Record<OwnershipReason, OwnershipScreenField>> = {
  invalid_recipient: "toUserId",
  invalid_roles: "roles",
  module_missing: "roles",
};

const screenFail = (reason: OwnershipReason): OwnershipScreenResult => ({
  ok: false,
  error: OWNERSHIP_MESSAGES[reason],
  ...(FIELD_OF[reason] ? { field: FIELD_OF[reason] } : {}),
});

/**
 * What the screen calls to offer (ADR 0090): titular with an active
 * membership (not a PIN session, not support), then password and code
 * again, then the service, which decides everything again under the lock.
 */
export async function offerOwnershipWithConfirmation(
  organizationId: string,
  actorUserId: string,
  input: {
    toUserId: string;
    previousOwnerRoles: readonly string[];
    password: string;
    code: string;
  },
  headers: Headers,
): Promise<OwnershipScreenResult> {
  await assertNotTerminalSession(actorUserId);
  await assertOwnerAction(
    organizationId,
    actorUserId,
    "platform.ownership.transfer",
  );
  const roles = parseRoles(input.previousOwnerRoles);
  if (!roles) return screenFail("invalid_roles");
  if (!String(input.toUserId ?? "").trim()) {
    return screenFail("invalid_recipient");
  }
  const confirmed = await confirmIdentity(
    actorUserId,
    { password: input.password, code: input.code },
    headers,
  );
  if (!confirmed.ok) return confirmed;
  const result = await offerOwnershipTransfer(organizationId, actorUserId, {
    toUserId: input.toUserId,
    previousOwnerRoles: roles,
  });
  return result.ok ? { ok: true } : screenFail(result.reason);
}

/**
 * What the screen calls to accept (ADR 0090): an offer for this person that
 * is still valid, then password and code again, then the service.
 */
export async function acceptOwnershipWithConfirmation(
  organizationId: string,
  userId: string,
  input: { transferId: string; password: string; code: string },
  headers: Headers,
): Promise<OwnershipScreenResult> {
  await assertNotTerminalSession(userId);
  const offer = await getOwnershipOfferFor(organizationId, userId);
  if (!offer || offer.id !== String(input.transferId)) {
    return screenFail("not_found");
  }
  if (!offer.recipientHasMfa) return screenFail("mfa_required");
  const confirmed = await confirmIdentity(
    userId,
    { password: input.password, code: input.code },
    headers,
  );
  if (!confirmed.ok) return confirmed;
  const result = await acceptOwnershipTransfer(
    organizationId,
    userId,
    offer.id,
  );
  return result.ok ? { ok: true } : screenFail(result.reason);
}

/** Same guards as accepting, for declining from the screen. */
export async function declineOwnershipFromScreen(
  organizationId: string,
  userId: string,
  transferId: string,
): Promise<OwnershipScreenResult> {
  await assertNotTerminalSession(userId);
  const result = await declineOwnershipTransfer(
    organizationId,
    userId,
    transferId,
  );
  return result.ok ? { ok: true } : screenFail(result.reason);
}

/** Same guards as offering, for cancelling from the screen. */
export async function cancelOwnershipFromScreen(
  organizationId: string,
  actorUserId: string,
): Promise<OwnershipScreenResult> {
  await assertNotTerminalSession(actorUserId);
  await assertOwnerAction(
    organizationId,
    actorUserId,
    "platform.ownership.transfer",
  );
  const result = await cancelOwnershipTransfer(organizationId, actorUserId);
  return result.ok ? { ok: true } : screenFail(result.reason);
}

export type OwnershipOfferForMe = {
  id: string;
  fromUserId: string;
  fromName: string;
  previousOwnerRoles: Role[];
  expiresAt: Date;
  recipientHasMfa: boolean;
};

/**
 * The valid offer made to this person in this company, or null: offered by
 * the current titular, to their active membership, not expired.
 */
export async function getOwnershipOfferFor(
  organizationId: string,
  userId: string,
): Promise<OwnershipOfferForMe | null> {
  const client = forOrganization(organizationId);
  const [organization, transfer] = await Promise.all([
    db.organization.findUnique({
      where: { id: organizationId },
      select: { ownerUserId: true },
    }),
    client.ownershipTransfer.findFirst({
      where: {
        status: "PENDING",
        expiresAt: { gt: new Date() },
        toMembership: { userId, status: "ACTIVE" },
      },
      orderBy: { id: "desc" },
      select: {
        id: true,
        fromUserId: true,
        previousOwnerRoles: true,
        expiresAt: true,
        toMembership: {
          select: { user: { select: { twoFactorEnabled: true } } },
        },
      },
    }),
  ]);
  if (!transfer || organization?.ownerUserId !== transfer.fromUserId) {
    return null;
  }
  const from = await db.user.findUnique({
    where: { id: transfer.fromUserId },
    select: { name: true },
  });
  const stored = transfer.previousOwnerRoles;
  return {
    id: transfer.id,
    fromUserId: transfer.fromUserId,
    fromName: nameOf(from ?? undefined),
    previousOwnerRoles: Array.isArray(stored) ? stored.filter(isRole) : [],
    expiresAt: transfer.expiresAt,
    recipientHasMfa: transfer.toMembership.user.twoFactorEnabled === true,
  };
}

export type PendingOwnershipTransfer = {
  id: string;
  fromUserId: string;
  toUserId: string;
  previousOwnerRoles: Role[];
  expiresAt: Date;
};

/** The company's pending offer, if it has not expired. */
export async function getPendingOwnershipTransfer(
  organizationId: string,
): Promise<PendingOwnershipTransfer | null> {
  const transfer = await forOrganization(
    organizationId,
  ).ownershipTransfer.findFirst({
    where: {
      status: "PENDING",
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      fromUserId: true,
      previousOwnerRoles: true,
      expiresAt: true,
      toMembership: { select: { userId: true } },
    },
  });
  if (!transfer) return null;
  const stored = transfer.previousOwnerRoles;
  return {
    id: transfer.id,
    fromUserId: transfer.fromUserId,
    toUserId: transfer.toMembership.userId,
    previousOwnerRoles: Array.isArray(stored) ? stored.filter(isRole) : [],
    expiresAt: transfer.expiresAt,
  };
}

export type OwnershipCandidate = {
  userId: string;
  name: string;
  email: string;
  hasMfa: boolean;
};

/**
 * Whom the titular may offer the company to: active members other than the
 * titular, by name. Empty for anybody who is not the titular.
 */
export async function listOwnershipCandidates(
  organizationId: string,
  actorUserId: string,
): Promise<OwnershipCandidate[]> {
  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: { ownerUserId: true },
  });
  if (organization?.ownerUserId !== actorUserId) return [];
  const rows = await forOrganization(organizationId).membership.findMany({
    where: { status: "ACTIVE", userId: { not: actorUserId } },
    select: {
      userId: true,
      user: { select: { name: true, email: true, twoFactorEnabled: true } },
    },
    take: 2000,
  });
  return rows
    .map((row) => ({
      userId: row.userId,
      name: row.user.name.trim() || row.user.email,
      email: row.user.email,
      hasMfa: row.user.twoFactorEnabled === true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
}
