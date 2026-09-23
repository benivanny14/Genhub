#!/usr/bin/env node
// =============================================================================
// GENHUB - Balance audit: the money invariants that must never be violated
// Run:  node scripts/audit-balances.mjs   (or: npm run audit:balances)
//
// A lost update does not raise an error. `decrement` is relative, so an
// overdraw succeeds silently and the only symptom is a number that should not
// exist: a negative balance, or a creator holding more than they ever earned.
// That is why this runs against the real database instead of trusting the code.
//
// What it checks:
//   1. No wallet is negative (a customer cannot hold less than nothing).
//   2. No creator bucket is negative (pending, available, lifetime).
//   3. No creator holds more than they have earned in total — the signature of
//      a credit that was overwritten rather than added.
//
// Exits 1 on any violation, so it can run as a deploy gate or a cron.
// =============================================================================

import { loadEnv } from "./_env.mjs";
import { PrismaClient } from "@prisma/client";

loadEnv();

const prisma = new PrismaClient();
const failures = [];

function report(label, count, sample) {
  const ok = count === 0;
  console.log(`${ok ? "✓" : "✗"} ${label.padEnd(52)} ${count}`);
  if (!ok) {
    failures.push(label);
    for (const row of sample) console.log(`    ${JSON.stringify(row)}`);
  }
}

try {
  const [
    negativeWallets,
    negativePending,
    negativeAvailable,
    negativeEarned,
    earnedBelowHeld,
  ] = await Promise.all([
    prisma.user.findMany({
      where: { walletBalance: { lt: 0 } },
      select: { id: true, walletBalance: true },
      take: 10,
    }),
    prisma.creatorBalance.findMany({
      where: { pendingBalance: { lt: 0 } },
      select: { creatorId: true, pendingBalance: true },
      take: 10,
    }),
    prisma.creatorBalance.findMany({
      where: { availableBalance: { lt: 0 } },
      select: { creatorId: true, availableBalance: true },
      take: 10,
    }),
    prisma.creatorBalance.findMany({
      where: { totalEarned: { lt: 0 } },
      select: { creatorId: true, totalEarned: true },
      take: 10,
    }),
    // Held money above lifetime earnings: a credit that replaced instead of
    // adding (a lost update), or a clawback that took more than it should.
    prisma.$queryRaw`
      SELECT "creatorId", "pendingBalance", "availableBalance", "totalEarned"
      FROM "CreatorBalance"
      WHERE "pendingBalance" + "availableBalance" > "totalEarned"
      LIMIT 10
    `,
  ]);

  console.log("=== GENHUB BALANCE AUDIT ===");
  console.log("");

  report("wallets below zero", negativeWallets.length, negativeWallets);
  report("creator pending below zero", negativePending.length, negativePending);
  report("creator available below zero", negativeAvailable.length, negativeAvailable);
  report("creator lifetime earnings below zero", negativeEarned.length, negativeEarned);
  report(
    "held (pending + available) above lifetime earnings",
    Array.isArray(earnedBelowHeld) ? earnedBelowHeld.length : 0,
    Array.isArray(earnedBelowHeld) ? earnedBelowHeld : []
  );

  console.log("");
  if (failures.length === 0) {
    console.log("No violations. Every balance is a balance that could exist.");
    process.exitCode = 0;
  } else {
    console.log(
      `${failures.length} violation(s). A negative balance means something spent ` +
        `money that was not there; check the holders above and the transactions that ` +
        `touched them (Wallet / CreatorBalance writes are guarded in ` +
        `lib/services/balance.service.ts).`
    );
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Balance audit could not run: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
