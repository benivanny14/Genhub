#!/usr/bin/env node
// =============================================================================
// GENHUB - Take the test content out before real users arrive
//
// Run:  node scripts/clean-launch.mjs                  -> report only (nothing is deleted)
//       node scripts/clean-launch.mjs --yes            -> delete the content, keep every account
//       node scripts/clean-launch.mjs --yes --accounts -> also delete every NON-admin account
//
// A site that launches with a handful of test uploads, test purchases and test
// comments is a site telling its first visitor something untrue: "4 videos",
// "1 creator", a 30-day revenue chart built from invented sales. `demo:wipe`
// removes the *seeded* rows; this removes everything that was only ever put
// there to try the machine out.
//
// What it keeps, always, and why:
//
//   * ADMIN accounts. They are the only way back in — the panel that approves
//     KYC, reads reports and clears payouts. A wipe that took them would lock
//     the operator out of the site they are cleaning.
//   * Coupons. Deleting a live promo code is a business decision, not cleanup,
//     so active ones are listed and left alone (same rule as demo:wipe).
//   * The operational tables — setup steps, worker heartbeats, the watchdog's
//     memory. They are the record of how the deployment is running, not content.
//
// `--accounts` is separate on purpose: it removes the accounts that owned the
// test content. A creator account is not "content", and deleting one is
// irreversible — so it takes a second, deliberate flag.
//
// It is a dry run unless you pass --yes: the first time anyone runs this it is
// on a database with real accounts in it.
// =============================================================================

import { loadEnv, ok, warn, fail } from "./_env.mjs";

loadEnv();

const argv = process.argv.slice(2);
const execute = argv.includes("--yes");
const withAccounts = argv.includes("--accounts");

const { PrismaClient } = await import("@prisma/client");
const prisma = new PrismaClient();

const pad = (n, width = 6) => String(n).padStart(width);

/**
 * Everything that exists because somebody was testing the product.
 *
 * Order matters: a row is deleted only after the rows that point at it, because
 * most of these relations declare no `onDelete: Cascade` (the schema refuses to
 * guess whether a purchase should survive its video). Deleting in this order
 * means no statement ever fails on a foreign key.
 */
const CONTENT = [
  ["gallery stills", "galleryImage"],
  ["likes / dislikes", "videoLike"],
  ["saved items", "favorite"],
  ["watch progress", "watchProgress"],
  ["comments", "comment"],
  ["purchased access", "videoAccess"],
  ["reports", "videoReport"],
  ["earning releases", "videoEarning"],
  ["playlist entries", "playlistItem"],
  ["transactions", "transaction"],
  ["paid messages", "payMessage"],
  ["coupon redemptions", "couponRedemption"],
  ["payout requests", "payoutRequest"],
  ["subscriptions", "creatorSubscription"],
  ["creator posts", "creatorPost"],
  ["blue-tick requests", "blueTickRequest"],
  ["strike records", "strikeLog"],
  ["notifications", "notification"],
  ["password resets", "passwordReset"],
  ["admin audit log", "adminAuditLog"],
  ["KYC submissions", "kycVerification"],
  ["creator profiles", "creatorProfile"],
  ["creator balances", "creatorBalance"],
  ["playlists", "playlist"],
  ["videos", "video"],
];

try {
  // ---------------------------------------------------------------------------
  // 1. What is actually in there
  // ---------------------------------------------------------------------------
  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      phone: true,
      displayName: true,
      role: true,
      kycStatus: true,
      _count: { select: { videos: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const admins = users.filter((u) => u.role === "ADMIN");
  const others = users.filter((u) => u.role !== "ADMIN");

  const counts = [];
  let contentRows = 0;
  for (const [label, model] of CONTENT) {
    const count = await prisma[model].count();
    counts.push([label, model, count]);
    contentRows += count;
  }

  console.log("\n=== GENHUB launch clean ===\n");
  console.log(`  Accounts       : ${users.length}  (${admins.length} admin, ${others.length} other)`);
  for (const u of users) {
    console.log(
      `      ${(u.role === "ADMIN" ? "KEEP " : "     ") + u.role.padEnd(8)} ` +
        `${(u.email || u.phone || "—").padEnd(34)} ` +
        `KYC ${u.kycStatus.padEnd(8)} videos ${u._count.videos}  ${u.displayName || ""}`
    );
  }
  console.log(`\n  Content rows   : ${contentRows}`);
  for (const [label, , count] of counts) {
    if (count === 0) continue;
    console.log(`      ${pad(count)}  ${label}`);
  }
  console.log("");

  const videos = await prisma.video.findMany({
    select: { title: true, isPublished: true, price: true, creator: { select: { displayName: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (videos.length > 0) {
    console.log(`  Videos that will be deleted (${videos.length}):`);
    for (const v of videos) {
      console.log(
        `      ${(v.isPublished ? "live " : "draft").padEnd(6)} ${v.title.slice(0, 52).padEnd(54)} ` +
          `TZS ${v.price}  ${v.creator.displayName || "—"}`
      );
    }
    console.log("");
  }

  if (contentRows === 0 && (!withAccounts || others.length === 0)) {
    ok("nothing to clean — the database holds no content rows");
    console.log("");
    process.exit(0);
  }

  // ---------------------------------------------------------------------------
  // 2. The dry run
  // ---------------------------------------------------------------------------
  if (!execute) {
    console.log("  Dry run — nothing will be deleted.\n");
    console.log(`      ${pad(contentRows)}  content row(s) in ${counts.filter(([, , c]) => c > 0).length} table(s)`);
    console.log(`      ${pad(admins.length)}  admin account(s) kept`);
    if (withAccounts) {
      console.log(`      ${pad(others.length)}  non-admin account(s) deleted`);
    } else {
      console.log("             (accounts are kept — pass --accounts to delete the non-admin ones)");
    }

    const activeCoupons = await prisma.coupon.count({ where: { isActive: true } });
    if (activeCoupons > 0) {
      console.log(`             (coupons are kept, not cleaned — ${activeCoupons} active; review them in Admin → Coupons)`);
    }
    console.log("\n  Re-run with --yes to delete.\n");
    process.exit(0);
  }

  // ---------------------------------------------------------------------------
  // 3. Delete, in one transaction
  // ---------------------------------------------------------------------------
  const done = await prisma.$transaction(
    async (tx) => {
      const removed = [];

      // A real record may name a user that is about to go — a referral, a report
      // resolved by an admin who is staying. Clear the reference first so a row
      // we mean to keep does not block the delete or vanish with it.
      if (withAccounts) {
        const { count } = await tx.user.updateMany({
          where: { referredById: { not: null } },
          data: { referredById: null },
        });
        if (count > 0) removed.push(["referral links (unlinked)", count]);
      }

      for (const [label, model] of CONTENT) {
        const { count } = await tx[model].deleteMany({});
        if (count > 0) removed.push([label, count]);
      }

      if (withAccounts) {
        const { count } = await tx.user.deleteMany({ where: { role: { not: "ADMIN" } } });
        if (count > 0) removed.push(["non-admin accounts", count]);
      }

      return removed;
    },
    { timeout: 120_000 }
  );

  console.log("  Deleted:\n");
  let total = 0;
  for (const [label, count] of done) {
    total += count;
    console.log(`      ${pad(count)}  ${label}`);
  }
  console.log(`\n      ${pad(total)}  rows in total\n`);

  // ---------------------------------------------------------------------------
  // 4. Prove it, rather than trusting the report
  // ---------------------------------------------------------------------------
  const leftovers = [];
  for (const [label, model] of CONTENT) {
    const count = await prisma[model].count();
    if (count > 0) leftovers.push([label, count]);
  }
  const remainingAdmins = await prisma.user.count({ where: { role: "ADMIN" } });
  const remainingOthers = await prisma.user.count({ where: { role: { not: "ADMIN" } } });

  if (leftovers.length > 0) {
    fail(`${leftovers.length} table(s) still hold rows: ${leftovers.map(([l, c]) => `${l} ${c}`).join(", ")}`);
    process.exitCode = 1;
  } else {
    ok("verified: no videos, purchases, comments or other content rows remain");
  }
  ok(`${remainingAdmins} admin account(s) kept; ${remainingOthers} non-admin account(s) left`);

  if (remainingAdmins === 0) {
    fail(
      "no ADMIN account exists — nobody can sign in to approve KYC or clear payouts. " +
        "Create one with:  npm run admin:create -- you@example.com"
    );
    process.exitCode = 1;
  }

  console.log(
    "\n  The site now starts from an empty shelf, which is the honest thing to show\n" +
      "  a first visitor. Creators upload through /creator/upload once their KYC is\n" +
      "  approved (Admin → KYC).\n"
  );
} catch (error) {
  fail(error.message || String(error));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
