#!/usr/bin/env node
// =============================================================================
// GENHUB - Admin bootstrap (production has no demo-login)
// Run:  node scripts/create-admin.mjs you@domain.com
//         -> promotes an existing account to ADMIN
//       node scripts/create-admin.mjs you@domain.com --create
//         -> creates the account with a random temp password (printed once)
//       node scripts/create-admin.mjs you@domain.com --demote
//         -> drops the account back to VIEWER
//
// NOTE: the JWT carries the role — the user must sign out/in after promotion.
// =============================================================================

import { randomBytes } from "node:crypto";
import { loadEnv, ok, fail } from "./_env.mjs";

loadEnv();

const argv = process.argv.slice(2);
const email = argv.find((a) => !a.startsWith("--"));
const create = argv.includes("--create");
const demote = argv.includes("--demote");

if (!email || !email.includes("@")) {
  console.log("\nusage: node scripts/create-admin.mjs <email> [--create | --demote]\n");
  process.exit(1);
}

const { PrismaClient } = await import("@prisma/client");
const bcrypt = (await import("bcryptjs")).default;
const prisma = new PrismaClient();

try {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, role: true },
  });

  if (demote) {
    if (!user) {
      fail(`no user with email ${email}`);
      process.exit(1);
    }
    await prisma.user.update({ where: { id: user.id }, data: { role: "VIEWER" } });
    ok(`demoted ${email}: ${user.role} -> VIEWER (sign out/in to apply)`);
    process.exit(0);
  }

  if (!user) {
    if (!create) {
      fail(`no user with email ${email} — sign up on the site first, or re-run with --create`);
      process.exit(1);
    }
    const tempPassword = randomBytes(9).toString("base64url");
    const passwordHash = await bcrypt.hash(tempPassword, 12);
    const created = await prisma.user.create({
      data: {
        email,
        passwordHash,
        displayName: "Administrator",
        role: "ADMIN",
        isVerified: true,
        referralCode: `AD${randomBytes(5).toString("hex").toUpperCase()}`,
      },
      select: { id: true },
    });
    ok(`created ADMIN account ${email} (${created.id})`);
    console.log(`   temp password: ${tempPassword}`);
    console.log("   change it immediately after your first sign-in.\n");
  } else if (user.role === "ADMIN") {
    ok(`${email} is already ADMIN`);
  } else {
    await prisma.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });
    ok(`promoted ${email}: ${user.role} -> ADMIN (sign out/in to apply)`);
  }
} catch (error) {
  fail(error.message || String(error));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
