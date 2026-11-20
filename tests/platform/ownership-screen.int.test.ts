import { createHmac } from "node:crypto";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { ForbiddenError, newId } from "@/lib";
import { moduleRegistry } from "@/modules/registry";
import {
  auth,
  confirmIdentity,
  confirmTotpEnrollment,
  startTotpEnrollment,
} from "@/platform/auth";
import {
  acceptOwnershipWithConfirmation,
  cancelOwnershipFromScreen,
  cancelOwnershipTransfer,
  declineOwnershipFromScreen,
  declineOwnershipTransfer,
  disableMember,
  getOwnershipOfferFor,
  getPendingOwnershipTransfer,
  grantSupportAccess,
  isAllowed,
  revokeSupportAccess,
  listOwnershipCandidates,
  offerOwnershipWithConfirmation,
  type Role,
} from "@/platform/authorization";
// Without the confirmation of the screen (WMS-90): not in index.ts.
import {
  acceptOwnershipTransfer,
  offerOwnershipTransfer,
} from "@/platform/authorization/ownership";
import { activateModule, deactivateModule } from "@/platform/billing";
import { memoryOutboxFor } from "@/platform/email";
import { invalidateEntitlements } from "@/platform/entitlements";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

import { grantSeats } from "../setup/plan";

// WMS-90 (ADR 0090): the screen to transfer the company. Offering and
// accepting ask the password and a current code again (never from a PIN
// session, never by support); the recipient may decline; accepting closes
// an open support access and refuses a kept role whose module is gone.
// Races go through the real services with Promise.all. NEG-26.

/**
 * Who the request comes from at a shared terminal (WMS-38), if anybody.
 * Mocked in the module itself, so every importer (the policy through the
 * index and `confirmIdentity` through its relative import) sees it.
 */
let terminalUser: string | null = null;
vi.mock("@/platform/auth/terminal-session", async (original) => {
  const real =
    await original<typeof import("@/platform/auth/terminal-session")>();
  return {
    ...real,
    terminalUserOfRequest: async () => terminalUser,
    assertNotTerminalSession: async (userId: string) => {
      if (terminalUser === userId) {
        throw new ForbiddenError(
          "terminal_session",
          real.TERMINAL_SESSION_MESSAGE,
        );
      }
    },
  };
});

afterEach(() => {
  terminalUser = null;
  invalidateEntitlements();
});

afterAll(async () => {
  await db.$disconnect();
});

const password = "una-frase-larga-y-segura";
const stamp = Date.now();
let counter = 0;

function totp(base32Secret: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of base32Secret.replace(/=+$/, "")) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  }
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const mac = createHmac("sha1", key).update(counterBuf).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  return ((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000)
    .toString()
    .padStart(6, "0");
}

function cookieFrom(response: Response, name: string): string {
  return (
    response.headers
      .getSetCookie()
      .find((c) => c.includes(`${name}=`) && !c.includes("Max-Age=0"))
      ?.split(";")[0] ?? ""
  );
}

type Account = {
  userId: string;
  email: string;
  secret: string | null;
  headers: Headers;
};

/** A real account signed in, with MFA on unless asked otherwise. */
async function account(label: string, mfa = true): Promise<Account> {
  const email = `${label}.${++counter}.ownscr.${stamp}@example.test`;
  await auth.api.signUpEmail({ body: { name: label, email, password } });
  const user = await db.user.update({
    where: { email },
    data: { emailVerified: true },
  });
  const signedIn = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const headers = new Headers({
    "x-forwarded-for": `10.90.${counter % 250}.1`,
    cookie: cookieFrom(signedIn, "better-auth.session_token"),
  });
  if (!mfa) return { userId: user.id, email, secret: null, headers };
  const started = await startTotpEnrollment(user.id, { password }, headers);
  if (!started.ok) throw new Error(started.error);
  const confirmed = await confirmTotpEnrollment(
    user.id,
    { code: totp(started.secret) },
    headers,
  );
  if (!confirmed.ok) throw new Error(confirmed.error);
  // Turning MFA on rotates the session: sign in again with both steps.
  const challenge = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const second = await auth.api.verifyTOTP({
    body: { code: totp(started.secret) },
    headers: new Headers({
      cookie: cookieFrom(challenge, "better-auth.two_factor"),
    }),
    asResponse: true,
  });
  headers.set("cookie", cookieFrom(second, "better-auth.session_token"));
  return { userId: user.id, email, secret: started.secret, headers };
}

/** A user row only, for the service-level cases. */
async function rowUser(label: string, mfa = true) {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: label,
      email: `${label}.${++counter}.ownscr.${stamp}@example.test`,
      emailVerified: true,
      twoFactorEnabled: mfa,
    },
  });
  return user.id;
}

async function addMember(
  organizationId: string,
  userId: string,
  roles: Role[] = ["administrator"],
) {
  const membership = await db.membership.create({
    data: { id: newId(), organizationId, userId, status: "ACTIVE" },
  });
  for (const role of roles) {
    await db.membershipRole.create({
      data: { id: newId(), organizationId, membershipId: membership.id, role },
    });
  }
  return membership.id;
}

async function company(ownerUserId: string) {
  const created = await createOrganization(ownerUserId, {
    name: `Empresa titularidad ${++counter}`,
    timeZone: "",
  });
  if (!created.ok) throw new Error("company setup failed");
  return created.organizationId;
}

const ownerOf = async (org: string) =>
  (await db.organization.findUniqueOrThrow({ where: { id: org } })).ownerUserId;

const auditOf = (org: string, action: string) =>
  db.auditEvent.count({ where: { organizationId: org, action } });

const noticesOf = (org: string, userId: string) =>
  db.notification.findMany({
    where: {
      organizationId: org,
      recipientUserId: userId,
      typeKey: "team.ownership",
    },
    select: { text: true },
  });

describe("the screen flow with password and code", () => {
  it("offers, then the recipient accepts; one titular, roles and scope as decided", async () => {
    const owner = await account("titular");
    const heir = await account("sucesor");
    const org = await company(owner.userId);
    await addMember(org, heir.userId, ["administrator"]);

    expect(await listOwnershipCandidates(org, owner.userId)).toEqual([
      expect.objectContaining({ userId: heir.userId, hasMfa: true }),
    ]);
    // Only the titular gets candidates.
    expect(await listOwnershipCandidates(org, heir.userId)).toEqual([]);

    const offered = await offerOwnershipWithConfirmation(
      org,
      owner.userId,
      {
        toUserId: heir.userId,
        previousOwnerRoles: ["viewer"],
        password,
        code: totp(owner.secret!),
      },
      owner.headers,
    );
    expect(offered).toEqual({ ok: true });
    expect(await ownerOf(org)).toBe(owner.userId);
    expect(await noticesOf(org, heir.userId)).toHaveLength(1);
    expect(memoryOutboxFor(owner.email).at(-1)?.subject).toMatch(
      /Ofreciste la titularidad/,
    );
    const mailToHeir = memoryOutboxFor(heir.email).at(-1);
    expect(mailToHeir?.subject).toMatch(/te ofrece la titularidad/);
    expect(mailToHeir?.text).not.toMatch(/https?:\/\//);

    const offer = await getOwnershipOfferFor(org, heir.userId);
    expect(offer).toMatchObject({
      fromUserId: owner.userId,
      previousOwnerRoles: ["viewer"],
      recipientHasMfa: true,
    });
    // Nobody else sees it as theirs.
    expect(await getOwnershipOfferFor(org, owner.userId)).toBeNull();

    // Open support access: it is closed when the company changes hands.
    await grantSupportAccess({ organizationId: org, userId: owner.userId });

    const accepted = await acceptOwnershipWithConfirmation(
      org,
      heir.userId,
      { transferId: offer!.id, password, code: totp(heir.secret!) },
      heir.headers,
    );
    expect(accepted).toEqual({ ok: true });
    expect(await ownerOf(org)).toBe(heir.userId);
    expect(
      await isAllowed(org, heir.userId, "platform.ownership.transfer"),
    ).toBe(true);
    expect(
      await isAllowed(org, owner.userId, "platform.ownership.transfer"),
    ).toBe(false);
    const previousRoles = await db.membershipRole.findMany({
      where: {
        organizationId: org,
        membership: { userId: owner.userId },
      },
      select: { role: true },
    });
    expect(previousRoles.map((r) => r.role)).toEqual(["viewer"]);
    expect(
      await db.supportAccess.count({
        where: { organizationId: org, revokedAt: null },
      }),
    ).toBe(0);
    expect(await auditOf(org, "support.revoked")).toBe(1);
    expect(await auditOf(org, "ownership.transferred")).toBe(1);
    expect(await noticesOf(org, owner.userId)).toHaveLength(1);
    expect(memoryOutboxFor(owner.email).at(-1)?.subject).toMatch(
      /Ya no eres titular/,
    );
    expect(memoryOutboxFor(heir.email).at(-1)?.subject).toMatch(
      /Ahora eres titular/,
    );
  }, 60_000);

  it("a wrong password or code changes nothing and counts toward the limit", async () => {
    const owner = await account("titular");
    const heir = await account("sucesor");
    const org = await company(owner.userId);
    await addMember(org, heir.userId);

    const base = {
      toUserId: heir.userId,
      previousOwnerRoles: ["viewer"],
    };
    expect(
      await offerOwnershipWithConfirmation(
        org,
        owner.userId,
        { ...base, password: "otra-cosa-distinta", code: totp(owner.secret!) },
        owner.headers,
      ),
    ).toMatchObject({ ok: false, field: "password" });
    expect(
      await offerOwnershipWithConfirmation(
        org,
        owner.userId,
        {
          ...base,
          password,
          code: totp(owner.secret!) === "000000" ? "111111" : "000000",
        },
        owner.headers,
      ),
    ).toMatchObject({ ok: false, field: "code" });
    expect(
      await offerOwnershipWithConfirmation(
        org,
        owner.userId,
        { ...base, password, code: "abc" },
        owner.headers,
      ),
    ).toMatchObject({ ok: false, field: "code" });
    expect(await getPendingOwnershipTransfer(org)).toBeNull();

    // Three more wrong passwords block the step for a while (5 in 15 min).
    for (let i = 0; i < 3; i++) {
      await offerOwnershipWithConfirmation(
        org,
        owner.userId,
        { ...base, password: "otra-cosa-distinta", code: totp(owner.secret!) },
        owner.headers,
      );
    }
    const blocked = await offerOwnershipWithConfirmation(
      org,
      owner.userId,
      { ...base, password, code: totp(owner.secret!) },
      owner.headers,
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.ok ? "" : blocked.error).toMatch(/intent/i);
    expect(await getPendingOwnershipTransfer(org)).toBeNull();
  }, 60_000);

  it("the recipient without two steps is told so and cannot accept", async () => {
    const owner = await account("titular");
    const heir = await account("sin-mfa", false);
    const org = await company(owner.userId);
    await addMember(org, heir.userId, ["warehouse"]);
    expect(await listOwnershipCandidates(org, owner.userId)).toEqual([
      expect.objectContaining({ userId: heir.userId, hasMfa: false }),
    ]);
    const transfer = await offerOwnershipTransfer(org, owner.userId, {
      toUserId: heir.userId,
    });
    if (!transfer.ok) throw new Error(transfer.reason);
    expect(
      await acceptOwnershipWithConfirmation(
        org,
        heir.userId,
        { transferId: transfer.transferId, password, code: "123456" },
        heir.headers,
      ),
    ).toMatchObject({ ok: false });
    expect(await ownerOf(org)).toBe(owner.userId);
  }, 60_000);

  it("the recipient declines; the titular is told and nothing changes", async () => {
    const owner = await rowUser("titular");
    const heir = await rowUser("sucesor");
    const org = await company(owner);
    await addMember(org, heir);
    const transfer = await offerOwnershipTransfer(org, owner, {
      toUserId: heir,
    });
    if (!transfer.ok) throw new Error(transfer.reason);

    // Somebody else cannot decline it.
    expect(
      await declineOwnershipTransfer(org, owner, transfer.transferId),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(
      await declineOwnershipFromScreen(org, heir, transfer.transferId),
    ).toEqual({ ok: true });
    expect(await getPendingOwnershipTransfer(org)).toBeNull();
    expect(await ownerOf(org)).toBe(owner);
    expect(await auditOf(org, "ownership.transfer_declined")).toBe(1);
    expect(await noticesOf(org, owner)).toHaveLength(1);
    expect(
      await acceptOwnershipTransfer(org, heir, transfer.transferId),
    ).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("the titular cancels; the recipient is told", async () => {
    const owner = await rowUser("titular");
    const heir = await rowUser("sucesor");
    const org = await company(owner);
    await addMember(org, heir);
    await offerOwnershipTransfer(org, owner, { toUserId: heir });
    expect(await cancelOwnershipFromScreen(org, owner)).toEqual({ ok: true });
    expect(await getOwnershipOfferFor(org, heir)).toBeNull();
    expect(await noticesOf(org, heir)).toHaveLength(2);
    // An administrator is not the titular.
    await expect(cancelOwnershipFromScreen(org, heir)).rejects.toThrow(
      ForbiddenError,
    );
  });
});

describe("who can never do it", () => {
  it("a PIN session neither offers, cancels, accepts nor declines", async () => {
    const owner = await rowUser("titular");
    const heir = await rowUser("sucesor");
    const org = await company(owner);
    await addMember(org, heir);
    const transfer = await offerOwnershipTransfer(org, owner, {
      toUserId: heir,
    });
    if (!transfer.ok) throw new Error(transfer.reason);

    terminalUser = owner;
    expect(await isAllowed(org, owner, "platform.ownership.transfer")).toBe(
      false,
    );
    await expect(
      offerOwnershipWithConfirmation(
        org,
        owner,
        { toUserId: heir, previousOwnerRoles: ["viewer"], password, code: "1" },
        new Headers(),
      ),
    ).rejects.toThrow(ForbiddenError);
    await expect(cancelOwnershipFromScreen(org, owner)).rejects.toThrow(
      ForbiddenError,
    );

    terminalUser = heir;
    await expect(
      acceptOwnershipWithConfirmation(
        org,
        heir,
        { transferId: transfer.transferId, password, code: "123456" },
        new Headers(),
      ),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      declineOwnershipFromScreen(org, heir, transfer.transferId),
    ).rejects.toThrow(ForbiddenError);
    expect(await getPendingOwnershipTransfer(org)).not.toBeNull();
    expect(await ownerOf(org)).toBe(owner);
  });

  it("platform support with an open window cannot offer, accept or decline", async () => {
    const owner = await rowUser("titular");
    const heir = await rowUser("sucesor");
    const staff = await rowUser("soporte");
    await db.platformStaff.create({ data: { userId: staff } });
    const org = await company(owner);
    await addMember(org, heir);
    await grantSupportAccess({ organizationId: org, userId: owner });
    const transfer = await offerOwnershipTransfer(org, owner, {
      toUserId: heir,
    });
    if (!transfer.ok) throw new Error(transfer.reason);

    await expect(
      offerOwnershipWithConfirmation(
        org,
        staff,
        { toUserId: heir, previousOwnerRoles: ["viewer"], password, code: "1" },
        new Headers(),
      ),
    ).rejects.toThrow(ForbiddenError);
    expect(
      await offerOwnershipTransfer(org, staff, { toUserId: heir }),
    ).toMatchObject({ ok: false, reason: "not_owner" });
    expect(
      await acceptOwnershipWithConfirmation(
        org,
        staff,
        { transferId: transfer.transferId, password, code: "123456" },
        new Headers(),
      ),
    ).toMatchObject({ ok: false });
    expect(
      await declineOwnershipTransfer(org, staff, transfer.transferId),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(await ownerOf(org)).toBe(owner);
  });

  it("an offer of one company is not answered from another", async () => {
    const ownerA = await rowUser("titular-a");
    const ownerB = await rowUser("titular-b");
    const heir = await rowUser("sucesor");
    const orgA = await company(ownerA);
    const orgB = await company(ownerB);
    await addMember(orgA, heir);
    await addMember(orgB, heir);
    const transfer = await offerOwnershipTransfer(orgA, ownerA, {
      toUserId: heir,
    });
    if (!transfer.ok) throw new Error(transfer.reason);

    expect(await getOwnershipOfferFor(orgB, heir)).toBeNull();
    expect(
      await acceptOwnershipTransfer(orgB, heir, transfer.transferId),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(
      await declineOwnershipTransfer(orgB, heir, transfer.transferId),
    ).toMatchObject({ ok: false, reason: "not_found" });
    // The titular of B cannot cancel the offer of A.
    expect(await cancelOwnershipTransfer(orgB, ownerB)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(await getPendingOwnershipTransfer(orgA)).not.toBeNull();
    expect(await ownerOf(orgA)).toBe(ownerA);
    expect(await ownerOf(orgB)).toBe(ownerB);
  });

  it("an expired offer is not shown nor accepted", async () => {
    const owner = await rowUser("titular");
    const heir = await rowUser("sucesor");
    const org = await company(owner);
    await addMember(org, heir);
    const transfer = await offerOwnershipTransfer(org, owner, {
      toUserId: heir,
    });
    if (!transfer.ok) throw new Error(transfer.reason);
    await db.ownershipTransfer.update({
      where: { id: transfer.transferId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await getOwnershipOfferFor(org, heir)).toBeNull();
    expect(
      await acceptOwnershipTransfer(org, heir, transfer.transferId),
    ).toMatchObject({ ok: false, reason: "expired" });
  });

  it("a company with a single member has nobody to offer it to", async () => {
    const owner = await rowUser("solo");
    const org = await company(owner);
    expect(await listOwnershipCandidates(org, owner)).toEqual([]);
  });
});

describe("modules of the roles to keep (WMS-59)", () => {
  it("a module removed after the offer makes the acceptance fail", async () => {
    const owner = await rowUser("titular");
    const heir = await rowUser("sucesor");
    const org = await company(owner);
    await grantSeats(org);
    await addMember(org, heir);
    for (const moduleId of ["inventory", "production"]) {
      await activateModule(moduleRegistry, {
        organizationId: org,
        moduleId,
        actorUserId: null,
      });
    }
    invalidateEntitlements();
    const transfer = await offerOwnershipTransfer(org, owner, {
      toUserId: heir,
      previousOwnerRoles: ["production_supervisor"],
    });
    if (!transfer.ok) throw new Error(transfer.reason);
    const removed = await deactivateModule(moduleRegistry, {
      organizationId: org,
      moduleId: "production",
      actorUserId: null,
    });
    expect(removed.ok).toBe(true);
    invalidateEntitlements();
    expect(
      await acceptOwnershipTransfer(org, heir, transfer.transferId),
    ).toMatchObject({ ok: false, reason: "module_missing" });
    expect(await ownerOf(org)).toBe(owner);
  });
});

describe("races (NEG-26)", () => {
  async function setup() {
    const owner = await rowUser("titular");
    const heir = await rowUser("sucesor");
    const org = await company(owner);
    await grantSeats(org);
    await addMember(org, heir);
    const transfer = await offerOwnershipTransfer(org, owner, {
      toUserId: heir,
    });
    if (!transfer.ok) throw new Error(transfer.reason);
    return { org, owner, heir, transferId: transfer.transferId };
  }

  it("accepting and cancelling at once: exactly one wins", async () => {
    const s = await setup();
    const [accepted, cancelled] = await Promise.all([
      acceptOwnershipTransfer(s.org, s.heir, s.transferId),
      cancelOwnershipTransfer(s.org, s.owner),
    ]);
    expect([accepted.ok, cancelled.ok].filter(Boolean)).toHaveLength(1);
    expect(await ownerOf(s.org)).toBe(accepted.ok ? s.heir : s.owner);
    expect(
      await db.ownershipTransfer.count({
        where: { organizationId: s.org, status: "PENDING" },
      }),
    ).toBe(0);
  });

  it("accepting and declining at once: exactly one wins", async () => {
    const s = await setup();
    const [accepted, declined] = await Promise.all([
      acceptOwnershipTransfer(s.org, s.heir, s.transferId),
      declineOwnershipTransfer(s.org, s.heir, s.transferId),
    ]);
    expect([accepted.ok, declined.ok].filter(Boolean)).toHaveLength(1);
    expect(await ownerOf(s.org)).toBe(accepted.ok ? s.heir : s.owner);
  });

  it("accepting and disabling the recipient at once: never a disabled titular", async () => {
    const s = await setup();
    const [accepted, disabled] = await Promise.all([
      acceptOwnershipTransfer(s.org, s.heir, s.transferId),
      disableMember(s.org, s.owner, { userId: s.heir }),
    ]);
    expect([accepted.ok, disabled.ok].filter(Boolean)).toHaveLength(1);
    const membership = await db.membership.findFirstOrThrow({
      where: { organizationId: s.org, userId: s.heir },
    });
    if (accepted.ok) {
      expect(await ownerOf(s.org)).toBe(s.heir);
      expect(membership.status).toBe("ACTIVE");
    } else {
      expect(await ownerOf(s.org)).toBe(s.owner);
      expect(membership.status).toBe("DISABLED");
      expect(await getPendingOwnershipTransfer(s.org)).toBeNull();
    }
  });

  it("two offers at once leave a single pending one", async () => {
    const s = await setup();
    const other = await rowUser("otro");
    await addMember(s.org, other, ["viewer"]);
    const results = await Promise.all([
      offerOwnershipTransfer(s.org, s.owner, { toUserId: s.heir }),
      offerOwnershipTransfer(s.org, s.owner, { toUserId: other }),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(
      await db.ownershipTransfer.count({
        where: { organizationId: s.org, status: "PENDING" },
      }),
    ).toBe(1);
  });

  it("two acceptances by the same person: one titular, one audit line", async () => {
    const s = await setup();
    const results = await Promise.all([
      acceptOwnershipTransfer(s.org, s.heir, s.transferId),
      acceptOwnershipTransfer(s.org, s.heir, s.transferId),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await auditOf(s.org, "ownership.transferred")).toBe(1);
  });
});

describe("second-round fixes of the review", () => {
  it("an app code works once: the same code is refused the second time", async () => {
    const owner = await account("titular");
    const code = totp(owner.secret!);
    expect(
      await confirmIdentity(owner.userId, { password, code }, owner.headers),
    ).toEqual({ ok: true });
    expect(
      await confirmIdentity(owner.userId, { password, code }, owner.headers),
    ).toMatchObject({ ok: false, field: "code" });
  }, 60_000);

  it("confirmIdentity itself refuses a PIN session", async () => {
    const owner = await rowUser("titular");
    terminalUser = owner;
    await expect(
      confirmIdentity(owner, { password, code: "123456" }, new Headers()),
    ).rejects.toThrow(ForbiddenError);
  });

  it("the company is transferred with the plan ended", async () => {
    const owner = await rowUser("titular");
    const heir = await rowUser("sucesor");
    const org = await company(owner);
    await grantSeats(org);
    await addMember(org, heir);
    await activateModule(moduleRegistry, {
      organizationId: org,
      moduleId: "inventory",
      actorUserId: null,
    });
    await db.entitlement.updateMany({
      where: { organizationId: org },
      data: {
        validFrom: new Date(Date.now() - 2 * 86_400_000),
        validUntil: new Date(Date.now() - 86_400_000),
      },
    });
    invalidateEntitlements(org);
    expect(await isAllowed(org, owner, "platform.ownership.transfer")).toBe(
      true,
    );
    const transfer = await offerOwnershipTransfer(org, owner, {
      toUserId: heir,
    });
    if (!transfer.ok) throw new Error(transfer.reason);
    expect(
      await acceptOwnershipTransfer(org, heir, transfer.transferId),
    ).toEqual({ ok: true });
    expect(await ownerOf(org)).toBe(heir);
  });

  it("a replaced offer tells its recipient that it was cancelled", async () => {
    const owner = await rowUser("titular");
    const first = await rowUser("primero");
    const second = await rowUser("segundo");
    const org = await company(owner);
    await grantSeats(org);
    await addMember(org, first);
    await addMember(org, second);
    await offerOwnershipTransfer(org, owner, { toUserId: first });
    await offerOwnershipTransfer(org, owner, { toUserId: second });
    const texts = (await noticesOf(org, first)).map((n) => n.text);
    expect(texts).toHaveLength(2);
    expect(texts.some((t) => t.includes("canceló"))).toBe(true);
  });

  it("support granted while the company changes hands never stays open by the previous titular", async () => {
    const owner = await rowUser("titular");
    const heir = await rowUser("sucesor");
    const org = await company(owner);
    await grantSeats(org);
    await addMember(org, heir);
    const transfer = await offerOwnershipTransfer(org, owner, {
      toUserId: heir,
    });
    if (!transfer.ok) throw new Error(transfer.reason);

    // Hold the company row so both wait on it, then let them race.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM organization WHERE id = ${org} FOR UPDATE`;
        locked();
        await held;
      },
      { timeout: 30_000 },
    );
    await isLocked;
    const racing = Promise.allSettled([
      acceptOwnershipTransfer(org, heir, transfer.transferId),
      grantSupportAccess({ organizationId: org, userId: owner }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await holder;
    const [accepted, granted] = await racing;
    expect(accepted.status).toBe("fulfilled");
    expect(await ownerOf(org)).toBe(heir);
    const open = await db.supportAccess.count({
      where: {
        organizationId: org,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    expect(open).toBe(0);
    if (granted.status === "rejected") {
      expect(granted.reason).toBeInstanceOf(ForbiddenError);
    }
    // And the previous titular can no longer close nor open it.
    await expect(
      revokeSupportAccess({ organizationId: org, userId: owner }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("accepting while a module is removed never hands out a role without it", async () => {
    const owner = await rowUser("titular");
    const heir = await rowUser("sucesor");
    const org = await company(owner);
    await grantSeats(org);
    await addMember(org, heir);
    for (const moduleId of ["inventory", "production"]) {
      await activateModule(moduleRegistry, {
        organizationId: org,
        moduleId,
        actorUserId: null,
      });
    }
    invalidateEntitlements();
    const transfer = await offerOwnershipTransfer(org, owner, {
      toUserId: heir,
      previousOwnerRoles: ["production_supervisor"],
    });
    if (!transfer.ok) throw new Error(transfer.reason);
    const [accepted, removed] = await Promise.all([
      acceptOwnershipTransfer(org, heir, transfer.transferId),
      deactivateModule(moduleRegistry, {
        organizationId: org,
        moduleId: "production",
        actorUserId: null,
      }),
    ]);
    expect(removed.ok).toBe(true);
    const kept = await db.membershipRole.findMany({
      where: { organizationId: org, membership: { userId: owner } },
      select: { role: true },
    });
    if (accepted.ok) {
      // Accepted first, with the module still there: the role is kept.
      expect(kept.map((r) => r.role)).toEqual(["production_supervisor"]);
    } else {
      expect(accepted).toMatchObject({ reason: "module_missing" });
      expect(await ownerOf(org)).toBe(owner);
    }
  });
});
