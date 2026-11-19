import "server-only";

import { isInternalHref, newId } from "@/lib";
import {
  buildScope,
  companyModules,
  hasTiedRole,
  inScope,
  activeRoles,
  permissionsOf,
  type CompanyModuleState,
  type Permission,
  type Place,
} from "@/platform/authorization";
import { readModuleStates, type ModuleReader } from "@/platform/entitlements";
import { enqueueJobs } from "@/platform/jobs";
import { placeOfLocation } from "@/platform/locations";
import { parseSettingValue } from "@/platform/settings";
import type { TenantDb } from "@/server";

import { isEmailOnly, noticeText, type NotificationType } from "./definitions";
import { NOTICE_EMAIL_CHANNEL } from "./settings";

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
 *
 * WMS-39B (ADR 0060): of the people notified, those who asked for that type
 * by mail (and whose company keeps the channel on) also get a row in
 * `notification_email` and a job of the worker, in this same transaction.
 * The mail goes out later; it never blocks or undoes the notice.
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
  /**
   * False: the titular passes `roles` only with one of them, like anybody
   * (the area of a process stage, WMS-74). By default the titular passes.
   */
  ownerByRole?: boolean;
  /** Only who reaches this warehouse (WMS-20)… */
  facilityId?: string | null;
  /** …or this location (and so its warehouse). */
  locationId?: string | null;
  /**
   * Every one of these locations (WMS-88, ADR 0084): a task exists for
   * who reaches its origin and its destination.
   */
  locationIds?: readonly (string | null | undefined)[];
  /**
   * Only who sees the whole company: the titular or someone without a
   * limit of warehouses or zones (WMS-88, ADR 0084).
   */
  wholeCompany?: boolean;
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
  type: Pick<NotificationType, "key" | "defaultEnabled" | "channels">,
  input: NotifyInput,
): Promise<NotifyResult> {
  if (!isInternalHref(input.href)) {
    throw new Error(`Notice ${type.key} must lead to a path of the app`);
  }
  const { to } = input;
  if (!to.userIds && (!to.permissions || to.permissions.length === 0)) {
    throw new Error(`Notice ${type.key} needs people or permissions`);
  }
  if (isEmailOnly(type)) {
    throw new Error(`Notice ${type.key} is only by mail: not a notice`);
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

  const place = await placesOf(tx, to);
  if (!place) return { sent: 0 };

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
    select: MEMBER_SELECT,
  });
  const modules = await modulesFor(tx, organizationId, members);
  const candidates = members
    .filter((member) => memberReaches(member, to, place, modules))
    .map((member) => member.userId);
  if (candidates.length === 0) return { sent: 0 };

  // Preferences: a row only where the person changed the default.
  const changed = await tx.notificationPreference.findMany({
    where: { organizationId, userId: { in: candidates }, typeKey: type.key },
    select: { userId: true, enabled: true, email: true },
  });
  const choice = new Map(changed.map((row) => [row.userId, row]));
  const listening = candidates.filter(
    (userId) => choice.get(userId)?.enabled ?? type.defaultEnabled,
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
  const rows = recipients.map((recipientUserId) => ({
    id: newId(),
    organizationId: input.organizationId,
    recipientUserId,
    typeKey: type.key,
    text,
    href: input.href,
    dedupeKey: key,
    actorUserId: input.actorUserId,
  }));
  const created = await tx.notification.createMany({
    data: rows,
    skipDuplicates: true,
  });

  const byMail = rows.filter(
    (row) => choice.get(row.recipientUserId)?.email === true,
  );
  if (byMail.length > 0) {
    await queueNoticeEmails(tx, input, type.key, to, byMail);
  }
  return { sent: created.count };
}

/** Members as `notify` reads them to decide who receives a notice. */
export const MEMBER_SELECT = {
  userId: true,
  roles: { select: { role: true } },
  scopes: { select: { facilityId: true, locationId: true } },
  organization: { select: { ownerUserId: true } },
} as const;

type MemberRow = {
  userId: string;
  roles: { role: string }[];
  scopes: { facilityId: string; locationId: string | null }[];
  organization: { ownerUserId: string | null };
};

/**
 * The company's modules, read with the caller's client (WMS-59, ADR 0062),
 * only when one of the members has a role tied to a module: the rest do
 * not depend on them, so no query is added for them.
 */
export async function modulesFor(
  client: ModuleReader,
  organizationId: string,
  members: readonly Pick<MemberRow, "roles">[],
): Promise<ReadonlyMap<string, CompanyModuleState> | undefined> {
  const tied = members.some((member) =>
    hasTiedRole(member.roles.map((each) => each.role)),
  );
  if (!tied) return undefined;
  return companyModules(await readModuleStates(client, organizationId));
}

/**
 * Whether a member may receive a notice with these requirements (roles,
 * permissions and place). The same rule decides when the notice is
 * created and again when its mail is sent (ADR 0060). A role tied to a
 * module counts only with `modules` (`modulesFor`); without them it gives
 * nothing (WMS-59).
 */
export function memberReaches(
  member: MemberRow,
  to: Pick<
    NotifyRecipients,
    "permissions" | "match" | "roles" | "ownerByRole" | "wholeCompany"
  >,
  place: Place | readonly Place[] | null,
  modules?: ReadonlyMap<string, CompanyModuleState>,
): boolean {
  const isOwner = member.organization.ownerUserId === member.userId;
  const roles = member.roles.map((each) => each.role);
  const subject = {
    isOwner,
    roles,
    scope: isOwner ? null : buildScope(member.scopes),
    ...(modules ? { modules } : {}),
  };
  // WMS-74: a role tied to a module counts only with its module active
  // (the rule of WMS-59), so the filter by roles reads the roles in force.
  if (
    to.roles &&
    (!isOwner || to.ownerByRole === false) &&
    !activeRoles(subject).some((role) => to.roles!.includes(role))
  ) {
    return false;
  }
  if (to.permissions && to.permissions.length > 0) {
    const granted = permissionsOf(subject);
    const holds =
      to.match === "any"
        ? to.permissions.some((permission) => granted.has(permission))
        : to.permissions.every((permission) => granted.has(permission));
    if (!holds) return false;
  }
  if (to.wholeCompany && subject.scope) return false;
  const places = place === null ? [] : Array.isArray(place) ? place : [place];
  return (places as readonly Place[]).every((each) => inScope(subject, each));
}

/**
 * Where a notice requires the person to reach (WMS-88): its location, its
 * locations (all of them) or its warehouse. An empty list = anywhere;
 * null = a location named no longer exists (nobody is notified).
 */
export async function placesOf(
  client: Parameters<typeof placeOfLocation>[0],
  to: Pick<NotifyRecipients, "facilityId" | "locationId" | "locationIds">,
): Promise<Place[] | null> {
  const ids = [
    ...new Set(
      [to.locationId, ...(to.locationIds ?? [])].filter(
        (id): id is string => typeof id === "string" && id !== "",
      ),
    ),
  ];
  const places: Place[] = [];
  for (const id of ids) {
    const place = await placeOfLocation(client, id);
    if (!place) return null;
    places.push(place);
  }
  if (places.length === 0 && to.facilityId) {
    places.push({ facilityId: to.facilityId });
  }
  return places;
}

// ---------------------------------------------------------------------------
// By mail (WMS-39B, ADR 0060)

export const NOTICE_EMAIL_JOB_TYPE = "notifications.send_email";
/** A mail waits this long to gather what arrives right after. */
export const NOTICE_EMAIL_GROUP_MS = 2 * 60 * 1000;
/** At least this long between two mails to the same person. */
export const NOTICE_EMAIL_GAP_MS = 15 * 60 * 1000;
export const NOTICE_EMAIL_MAX_ATTEMPTS = 4;

/** What receiving the notice required, kept to check it again. */
export type NoticeRequirement = Pick<
  NotifyRecipients,
  | "permissions"
  | "match"
  | "roles"
  | "ownerByRole"
  | "facilityId"
  | "locationId"
  | "wholeCompany"
> & { locationIds?: string[] };

/** When the next mail to a person may leave, from its last one. */
export function nextMailAt(now: Date, lastSentAt: Date | null): Date {
  const grouped = now.getTime() + NOTICE_EMAIL_GROUP_MS;
  const spaced = lastSentAt ? lastSentAt.getTime() + NOTICE_EMAIL_GAP_MS : 0;
  return new Date(Math.max(grouped, spaced));
}

async function queueNoticeEmails(
  tx: NotifyTx,
  input: NotifyInput,
  typeKey: string,
  to: NotifyRecipients,
  rows: readonly { id: string; recipientUserId: string }[],
): Promise<void> {
  // `tx` may be a transaction without the company filter (a change of the
  // team, WMS-40): every query here names the company itself.
  const { organizationId } = input;
  const setting = await tx.organizationSetting.findFirst({
    where: { organizationId, key: NOTICE_EMAIL_CHANNEL.key },
    select: { value: true },
  });
  const channel = parseSettingValue(NOTICE_EMAIL_CHANNEL, setting?.value);
  const on = channel.ok
    ? channel.value === "on"
    : NOTICE_EMAIL_CHANNEL.defaultValue === "on";
  if (!on) return;
  // Only the notices this transaction wrote (a duplicate written at the
  // same time by another one was skipped and has its own mail, if any).
  const written = new Set(
    (
      await tx.notification.findMany({
        where: { organizationId, id: { in: rows.map((row) => row.id) } },
        select: { id: true },
      })
    ).map((row) => row.id),
  );
  const mine = rows.filter((row) => written.has(row.id));
  if (mine.length === 0) return;
  // Only a sent mail has `sentAt`: no state filter, so the index
  // (company, recipient, sentAt) answers it.
  const last = await tx.notificationEmail.groupBy({
    by: ["recipientUserId"],
    where: {
      organizationId,
      recipientUserId: { in: mine.map((row) => row.recipientUserId) },
    },
    _max: { sentAt: true },
  });
  const lastSent = new Map(
    last.map((row) => [row.recipientUserId, row._max.sentAt]),
  );
  const requirement: NoticeRequirement = {
    ...(to.permissions ? { permissions: [...to.permissions] } : {}),
    ...(to.match ? { match: to.match } : {}),
    ...(to.roles ? { roles: [...to.roles] } : {}),
    ...(to.ownerByRole === false ? { ownerByRole: false } : {}),
    ...(to.facilityId ? { facilityId: to.facilityId } : {}),
    ...(to.locationId ? { locationId: to.locationId } : {}),
    ...(to.locationIds && to.locationIds.some(Boolean)
      ? {
          locationIds: to.locationIds.filter(
            (id): id is string => typeof id === "string" && id !== "",
          ),
        }
      : {}),
    ...(to.wholeCompany ? { wholeCompany: true } : {}),
  };
  const now = new Date();
  const text = noticeText(input.text);
  const mails = mine.map((row) => ({
    id: newId(),
    organizationId,
    notificationId: row.id,
    recipientUserId: row.recipientUserId,
    typeKey,
    text,
    href: input.href,
    requirement,
  }));
  await tx.notificationEmail.createMany({ data: mails });
  await enqueueJobs(
    tx,
    organizationId,
    mails.map((mail) => ({
      type: NOTICE_EMAIL_JOB_TYPE,
      payload: { emailId: mail.id },
      runAt: nextMailAt(now, lastSent.get(mail.recipientUserId) ?? null),
      maxAttempts: NOTICE_EMAIL_MAX_ATTEMPTS,
    })),
  );
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
