// Worker of the job queue (IMP-01): a process apart from the web
// application that runs background work — imports, exports — one job at a
// time. Several can run at once; they never take the same job.
//
// Usage:
//   npm run worker                              (database of .env.local)
//   DATABASE_NAME=wms_test npm run worker
// Stop with Ctrl+C: it finishes the job in hand first.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

// The worker runs the same server code as the web application, outside
// Next.js. `server-only` exists to stop that code from reaching a browser
// bundle and throws anywhere else; here — a server process — it resolves
// to an empty module, as it does in the tests.
const serverOnly = pathToFileURL("scripts/server-only-stub.mjs").href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { url: serverOnly, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { db } = await import("@/server/db");
const { runWorker } = await import("@/platform/jobs/queue");
const { jobHandlers } = await import("@/modules/registry/jobs");
const { accountRounds, scheduledRounds } =
  await import("@/modules/registry/rounds");
const { runAccountRounds, runScheduledRounds } =
  await import("@/platform/jobs/rounds");
const { retryAccessAlertEmails } =
  await import("@/platform/auth/access-history");
const {
  ALERT_EVERY_MS,
  HEARTBEAT_EVERY_MS,
  STORAGE_CHECK_EVERY_MS,
  runAlertRound,
  writeStorageCheck,
  writeWorkerHeartbeat,
} = await import("@/platform/ops");
const { pingStorage } = await import("@/platform/files/storage");
const { log } = await import("@/lib");

const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.info("worker_stopping", { signal });
    stop.abort();
  });
}

const workerId = `worker-${process.pid}`;
log.info("worker_started", { workerId, types: Object.keys(jobHandlers) });

// Heartbeat for /api/salud (BAS-11): written on a timer, so a long job does
// not make a live worker look down.
const beat = () =>
  writeWorkerHeartbeat(workerId).catch((error: unknown) =>
    log.error("worker_heartbeat_failed", error),
  );
await beat();
const heartbeat = setInterval(beat, HEARTBEAT_EVERY_MS);

// Operations alerts (PIL-04): one round a minute, never two at once.
let seen: string[] = [];
let checking = false;
const alerts = setInterval(() => {
  if (checking) return;
  checking = true;
  runAlertRound(seen)
    .then((now) => (seen = now))
    .catch((error: unknown) => log.error("ops_alert_round_failed", error))
    .finally(() => (checking = false));
}, ALERT_EVERY_MS);

// Storage of files (WMS-67, ADR 0070): a small write, read and removal
// every few minutes; /api/salud reads what it left, never probing itself.
let probing = false;
const probeStorage = () => {
  if (probing) return;
  probing = true;
  pingStorage()
    .then(async (probe) => {
      if (!probe.ok) {
        log.warn("storage_probe_failed", {
          driver: probe.driver,
          reason: probe.error,
        });
      }
      await writeStorageCheck(probe);
    })
    .catch((error: unknown) => log.error("storage_probe_round_failed", error))
    .finally(() => (probing = false));
};
probeStorage();
const storageProbe = setInterval(probeStorage, STORAGE_CHECK_EVERY_MS);

// Scheduled rounds of the modules (PAG-07): a minute after starting and
// then once an hour, never two at once.
const ROUNDS_EVERY_MS = 60 * 60 * 1000;
let rounding = false;
const runRounds = () => {
  if (rounding) return;
  rounding = true;
  // WMS-88: the rounds of the companies and those of no company run each
  // on their own: one failing never skips the other.
  runScheduledRounds(scheduledRounds, (round, organizationId, error) =>
    log.error("scheduled_round_failed", error, { round, organizationId }),
  )
    .catch((error: unknown) => log.error("scheduled_rounds_failed", error))
    .then(() =>
      runAccountRounds(accountRounds, (round, error) =>
        log.error("account_round_failed", error, { round }),
      ),
    )
    .catch((error: unknown) => log.error("account_rounds_failed", error))
    .finally(() => (rounding = false));
};
const firstRounds = setTimeout(runRounds, 60_000);

// WMS-88 (ADR 0084): access alert mails that failed are tried again, once a
// minute, never two turns at once.
let retrying = false;
const alertMails = setInterval(() => {
  if (retrying) return;
  retrying = true;
  retryAccessAlertEmails()
    .catch((error: unknown) => log.error("access_alert_retry_failed", error))
    .finally(() => (retrying = false));
}, 60_000);
const rounds = setInterval(runRounds, ROUNDS_EVERY_MS);

await runWorker(jobHandlers, {
  workerId,
  signal: stop.signal,
  onOutcome: (outcome) => {
    if (outcome.kind === "idle") return;
    const fields = {
      jobId: outcome.jobId,
      organizationId: outcome.organizationId,
      ...("error" in outcome ? { reason: outcome.error } : {}),
    };
    if (outcome.kind === "failed") log.warn(`job_${outcome.kind}`, fields);
    else log.info(`job_${outcome.kind}`, fields);
  },
});
clearInterval(heartbeat);
clearInterval(alerts);
clearInterval(storageProbe);
clearTimeout(firstRounds);
clearInterval(rounds);
clearInterval(alertMails);
await db.$disconnect();
log.info("worker_stopped", { workerId });
