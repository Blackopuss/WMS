import "server-only";

import { isInternalHref, newId } from "@/lib";
import {
  buildScope,
  inScope,
  knownRoles,
  permissionsOf,
  type Permission,
  type Place,
} from "@/platform/authorization";
import { placeOfLocation } from "@/platform/locations";
import type { TenantDb } from "@/server";

import { noticeText, type NotificationType } from "./definitions";

/**
 * Sending notices (WMS-39, ADR 0057). `notify` runs inside the transaction
 * of the fact that causes it, with its client: if the operation rolls
 * back, nobody is notified. It decides who receives it from the database
 * as it is now (active members, their roles, their scope and their
 * preferences), never the person who caused it, at most
 * NOTIFY_MAX_RECIPIENTS people, and once per person and fact (`key`).
 *
 * Nothing here may make the operation fail for a detail: no recipients is
 * not an error and a long text is cut. A destination outside the app is a
 * programming error and throws.
 */

export type NotifyTx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];

/** At most this many people get one notice. */
export const NOTIFY_MAX_RECIPIENTS = 50;
/** Members read to decide (a company has far fewer seats). */
const MEMBERS_READ = 2000;

export type NotifyRecipients = {
  /** Only these people (still subject to the rest). */
  userIds?: readonly (string | null | undefined)[];
  /**
   * What they must hold. Required when `userIds` is not given: a notice
   * never goes to «everybody».
   */
  permissions?: readonly Permission[];
  /** `any`: one of the permissions is enough; by default, all of them. */
  match?: "all" | "any";
  /** Only these roles (or the titular): the roles of an approval rule. */
  roles?: readonly string[];
  /** Only who reaches this warehouse (WMS-20)… */
  facilityId?: string | null;
  /** …or this location (and so its warehouse). */
  locationId?: string | null;
};

export type NotifyInput = {
  organizationId: string;
  /** Who caused it: never notified about it. Null = the system. */
  actorUserId: string | null;
  to: NotifyRecipients;
  /** What happened, in one line; never costs or what they may not see. */
  text: string;
  /** Path of the app it leads to. */
  href: string;
  /** The fact: a person gets one notice per key («task:<id>:assigned»). */
  key: string;
};

export type NotifyResult = { sent: number };

/**
 * Notifies who should hear about a fact. Call it with the client of the
 * transaction that writes the fact, after its locks and writes.
 */
export async function notify(
  tx: NotifyTx,
  type: Pick<NotificationType, "key" | "defaultEnabled">,
  input: NotifyInput,
): Promise<NotifyResult> {
  if (!isInternalHref(input.href)) {
    throw new Error(`Notice ${type.key} must lead to a path of the app`);
  }
  const { to } = input;
  if (!to.userIds && (!to.permissions || to.permissions.length === 0)) {
    throw new Error(`Notice ${type.key} needs people or permissions`);
  }
  const text = noticeText(input.text);
  const key = String(input.key).slice(0, 160);
  if (!text || !key.trim()) return { sent: 0 };

  const wanted = to.userIds
    ? [
        ...new Set(
          to.userIds.filter(
            (id): id is string => typeof id === "string" && id !== "",
          ),
        ),
      ]
    : null;
  if (wanted && wanted.length === 0) return { sent: 0 };

  let place: Place | null = null;
  if (to.locationId) {
    place = await placeOfLocation(tx, to.locationId);
    if (!place) return { sent: 0 };
  } else if (to.facilityId) {
    place = { facilityId: to.facilityId };
  }

  // The company is also named in each filter (the scoped client adds the
  // same): a platform fact written with the plain client of its own
  // transaction (team sessions, WMS-40) reads only this company too.
  const organizationId = input.organizationId;
  const members = await tx.membership.findMany({
    where: {
      organizationId,
      status: "ACTIVE",
      ...(wanted ? { userId: { in: wanted } } : {}),
      ...(input.actorUserId ? { NOT: { userId: input.actorUserId } } : {}),
    },
    orderBy: { userId: "asc" },
    take: MEMBERS_READ,
    select: {
      userId: true,
      roles: { select: { role: true } },
      scopes: { select: { facilityId: true, locationId: true } },
      organization: { select: { ownerUserId: true } },
    },
  });
  const allowedRoles = to.roles ? new Set(to.roles) : null;
  const candidates: string[] = [];
  for (const member of members) {
    const isOwner = member.organization.ownerUserId === member.userId;
    const roles = member.roles.map((each) => each.role);
    const subject = {
      isOwner,
      roles,
      scope: isOwner ? null : buildScope(member.scopes),
    };
    if (
      allowedRoles &&
      !isOwner &&
      !knownRoles(roles).some((role) => allowedRoles.has(role))
    ) {
      continue;
    }
    if (to.permissions && to.permissions.length > 0) {
      const granted = permissionsOf(subject);
      const holds =
        to.match === "any"
          ? to.permissions.some((permission) => granted.has(permission))
          : to.permissions.every((permission) => granted.has(permission));
      if (!holds) continue;
    }
    if (place && !inScope(subject, place)) continue;
    candidates.push(member.userId);
  }
  if (candidates.length === 0) return { sent: 0 };

  // Preferences: a row only where the person changed the default.
  const changed = await tx.notificationPreference.findMany({
    where: { organizationId, userId: { in: candidates }, typeKey: type.key },
    select: { userId: true, enabled: true },
  });
  const choice = new Map(changed.map((row) => [row.userId, row.enabled]));
  const listening = candidates.filter(
    (userId) => choice.get(userId) ?? type.defaultEnabled,
  );
  if (listening.length === 0) return { sent: 0 };
  const capped = listening.slice(0, NOTIFY_MAX_RECIPIENTS);

  const already = await tx.notification.findMany({
    where: { organizationId, recipientUserId: { in: capped }, dedupeKey: key },
    select: { recipientUserId: true },
  });
  const done = new Set(already.map((row) => row.recipientUserId));
  const recipients = capped.filter((userId) => !done.has(userId));
  if (recipients.length === 0) return { sent: 0 };

  // Nothing updates these rows in this transaction: ignoring a duplicate
  // written at the same time by another one is safe (ADR 0057).
  const created = await tx.notification.createMany({
    data: recipients.map((recipientUserId) => ({
      id: newId(),
      organizationId: input.organizationId,
      recipientUserId,
      typeKey: type.key,
      text,
      href: input.href,
      dedupeKey: key,
      actorUserId: input.actorUserId,
    })),
    skipDuplicates: true,
  });
  return { sent: created.count };
}

/**
 * The name of a member to write in a notice («Olivia reportó…»), read with
 * the client of the transaction; «Alguien» when it is not known.
 */
export async function memberName(
  tx: Pick<NotifyTx, "membership">,
  userId: string | null,
): Promise<string> {
  if (!userId) return "Alguien";
  const member = await tx.membership.findFirst({
    where: { userId },
    select: { user: { select: { name: true } } },
  });
  return member?.user.name.trim() || "Alguien";
}
