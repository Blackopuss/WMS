// Links to stop notices by mail for the demo account (WMS-88), for
// `verify:ui` and `verify:a11y`: one that works and one already expired.
// Prints them as environment variables. Only touches the demo account and
// never runs in production or against a public address.
//
// The output is a working link of the demo account: write it to a
// temporary file, load it into the shell that runs the verifiers and
// remove it right after (never commit it nor leave it in shared logs):
//   npx tsx scripts/verify-unsubscribe-links.mts > /tmp/links.env
//   set -a && . /tmp/links.env && set +a && rm /tmp/links.env
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
if (
  process.env.NODE_ENV === "production" ||
  process.env.BETTER_AUTH_URL?.startsWith("https://")
) {
  console.error("Solo para desarrollo local: no corre en producción.");
  process.exit(1);
}
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
const { createUnsubscribeLink } =
  await import("@/platform/notifications/unsubscribe");

const email = process.env.DEMO_EMAIL;
const user = email
  ? await db.user.findUnique({ where: { email }, select: { id: true } })
  : null;
const membership = user
  ? await db.membership.findFirst({
      where: { userId: user.id, status: "ACTIVE" },
      select: { organizationId: true },
    })
  : null;
if (!user || !membership) {
  console.error("No está la cuenta demo: corre npm run db:seed.");
  process.exit(1);
}
const token = (url: string) => new URL(url).searchParams.get("t");
const valid = await createUnsubscribeLink(membership.organizationId, user.id);
// Expired: made 61 days ago.
const old = await createUnsubscribeLink(
  membership.organizationId,
  user.id,
  new Date(Date.now() - 61 * 86_400_000),
);
console.log(`VERIFY_UNSUBSCRIBE_VALID=${token(valid.pageUrl)}`);
console.log(`VERIFY_UNSUBSCRIBE_EXPIRED=${token(old.pageUrl)}`);
await db.$disconnect();
