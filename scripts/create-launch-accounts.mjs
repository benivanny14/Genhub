#!/usr/bin/env node
// =============================================================================
// GENHUB - The first real accounts
//
// Run:  node scripts/create-launch-accounts.mjs \
//         --admin owner@example.com --creator owner@example.com --name "Your Name"
//
// Optional:
//   --phone +2557XXXXXXXX     attach a phone number to the creator account
//   --password <secret>       use this password instead of generating one
//   --locale en|sw            UI language for the new accounts (default: en)
//   --kyc-approved            let the creator upload immediately (read below)
//
// Why this exists next to create-admin.mjs: that script promotes or creates an
// ADMIN, which is all a moderation account needs. Launching also needs someone
// who can *upload*, and a creator account is more than a role —
// `requireRole("CREATOR")` reads the JWT, uploads need `kycStatus: APPROVED`,
// and the creator dashboard reads a `CreatorBalance` row. A role change alone
// produces an account that looks right and cannot do anything.
//
// It is idempotent: run it again and it converges the accounts instead of
// duplicating them, so it is safe to re-run after fixing a typo.
//
// ---------------------------------------------------------------------------
// On --kyc-approved
// ---------------------------------------------------------------------------
// Uploads require KYC approval, and approval is normally a review: submit at
// /creator/kyc, then approve in Admin, which writes a KycVerification row with
// the ID document and the reviewer. This flag sets `User.kycStatus` directly
// and creates NO KycVerification row — so the account can upload while Admin →
// KYC shows nothing, because as far as the audit trail is concerned nobody ever
// reviewed anything.
//
// That is the right trade for the operator's own account during setup, and the
// wrong one for a third party. Without the flag the account is created normally
// and the script prints the two steps to finish it properly.
// =============================================================================

import { randomBytes } from "node:crypto";
import { loadEnv, ok, warn, fail } from "./_env.mjs";
import { isDemoId, isDemoEmail } from "./_demo-identity.mjs";

loadEnv();

// -----------------------------------------------------------------------------
// Arguments
// -----------------------------------------------------------------------------
const argv = process.argv.slice(2);
const value = (flag) => {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
};
const has = (flag) => argv.includes(flag);

const adminEmail = value("--admin");
const creatorEmail = value("--creator");
const displayName = value("--name");
const phone = value("--phone");
const password = value("--password");
const locale = value("--locale") ?? "en";
const kycApproved = has("--kyc-approved");

const usage = `
usage: node scripts/create-launch-accounts.mjs --admin <email> [--creator <email>] [options]

  --admin <email>      the moderation account (required unless --creator is given)
  --creator <email>    the account that uploads. Same address as --admin is fine:
                       ADMIN already passes requireRole("CREATOR").
  --name <text>        display name (required for a new creator)
  --phone <number>     +2557XXXXXXXX or 07XXXXXXXX, attached to the creator
  --password <secret>  use this instead of a generated password (8+ characters)
  --locale en|sw       UI language (default: en)
  --kyc-approved       set kycStatus=APPROVED so uploads work now (see the header)
`;

const isEmail = (v) => typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const phonePattern = /^(\+255|0)[67]\d{8}$/;

const problems = [];
if (!adminEmail && !creatorEmail) problems.push("give at least one of --admin or --creator");
for (const [flag, address] of [["--admin", adminEmail], ["--creator", creatorEmail]]) {
  if (address !== undefined && !isEmail(address)) problems.push(`${flag} is not a valid email: ${address}`);
}
if (creatorEmail && !displayName) problems.push("--name is required when creating a creator");
if (phone && !phonePattern.test(phone)) {
  problems.push(`--phone must look like +2557XXXXXXXX or 07XXXXXXXX, got: ${phone}`);
}
if (password && password.length < 8) problems.push("--password must be at least 8 characters");
if (!["en", "sw"].includes(locale)) problems.push(`--locale must be "en" or "sw", got: ${locale}`);

if (problems.length > 0) {
  console.log(usage);
  for (const problem of problems) fail(problem);
  console.log("");
  process.exit(1);
}

/** Refuse a demo address: the wipe would classify it as demo content later. */
const demoCheck = (email) => {
  if (isDemoEmail(email) || isDemoId(email)) {
    fail(`${email} looks like a demo account (@demo.genhub.local) — pick a real address`);
    process.exit(1);
  }
};
if (adminEmail) demoCheck(adminEmail);
if (creatorEmail) demoCheck(creatorEmail);

const { PrismaClient } = await import("@prisma/client");
const bcrypt = (await import("bcryptjs")).default;
const prisma = new PrismaClient();

const samePerson = Boolean(adminEmail && creatorEmail && adminEmail === creatorEmail);

/**
 * A referral code the register route would accept: readable, unique, and with
 * the same retry shape, so a bootstrap account is not the one row in the table
 * without a shareable code.
 */
async function uniqueReferralCode(name) {
  const base =
    (name || "GEN")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 6) || "GEN";
  for (let attempt = 0; attempt < 12; attempt++) {
    const candidate = `${base}${randomBytes(2).toString("hex").toUpperCase()}`;
    const clash = await prisma.user.findUnique({
      where: { referralCode: candidate },
      select: { id: true },
    });
    if (!clash) return candidate;
  }
  return `${base}${Date.now().toString(36).toUpperCase().slice(-4)}`;
}

/**
 * Create or converge one account.
 *
 * An existing row is promoted rather than replaced: the account may already own
 * videos or a wallet balance, and deleting it to get a clean slate is exactly
 * the mistake this function has to avoid.
 */
async function ensureAccount({ email, role, name, needsBalance, willUpload, attachPhone }) {
  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, role: true, kycStatus: true, displayName: true },
  });

  const created = !existing;

  // The plaintext is only known when this run sets the hash. For an account that
  // already exists, generating one and checking it against the stored hash would
  // always fail — the check has to be about a password that was actually applied.
  // Passing --password for an existing account therefore *resets* it, which is
  // the only reading of that flag a person would expect.
  const setsPassword = created || Boolean(password);
  const plainPassword = setsPassword ? password ?? randomBytes(12).toString("base64url") : null;

  if (created) {
    await prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash(plainPassword, 12),
        displayName: name || (role === "ADMIN" ? "Administrator" : "Creator"),
        role,
        locale,
        referralCode: await uniqueReferralCode(name || role),
        ...(attachPhone && phone ? { phone } : {}),
        // willUpload, not role: an ADMIN that also uploads passes the same KYC
        // gate as a CREATOR, so keying this off the role would hand the operator
        // an account that cannot do the one thing they made it for.
        ...(willUpload && kycApproved ? { kycStatus: "APPROVED" } : {}),
      },
    });
    ok(`created ${role} ${email}`);
  } else {
    // Converge: role is what the JWT and every route read, so a mismatch here is
    // not cosmetic.
    const patch = {};
    if (existing.role !== role && role === "ADMIN") patch.role = "ADMIN";
    if (role === "CREATOR" && existing.role === "VIEWER") patch.role = "CREATOR";
    if (name && existing.displayName !== name) patch.displayName = name;
    if (password) patch.passwordHash = await bcrypt.hash(password, 12);
    // An existing account is the likely case for this flag: you create the
    // creator, find uploads blocked, and come back to approve it. Leaving this
    // out made --kyc-approved a silent no-op on the one account that needed it.
    if (kycApproved && willUpload && existing.kycStatus !== "APPROVED") {
      patch.kycStatus = "APPROVED";
    }
    if (Object.keys(patch).length > 0) {
      await prisma.user.update({ where: { id: existing.id }, data: patch });
      if (patch.passwordHash) ok(`reset the password for ${email}`);
      if (patch.kycStatus) ok(`set kycStatus=APPROVED for ${email} — uploads are unblocked`);
    }
    ok(
      `${email} already exists (${existing.role})` +
        (patch.role ? ` — promoted to ${patch.role}` : " — left as it is")
    );
    // The warning is about the state the account is left in, so it reads from
    // the patch too — otherwise it contradicts the line printed above it.
    const kycNow = patch.kycStatus ?? existing.kycStatus;
    if (kycNow !== "APPROVED" && willUpload) {
      warn(`${email} kycStatus is ${kycNow} — uploads stay blocked`);
    }
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, role: true, kycStatus: true, passwordHash: true, referralCode: true },
  });

  // ADMIN passes requireRole("CREATOR"), so an admin who uploads needs a balance
  // row too. The dashboard falls back to zeros without one, but the release job
  // and payouts both want it to exist.
  if (needsBalance) {
    await prisma.creatorBalance.upsert({
      where: { creatorId: user.id },
      create: { creatorId: user.id },
      update: {},
    });
  }

  // The account is only usable if this hash accepts this password. Checking is
  // one line, and it turns "I created a row" into "you can sign in". When this
  // run did not touch the password there is nothing to check, and saying so is
  // better than reporting a false failure.
  const passwordWorks = setsPassword
    ? await bcrypt.compare(plainPassword, user.passwordHash)
    : null;

  return { email, ...user, plainPassword, created, passwordWorks, setsPassword };
}

// -----------------------------------------------------------------------------
// Run
// -----------------------------------------------------------------------------
console.log("\n=== GENHUB launch accounts ===\n");
console.log(`  Database: ${(process.env.DATABASE_URL || "").replace(/:[^:@]*@/, ":***@")}`);
console.log("");

const results = [];
try {
  if (adminEmail) {
    results.push({
      label: samePerson ? "admin + creator" : "admin",
      ...(await ensureAccount({
        email: adminEmail,
        role: "ADMIN",
        name: samePerson ? displayName : undefined,
        needsBalance: samePerson,
        willUpload: samePerson,
        attachPhone: samePerson,
      })),
    });
  }

  if (creatorEmail && !samePerson) {
    results.push({
      label: "creator",
      ...(await ensureAccount({
        email: creatorEmail,
        role: "CREATOR",
        name: displayName,
        needsBalance: true,
        willUpload: true,
        attachPhone: true,
      })),
    });
  } else if (creatorEmail && samePerson) {
    // One address, both jobs. The role column holds one value, and ADMIN already
    // satisfies every creator route, so the account stays ADMIN and keeps the
    // balance row that uploads and payouts read.
    ok(
      `${creatorEmail} holds both roles: ADMIN already passes requireRole("CREATOR"), ` +
        `and it has a creator balance row`
    );
  }

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------
  if (samePerson) {
    console.log(
      "\n  Both jobs are on one account. Nothing in the app prevents this — an ADMIN\n" +
        "  passes every creator check — so you can upload and moderate from one sign-in.\n" +
        "  Give the creator side its own account later if you want the payout trail to\n" +
        "  belong to someone who is not also the reviewer.\n"
    );
  }

  for (const result of results) {
    console.log(`  ${result.label.toUpperCase()}`);
    console.log(`      email        ${result.email} ${result.created ? "(new)" : "(existing)"}`);
    console.log(`      user id      ${result.id}`);
    console.log(`      role         ${result.role}`);
    console.log(`      kyc          ${result.kycStatus}`);
    console.log(`      referral     ${result.referralCode ?? "—"}`);
    // Only a password this run applied is known to us. For an account left
    // alone, printing one would be a lie.
    if (result.setsPassword) console.log(`      password     ${result.plainPassword}`);
    console.log(
      `      can sign in  ${
        result.passwordWorks === true
          ? "yes — hash verified"
          : result.passwordWorks === false
            ? "NO — hash did not accept the password"
            : "unchanged — password was not set by this run"
      }`
    );
    console.log("");
  }

  if (results.some((r) => r.passwordWorks === false)) {
    fail("a password hash did not verify — do not hand that account out");
    process.exitCode = 1;
  }

  console.log("  Next:\n");
  const anyPassword = results.some((r) => r.setsPassword);
  if (anyPassword) {
    console.log("      1. Sign in at /login and change the password above immediately.");
  } else {
    console.log("      1. Sign in at /login. Passwords were left untouched — add");
    console.log("         --password <secret> to reset one.");
  }
  const creator = results.find((r) => r.label.includes("creator"));
  if (creator && creator.kycStatus !== "APPROVED") {
    console.log("      2. The creator cannot upload yet. Either:");
    console.log("           - submit at /creator/kyc, then approve it in Admin → KYC (a real");
    console.log("             review, with a KycVerification record), or");
    console.log("           - re-run this script with --kyc-approved, which sets the flag");
    console.log("             directly and creates no review record at all.");
  } else if (creator) {
    console.log("      2. Uploads are unblocked. --kyc-approved creates no KycVerification");
    console.log("         row, so Admin → KYC will not show this account as reviewed.");
  }
  console.log("      3. The role lives in the JWT: if you promoted an existing account,");
  console.log("         sign out and back in before the new role takes effect.\n");
} catch (error) {
  fail(error.message || String(error));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
