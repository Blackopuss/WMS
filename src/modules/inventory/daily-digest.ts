import "server-only";

import { DEFAULT_TIME_ZONE, formatDate, log, newId } from "@/lib";
import { isAllowed, seesWholeCompany } from "@/platform/authorization";
import {
  InvalidEmailError,
  dailyDigestEmail,
  sendEmail,
} from "@/platform/email";
import { getFreshEntitlements } from "@/platform/entitlements";
import { enqueueJob, type JobHandlers } from "@/platform/jobs";
import { isFacilityInScope } from "@/platform/locations";
import {
  appLink,
  emailSubscribers,
  isEmailChannelOn,
  memberAddress,
  wantsEmail,
} from "@/platform/notifications";
import { readSetting } from "@/platform/settings";
import { forOrganization } from "@/server";

import { dayWindow } from "./calendar-day";
import { listExpiringLots } from "./lots";
import { listLowStock } from "./minimums";
import type { InventoryActor } from "./movements";
import { DAILY_DIGEST_NOTICE } from "./notices";
import { DIGEST_HOUR } from "./settings";

/**
 * The daily summary by mail (WMS-39B, ADR 0060). A round of the worker
 * (`runDailyDigestRound`, every hour) sets aside, once the company's hour
 * has come, one summary per person that asked for it and day of the
 * company's calendar, and queues its job; the job (`sendDailyDigest`)
 * reads what asks for attention **with the services of the screens**, as
 * that person — so permissions, warehouses and zones are theirs — and sends
 * it only when there is something to say.
 *
 * - Lots about to expire: `listExpiringLots`, one block per warehouse the
 *   person reaches.
 * - Low stock: `listLowStock`, a figure of the whole company, only for who
 *   is not limited to warehouses or zones (the service answers `limited`
 *   for the others, and nothing is listed or counted for them).
 * - Never costs: neither service returns them.
 */

export const DAILY_DIGEST_JOB_TYPE = "inventory.send_daily_digest";
/** Lines of each section; the rest are counted and lead to the screen. */
export const DIGEST_LINES = 10;
/** People a round reads at most. */
const SUBSCRIBERS_MAX = 1000;
/** Ended summaries are kept this many days. */
const DIGEST_KEEP_DAYS = 90;
const MAX_ATTEMPTS = 4;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];

type Client = ReturnType<typeof forOrganization>;

/** The hour (0–23) a moment falls in, in a time zone. */
function hourIn(at: Date, timeZone: string): number {
  const format = (zone: string) =>
    Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hour: "numeric",
        hourCycle: "h23",
      }).format(at),
    );
  try {
    return format(timeZone);
  } catch {
    return format("UTC");
  }
}

async function timeZoneOf(client: Client): Promise<string> {
  const membership = await client.membership.findFirst({
    select: { organization: { select: { timeZone: true } } },
  });
  // The same zone `dayWindow` uses (and the same UTC fallback when the
  // stored one is not valid), so the hour and the day always agree.
  return membership?.organization.timeZone ?? DEFAULT_TIME_ZONE;
}

const dayDate = (day: string) => new Date(`${day}T00:00:00.000Z`);

const isDuplicate = (error: unknown) =>
  (error as { code?: string } | null)?.code === "P2002";

/**
 * Removes the company's summaries that ended more than DIGEST_KEEP_DAYS
 * ago. It runs in the cleanup round of notices, for every company
 * (WMS-88, ADR 0084: also without Inventario in force).
 */
export async function purgeEndedDigests(
  organizationId: string,
  now: Date = new Date(),
): Promise<{ removed: number }> {
  const result = await forOrganization(organizationId).dailyDigest.deleteMany({
    where: {
      status: { not: "QUEUED" },
      createdAt: {
        lt: new Date(now.getTime() - DIGEST_KEEP_DAYS * 86_400_000),
      },
    },
  });
  return { removed: result.count };
}

export type DigestRoundResult = {
  queued: number;
  day?: string;
  reason?: "channel_off" | "too_early";
};

/**
 * Sets aside today's summary of each person who asked for it, once the
 * company's hour has come. Safe to repeat or to run twice at once: the key
 * (company, person, day) keeps one per person and day, and the second
 * transaction that tries is dropped.
 */
export async function runDailyDigestRound(
  organizationId: string,
  now: Date = new Date(),
): Promise<DigestRoundResult> {
  const client = forOrganization(organizationId);
  if (!(await isEmailChannelOn(client))) {
    return { queued: 0, reason: "channel_off" };
  }
  const [timeZone, hour] = await Promise.all([
    timeZoneOf(client),
    readSetting(client, DIGEST_HOUR),
  ]);
  if (hourIn(now, timeZone) < Number(hour)) {
    return { queued: 0, reason: "too_early" };
  }
  const window = await dayWindow(client, now);
  if (!window) return { queued: 0 };
  const day = dayDate(window.day);
  const people = await emailSubscribers(
    client,
    DAILY_DIGEST_NOTICE.key,
    SUBSCRIBERS_MAX,
  );
  let queued = 0;
  for (const userId of people) {
    try {
      const made = await client.$transaction(async (tx) => {
        const existing = await tx.dailyDigest.findFirst({
          where: { userId, day },
          select: { id: true },
        });
        if (existing) return false;
        const digestId = newId();
        await tx.dailyDigest.create({
          data: { id: digestId, organizationId, userId, day },
        });
        await enqueueJob(tx, organizationId, {
          type: DAILY_DIGEST_JOB_TYPE,
          payload: { digestId },
          maxAttempts: MAX_ATTEMPTS,
        });
        return true;
      });
      if (made) queued += 1;
    } catch (error) {
      // Another round set it aside at the same moment: it is theirs.
      if (isDuplicate(error)) continue;
      throw error;
    }
  }
  return { queued, day: window.day };
}

export type DigestSection = {
  title: string;
  lines: string[];
  more: number;
  url: string;
  /** One line under the section (how to see it in the app). */
  note?: string;
};

/**
 * What the summary of a person says today, read with the services of the
 * screens as that person. Empty when nothing asks for attention.
 */
export async function digestSections(
  actor: InventoryActor,
): Promise<DigestSection[]> {
  const { organizationId, userId } = actor;
  const client = forOrganization(organizationId);
  const sections: DigestSection[] = [];

  if (await isAllowed(organizationId, userId, "inventory.stock.read")) {
    const facilities = await client.facility.findMany({
      where: { archivedAt: null },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }, { id: "asc" }],
      take: 100,
      select: { id: true, name: true },
    });
    const reached: typeof facilities = [];
    for (const facility of facilities) {
      if (await isFacilityInScope(client, userId, facility.id)) {
        reached.push(facility);
      }
    }
    for (const facility of reached) {
      const page = await listExpiringLots(actor, { facilityId: facility.id });
      if (page.total === 0) continue;
      const shown = page.items.slice(0, DIGEST_LINES);
      sections.push({
        title:
          reached.length > 1
            ? `Lotes por caducar en ${facility.name} (${page.total})`
            : `Lotes por caducar (${page.total})`,
        lines: shown.map(
          (lot) =>
            `${lot.productName} (${lot.sku}) · lote ${lot.code} · ${lot.expiryText} · ${lot.quantityLabel}`,
        ),
        more: page.total - shown.length,
        url: appLink("/inventario/por-caducar"),
        // «Por caducar» lists the warehouse the person works in.
        ...(reached.length > 1
          ? {
              note: `Para verlos en WMS, cambia a ${facility.name} desde el menú.`,
            }
          : {}),
      });
    }
  }

  if (await isAllowed(organizationId, userId, "inventory.minimum.read")) {
    const low = await lowStockSection(actor);
    if (low) sections.push(low);
  }
  return sections;
}

/**
 * WMS-88 (ADR 0084): «Existencias bajas» is a figure of the whole company,
 * the same for everybody who may read it, without costs. The jobs of one
 * round reuse it for LOW_STOCK_REUSE_MS instead of reading it once per
 * person; each person is still checked (the permission, by the caller, and
 * that they see the whole company) before the copy is used.
 */
const LOW_STOCK_REUSE_MS = 10 * 60_000;
const lowStockCopies = new Map<
  string,
  { at: number; section: DigestSection | null }
>();

async function lowStockSection(
  actor: InventoryActor,
): Promise<DigestSection | null> {
  const client = forOrganization(actor.organizationId);
  // Minimums are of the whole company: nothing for who is limited.
  if (!(await seesWholeCompany(client, actor.userId))) return null;
  const now = Date.now();
  const copy = lowStockCopies.get(actor.organizationId);
  if (copy && now - copy.at < LOW_STOCK_REUSE_MS) return copy.section;
  const low = await listLowStock(actor);
  if (low.limited) return null;
  const shown = low.items.slice(0, DIGEST_LINES);
  const section =
    low.total > 0
      ? {
          title: `Existencias bajas (${low.total})`,
          lines: shown.map(
            (item) =>
              `${item.name} (${item.sku}): hay ${item.stockLabel}, mínimo ${item.minimumLabel}`,
          ),
          more: low.total - shown.length,
          url: appLink("/inventario/bajas"),
        }
      : null;
  for (const [key, each] of lowStockCopies) {
    if (now - each.at >= LOW_STOCK_REUSE_MS) lowStockCopies.delete(key);
  }
  lowStockCopies.set(actor.organizationId, { at: now, section });
  return section;
}

export type DigestOutcome =
  | { sent: true; to: string; sections: number }
  | { sent: false; reason: string };

/**
 * Sends the summary set aside for a person (the worker). Run again, a
 * summary that already ended is left as it ended. Throws only when the
 * mail could not leave: the queue tries again.
 */
export async function sendDailyDigest(
  organizationId: string,
  digestId: string,
): Promise<DigestOutcome> {
  const client = forOrganization(organizationId);
  const digest = await client.dailyDigest.findFirst({
    where: { id: String(digestId).slice(0, 36) },
    select: { id: true, userId: true, day: true, status: true },
  });
  if (!digest) return { sent: false, reason: "El resumen ya no existe." };
  if (digest.status !== "QUEUED") {
    return { sent: false, reason: "El resumen ya había terminado." };
  }
  const end = async (
    status: "EMPTY" | "SKIPPED" | "FAILED",
    reason: string,
  ): Promise<DigestOutcome> => {
    await client.dailyDigest.updateMany({
      where: { id: digest.id, status: "QUEUED" },
      data: { status, reason },
    });
    return { sent: false, reason };
  };
  if (!(await isEmailChannelOn(client))) {
    return end("SKIPPED", "La empresa apagó los avisos por correo.");
  }
  // Only with the plan in force (ADR 0060).
  if (!(await getFreshEntitlements(organizationId)).hasModule("inventory")) {
    return end("SKIPPED", "La empresa no tiene un plan vigente.");
  }
  const address = await memberAddress(client, digest.userId);
  if (!address) {
    return end(
      "SKIPPED",
      "La persona ya no está en la empresa o no tiene correo confirmado.",
    );
  }
  if (!(await wantsEmail(client, digest.userId, DAILY_DIGEST_NOTICE))) {
    return end("SKIPPED", "La persona dejó de pedir el resumen.");
  }
  // What it says is read now: a summary that waited until the next day
  // of the company would carry that day's data under yesterday's date.
  // The round of today sets aside a new one.
  const day = digest.day.toISOString().slice(0, 10);
  const today = await dayWindow(client, new Date());
  if (today && today.day !== day) {
    return end("SKIPPED", "Su día ya pasó; sale el de hoy.");
  }
  const sections = await digestSections({
    organizationId,
    userId: digest.userId,
  });
  if (sections.length === 0) return end("EMPTY", "No había nada que decir.");

  try {
    await sendEmail(
      dailyDigestEmail({
        to: address.email,
        organizationName: address.organizationName,
        dayLabel: formatDate(new Date(`${day}T12:00:00.000Z`), "UTC"),
        sections,
        settingsUrl: appLink("/configuracion/avisos"),
      }),
    );
  } catch (error) {
    if (error instanceof InvalidEmailError) {
      log.warn("daily_digest_rejected", { organizationId, digestId });
      return end(
        "FAILED",
        "El correo no se pudo armar con los datos de la cuenta.",
      );
    }
    throw error;
  }
  await client.dailyDigest.updateMany({
    where: { id: digest.id, status: "QUEUED" },
    data: { status: "SENT", sentAt: new Date() },
  });
  return { sent: true, to: address.email, sections: sections.length };
}

const digestIdOf = (payload: unknown) =>
  String((payload as { digestId?: unknown } | null)?.digestId ?? "");

/** Background work of the daily summary, by job type. */
export const dailyDigestJobHandlers: JobHandlers = {
  [DAILY_DIGEST_JOB_TYPE]: {
    handle: (context) =>
      sendDailyDigest(context.organizationId, digestIdOf(context.payload)),
    retryDelayMs: (attempt) =>
      RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length) - 1]!,
    onFailed: async (context) => {
      await forOrganization(context.organizationId).dailyDigest.updateMany({
        where: { id: digestIdOf(context.payload), status: "QUEUED" },
        data: {
          status: "FAILED",
          reason: "No se pudo entregar el correo después de varios intentos.",
        },
      });
    },
  },
};
