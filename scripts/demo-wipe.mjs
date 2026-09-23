#!/usr/bin/env node
// =============================================================================
// GENHUB - Remove the demo content
//
// Run:  node scripts/demo-wipe.mjs            -> report only (nothing is deleted)
//       node scripts/demo-wipe.mjs --yes      -> delete
//       node scripts/demo-wipe.mjs --yes --force
//                                              -> delete even if real accounts
//                                                 are attached to demo content
//
// POST /api/demo/seed exists so every screen has something to show in
// development, and it refuses to run under NODE_ENV=production. The rows it
// already wrote do not disappear on their own, though: a launch with 24 fake
// scenes and 5 invented creators is a site that lies to its first visitor about
// how much content there is.
//
// Three things make this harder than `delete from "Video" where id like 'demo-%'`:
//
// 1. Transaction, PayoutRequest, PayMessage and VideoReport declare no
//    `onDelete: Cascade`. The database will refuse to delete a user or a video
//    that still has one, which fails the wipe halfway through.
//
// 2. Three columns point at a User *optionally* — VideoReport.resolvedBy,
//    PayoutRequest.processedBy and User.referredById. A real record may name a
//    demo admin as the one who reviewed it. That record is real and must
//    survive; only the reference to the fake account is cleared.
//
// 3. Real people may already have interacted with demo content if the site was
//    reachable first: a purchase, a subscription, a comment. Deleting their row
//    silently would be the worst outcome here, so the wipe stops and shows you
//    what it found instead, and needs --force to proceed anyway.
//
// It is a dry run unless you pass --yes, on purpose: the first time anyone runs
// this it is on a database with real users in it.
// =============================================================================

import { loadEnv, ok, warn, fail } from "./_env.mjs";
import { isDemoId, isDemoEmail } from "./_demo-identity.mjs";

loadEnv();

const argv = process.argv.slice(2);
const execute = argv.includes("--yes");
const force = argv.includes("--force");

const { PrismaClient } = await import("@prisma/client");
const prisma = new PrismaClient();

const pad = (n, width = 6) => String(n).padStart(width);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

try {
  // ---------------------------------------------------------------------------
  // 1. Identify the demo content
  // ---------------------------------------------------------------------------
  const allUsers = await prisma.user.findMany({
    select: { id: true, email: true, displayName: true, role: true },
  });
  const demoUsers = allUsers.filter((u) => isDemoId(u.id) || isDemoEmail(u.email));
  const demoUserIds = demoUsers.map((u) => u.id);

  const allVideos = await prisma.video.findMany({
    select: { id: true, title: true, creatorId: true },
  });
  // By id, and by owner: a video a demo creator somehow owns is demo content
  // whatever its id looks like. Relying on the id alone would leave it live
  // with an owner that is about to be deleted.
  const demoVideos = allVideos.filter(
    (v) => isDemoId(v.id) || demoUserIds.includes(v.creatorId)
  );
  const demoVideoIds = demoVideos.map((v) => v.id);

  const demoCoupons = (
    await prisma.coupon.findMany({ select: { id: true, code: true } })
  ).filter((c) => isDemoId(c.id));
  const demoCouponIds = demoCoupons.map((c) => c.id);

  // Shorthands for the two id sets, used by every check and every delete below.
  const anyVideo = { in: demoVideoIds };
  const anyUser = { in: demoUserIds };
  /** Owned by a demo account, or hanging off a demo video. */
  const videoOrUser = { OR: [{ videoId: anyVideo }, { userId: anyUser }] };

  const remainingUsers = allUsers.length - demoUsers.length;
  const remainingVideos = allVideos.length - demoVideos.length;

  console.log("\n=== GENHUB demo wipe ===\n");
  if (demoUsers.length === 0 && demoVideos.length === 0 && demoCouponIds.length === 0) {
    ok("no demo content found — nothing to do");
    console.log("");
    process.exit(0);
  }

  console.log(`  Demo accounts  : ${demoUsers.length}`);
  for (const u of demoUsers) {
    console.log(`      ${u.id.padEnd(20)} ${(u.email || "—").padEnd(34)} ${u.role}`);
  }
  console.log(`  Demo videos    : ${demoVideos.length}`);
  console.log(`  Demo coupons   : ${demoCouponIds.length}`);
  console.log("");
  console.log(`  Will be left in place:`);
  console.log(`      ${plural(remainingUsers, "real account", "real accounts")} (${remainingUsers})`);
  console.log(`      ${plural(remainingVideos, "real video", "real videos")} (${remainingVideos})`);
  console.log("");

  if (remainingUsers === 0 && remainingVideos === 0) {
    warn(
      `Every account in this database is demo content. After the wipe the site has ` +
        `no way to sign in — create the first real accounts with:\n` +
        `        npm run accounts:create -- --admin you@example.com --creator you@example.com`
    );
    console.log("");
  }

  // ---------------------------------------------------------------------------
  // 2. Stop if a real account is attached to demo content
  // ---------------------------------------------------------------------------
  // Money and engagement first, because those are the rows a person would be
  // angry to lose. Each check counts rows owned by a NON-demo user that point at
  // demo content.
  const blockingChecks = [
    ["purchases / tips / payouts recorded against demo content", () =>
      prisma.transaction.count({
        where: {
          userId: { notIn: demoUserIds },
          OR: [{ videoId: { in: demoVideoIds } }, { creatorId: { in: demoUserIds } }],
        },
      })],
    ["permanent access a real customer bought", () =>
      prisma.videoAccess.count({
        where: { videoId: { in: demoVideoIds }, viewerId: { notIn: demoUserIds } },
      })],
    ["subscriptions a real fan is paying for", () =>
      prisma.creatorSubscription.count({
        where: { creatorId: { in: demoUserIds }, viewerId: { notIn: demoUserIds } },
      })],
    ["comments written by real people on demo videos", () =>
      prisma.comment.count({
        where: { videoId: { in: demoVideoIds }, userId: { notIn: demoUserIds } },
      })],
    ["likes or dislikes from real accounts", () =>
      prisma.videoLike.count({
        where: { videoId: { in: demoVideoIds }, userId: { notIn: demoUserIds } },
      })],
    ["saved items in a real person's list", () =>
      prisma.favorite.count({
        where: { videoId: { in: demoVideoIds }, userId: { notIn: demoUserIds } },
      })],
    ["watch progress belonging to a real account", () =>
      prisma.watchProgress.count({
        where: { videoId: { in: demoVideoIds }, userId: { notIn: demoUserIds } },
      })],
    ["a real person's playlist containing a demo video", () =>
      prisma.playlistItem.count({
        where: { videoId: { in: demoVideoIds }, playlist: { userId: { notIn: demoUserIds } } },
      })],
    ["reports a real person filed against demo videos", () =>
      prisma.videoReport.count({
        where: { videoId: { in: demoVideoIds }, reporterId: { notIn: demoUserIds } },
      })],
    // "One side is demo and the other is not" needs both halves to be ORs. An
    // OR at the top level with a single AND underneath reads as "a demo side AND
    // no demo side", which is a contradiction — the check would sit at zero
    // forever and the wipe would take a real person's paid message without
    // asking.
    ["paid messages between a real account and a demo creator", () =>
      prisma.payMessage.count({
        where: {
          AND: [
            { OR: [{ senderId: anyUser }, { receiverId: anyUser }] },
            {
              OR: [
                { senderId: { notIn: demoUserIds } },
                { receiverId: { notIn: demoUserIds } },
              ],
            },
          ],
        },
      })],
  ];

  const blockers = [];
  for (const [label, run] of blockingChecks) {
    const count = await run();
    if (count > 0) blockers.push([label, count]);
  }

  if (blockers.length > 0 && !force) {
    console.log("  STOPPED — real people are attached to demo content:\n");
    for (const [label, count] of blockers) {
      console.log(`      ${pad(count)}  ${label}`);
    }
    console.log(
      "\n  Deleting demo content now would take those rows with it: a paid purchase\n" +
        "  would lose its video, a subscriber would be unsubscribed, a comment would\n" +
        "  vanish. Nothing has been deleted.\n\n" +
        "  Your options:\n" +
        "    1. Leave the demo content in place until those interactions are settled.\n" +
        "    2. Re-run with --force to delete it anyway, and refund by hand.\n"
    );
    process.exitCode = 1;
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // 3. The plan, in dependency order (see WIPE_ORDER in _demo-identity.mjs)
  // ---------------------------------------------------------------------------
  const plan = [
    ["gallery stills", "galleryImage", () => ({ videoId: anyVideo })],
    ["likes / dislikes", "videoLike", () => videoOrUser],
    ["saved items", "favorite", () => videoOrUser],
    ["watch progress", "watchProgress", () => videoOrUser],
    ["comments", "comment", () => videoOrUser],
    ["purchased access", "videoAccess", () => ({ OR: [{ videoId: anyVideo }, { viewerId: anyUser }] })],
    ["reports", "videoReport", () => ({ OR: [{ videoId: anyVideo }, { reporterId: anyUser }] })],
    ["release records", "videoEarning", () => ({ videoId: anyVideo })],
    ["playlist entries", "playlistItem", () => ({
      OR: [{ videoId: anyVideo }, { playlist: { userId: anyUser } }],
    })],
    ["transactions", "transaction", () => ({
      OR: [{ userId: anyUser }, { creatorId: anyUser }, { videoId: anyVideo }],
    })],
    ["paid messages", "payMessage", () => ({ OR: [{ senderId: anyUser }, { receiverId: anyUser }] })],
    ["payout requests", "payoutRequest", () => ({ creatorId: anyUser })],
    ["subscriptions", "creatorSubscription", () => ({ OR: [{ viewerId: anyUser }, { creatorId: anyUser }] })],
    ["creator posts", "creatorPost", () => ({ creatorId: anyUser })],
    ["notifications", "notification", () => ({ userId: anyUser })],
    ["password resets", "passwordReset", () => ({ userId: anyUser })],
    ["KYC submissions", "kycVerification", () => ({ userId: anyUser })],
    ["creator profiles", "creatorProfile", () => ({ userId: anyUser })],
    ["creator balances", "creatorBalance", () => ({ creatorId: anyUser })],
    ["playlists", "playlist", () => ({ userId: anyUser })],
    ["demo coupons", "coupon", () => ({ id: { in: demoCouponIds } })],
    ["videos", "video", () => ({ id: anyVideo })],
    ["accounts", "user", () => ({ id: anyUser })],
  ];

  // Real records that merely *name* a demo account. They must survive with the
  // reference cleared, or the wipe fails on a foreign key.
  const unlinks = [
    ["reports resolved by a demo admin", "videoReport", "resolvedBy"],
    ["payouts processed by a demo admin", "payoutRequest", "processedBy"],
    ["accounts referred by a demo creator", "user", "referredById"],
  ];

  // ---------------------------------------------------------------------------
  // 4. Report, or delete
  // ---------------------------------------------------------------------------
  if (!execute) {
    console.log("  Dry run — nothing will be deleted. What a wipe would remove:\n");
    let total = 0;
    for (const [label, table, where] of plan) {
      const count = await prisma[table].count({ where: where() });
      if (count === 0) continue;
      total += count;
      console.log(`      ${pad(count)}  ${label}`);
    }
    console.log(`\n      ${pad(total)}  rows in total`);
    for (const [label, table, column] of unlinks) {
      const count = await prisma[table].count({ where: { [column]: anyUser } });
      if (count === 0) continue;
      console.log(`             (and ${plural(count, label, label)} would keep the record, losing only the reference)`);
    }
    console.log("\n  Re-run with --yes to delete.\n");
    process.exit(0);
  }

  const done = await prisma.$transaction(
    async (tx) => {
      const counts = [];

      // Clear the references first: they are the rows that would block the
      // deletes below, and clearing them keeps real records real.
      for (const [label, table, column] of unlinks) {
        const { count } = await tx[table].updateMany({
          where: { [column]: anyUser },
          data: { [column]: null },
        });
        if (count > 0) counts.push([`${label} (unlinked)`, count]);
      }

      for (const [label, table, where] of plan) {
        const { count } = await tx[table].deleteMany({ where: where() });
        if (count > 0) counts.push([label, count]);
      }
      return counts;
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
  // 5. Prove it, rather than trusting the report
  // ---------------------------------------------------------------------------
  const leftoverUsers = (
    await prisma.user.findMany({ select: { id: true, email: true } })
  ).filter((u) => isDemoId(u.id) || isDemoEmail(u.email));
  const leftoverVideos = (await prisma.video.findMany({ select: { id: true } })).filter((v) =>
    isDemoId(v.id)
  );
  const leftoverCoupons = (await prisma.coupon.findMany({ select: { id: true } })).filter((c) =>
    isDemoId(c.id)
  );

  const left = leftoverUsers.length + leftoverVideos.length + leftoverCoupons.length;
  if (left > 0) {
    fail(
      `${left} demo row(s) survived the wipe — ` +
        `${leftoverUsers.length} account(s), ${leftoverVideos.length} video(s), ${leftoverCoupons.length} coupon(s)`
    );
    process.exitCode = 1;
  } else {
    ok("verified: no demo accounts, videos or coupons remain");
  }

  // Promo codes are a business decision, not cleanup — so list what is still
  // live instead of choosing for you.
  const liveCoupons = await prisma.coupon.findMany({
    select: { code: true, type: true, value: true, isActive: true },
  });
  const activeCoupons = liveCoupons.filter((c) => c.isActive);
  if (activeCoupons.length > 0) {
    console.log("\n  Coupons still active on the site:\n");
    for (const c of activeCoupons) {
      const worth = c.type === "PERCENT" ? `${c.value}%` : `TZS ${c.value}`;
      console.log(`      ${c.code.padEnd(16)} ${worth}`);
    }
    console.log("\n  Deactivate anything you did not mean to launch with (Admin → Coupons).\n");
  }

  console.log(
    `  The seed re-creates everything here if \`POST /api/demo/seed\` is run again,\n` +
      `  so treat it as development-only from now on.\n`
  );
} catch (error) {
  fail(error.message || String(error));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
