// =============================================================================
// GENHUB - Demo Seed Endpoint
// POST /api/demo/seed - Populates a fresh database with demo creators/videos,
// plus realistic engagement data (comments, transactions, watch history,
// subscriptions, notifications) so every screen has live content.
// Disabled in production. Idempotent: skips existing demo records.
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { api } from "@/lib/api-response";
import { DEMO_CREATORS, DEMO_VIDEOS } from "@/lib/demo-data";

const VIEWER_ID = "demo-viewer-1";
const VIEWER_2_ID = "demo-creator-1"; // used as a second viewer for watch history
const ADMIN_ID = "demo-admin-1";

const daysAgo = (d: number, hour = 12) => {
  const date = new Date();
  date.setDate(date.getDate() - d);
  date.setHours(hour, Math.floor(Math.random() * 59), 0, 0);
  return date;
};

export async function POST(request: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return api.error("Demo seeding is disabled in production", 403, "FORBIDDEN");
  }

  try {
    let created = { creators: 0, viewers: 0, videos: 0, comments: 0, transactions: 0, progress: 0, gallery: 0, misc: 0 };
    // Reported separately from `created`: these are pre-existing rows the seed
    // had to repair, so "0 created, 2 corrected" is readable instead of silence.
    const corrected = { viewers: 0, admins: 0 };

    // ---------------------------------------------------------------- Creators
    for (const creator of DEMO_CREATORS) {
      const existing = await prisma.user.findUnique({ where: { id: creator.id } });
      if (!existing) {
        await prisma.user.create({
          data: {
            id: creator.id,
            email: `${creator.id}@demo.genhub.local`,
            passwordHash: "$2b$10$demodemodemodemodemo0000000000000000000000000000000",
            displayName: creator.displayName,
            role: "CREATOR",
            kycStatus: "APPROVED",
            isVerified: creator.isVerified,
            walletBalance: 0,
          },
        });
        created.creators++;
      }
    }

    // ------------------------------------------------------------------ Viewers
    // These two accounts have FIXED identities: demo-login signs in by id and the
    // role decides what the person testing sees. So the seed has to converge an
    // existing row back to its intended role, not merely create it when absent.
    // A stale row from an earlier seed is the exact way this goes wrong: the
    // viewer account was left as CREATOR, and then "testing the paywall as a
    // viewer" silently tested it as a creator — the one path that decides whether
    // real money works — until someone happened to query the table.
    const viewer = await prisma.user.findUnique({ where: { id: VIEWER_ID } });
    if (!viewer) {
      await prisma.user.create({
        data: {
          id: VIEWER_ID,
          email: "viewer@demo.genhub.local",
          passwordHash: "$2b$10$demodemodemodemodemo0000000000000000000000000000000",
          displayName: "Baraka M.",
          role: "VIEWER",
          walletBalance: 250000,
        },
      });
      created.viewers++;
    } else if (viewer.role !== "VIEWER") {
      // Keep the wallet: its balance is what makes the purchase flow testable.
      await prisma.user.update({ where: { id: VIEWER_ID }, data: { role: "VIEWER" } });
      corrected.viewers++;
    }

    // ---------------------------------------------------------------------- Admin
    const admin = await prisma.user.findUnique({ where: { id: ADMIN_ID } });
    if (!admin) {
      await prisma.user.create({
        data: {
          id: ADMIN_ID,
          email: "admin@demo.genhub.local",
          passwordHash: "$2b$10$demodemodemodemodemo0000000000000000000000000000000",
          displayName: "Genhub Admin",
          role: "ADMIN",
          kycStatus: "APPROVED",
          isVerified: true,
          walletBalance: 0,
        },
      });
      created.viewers++;
    } else if (admin.role !== "ADMIN") {
      // An admin that lost its role is a locked door with no key: nobody else can
      // reach the moderation and payouts screens that fix it.
      await prisma.user.update({ where: { id: ADMIN_ID }, data: { role: "ADMIN" } });
      corrected.admins++;
    }

    // ------------------------------------------------------------------- Videos
    for (const video of DEMO_VIDEOS) {
      const existing = await prisma.video.findUnique({ where: { id: video.id } });
      if (!existing) {
        await prisma.video.create({
          data: {
            id: video.id,
            slug: video.slug,
            title: video.title,
            description: video.description,
            bunnyVideoId: `demo-${video.id}`,
            previewUrl: video.teaserUrl, // the FULL scene (historical field name)
            // A different, shorter clip for non-buyers — see demo-data.ts.
            teaserClipUrl: video.teaserClipUrl ?? null,
            thumbnailUrl: video.thumbnailUrl,
            price: video.price,
            teaserDuration: video.teaserDuration,
            duration: video.duration,
            viewsCount: video.viewsCount,
            likesCount: video.likesCount,
            dislikesCount: video.dislikesCount || 1,
            purchaseCount: video.purchaseCount,
            category: video.category,
            isPremium: video.isPremium,
            isFeatured: video.isFeatured,
            tags: video.tags,
            isPublished: true,
            creatorId: video.creator.id,
            createdAt: new Date(video.createdAt),
          },
        });
        created.videos++;
      } else {
        // Keep publish dates in sync so date filters / trending recency are realistic
        const wanted = new Date(video.createdAt);
        const patch: { createdAt?: Date; teaserClipUrl?: string | null } = {};
        if (existing.createdAt.getTime() !== wanted.getTime()) {
          patch.createdAt = wanted;
        }

        // Keep the trailer in step too. Rows seeded before the teaser feature
        // existed have none, so without this every demo scene would keep
        // showing "no preview" — and a stale trailer left pointing at the scene
        // would hand the full video to non-buyers.
        const teaser = video.teaserClipUrl ?? null;
        if (teaser && teaser !== existing.previewUrl && existing.teaserClipUrl !== teaser) {
          patch.teaserClipUrl = teaser;
        }

        if (Object.keys(patch).length > 0) {
          await prisma.video.update({ where: { id: video.id }, data: patch });
        }
      }
    }

    // ------------------------------------------------------- Scene photo galleries
    // Every scene gets a small still set (Brazzers-style gallery under the
    // player). Deterministic seeds keep the demo looking coherent on re-seed.
    for (const video of DEMO_VIDEOS) {
      const existing = await prisma.galleryImage.count({ where: { videoId: video.id } });
      if (existing > 0) continue;

      const seed = video.slug || video.id;
      await prisma.galleryImage.createMany({
        data: Array.from({ length: 4 }).map((_, i) => ({
          videoId: video.id,
          url: `https://picsum.photos/seed/${seed}-still-${i + 1}/1280/720`,
          position: i,
        })),
      });
      created.gallery += 4;
    }

    // -------------------------------------------------- Watch history (Continue Watching)
    const watchEntries = [
      { videoId: "demo-1", percent: 28, position: 87 },
      { videoId: "demo-2", percent: 62, position: 338 },
      { videoId: "demo-5", percent: 31, position: 223 },
      { videoId: "demo-6", percent: 17, position: 357 },
      { videoId: "demo-7", percent: 44, position: 3220 },
    ];
    for (const w of watchEntries) {
      const res = await prisma.watchProgress.upsert({
        where: { userId_videoId: { userId: VIEWER_2_ID, videoId: w.videoId } },
        create: {
          userId: VIEWER_2_ID,
          videoId: w.videoId,
          positionSeconds: w.position,
          percent: w.percent,
        },
        update: { positionSeconds: w.position, percent: w.percent },
      });
      if (res) created.progress++;
    }
    await prisma.watchProgress.upsert({
      where: { userId_videoId: { userId: VIEWER_ID, videoId: "demo-1" } },
      create: { userId: VIEWER_ID, videoId: "demo-1", positionSeconds: 140, percent: 45 },
      update: { positionSeconds: 140, percent: 45 },
    });

    // ------------------------------------------------------------------ Comments
    const comments = [
      {
        id: "demo-cmt-1",
        videoId: "demo-1",
        userId: VIEWER_ID,
        parentId: null,
        body: "The cinematography in this one is unreal 🔥 Worth every shilling!",
        created: daysAgo(2),
      },
      {
        id: "demo-cmt-2",
        videoId: "demo-1",
        userId: "demo-creator-1",
        parentId: "demo-cmt-1",
        body: "Thank you! Took us three nights to get the skyline shots 🎬",
        created: daysAgo(1),
      },
      {
        id: "demo-cmt-3",
        videoId: "demo-3",
        userId: VIEWER_ID,
        parentId: null,
        body: "The Kariakoo section had me hungry immediately. Please make more food docs!",
        created: daysAgo(5),
      },
    ];
    for (const c of comments) {
      const existing = await prisma.comment.findUnique({ where: { id: c.id } });
      if (!existing) {
        await prisma.comment.create({
          data: {
            id: c.id,
            videoId: c.videoId,
            userId: c.userId,
            parentId: c.parentId,
            body: c.body,
            createdAt: c.created,
          },
        });
        created.comments++;
      }
    }

    // --------------------------------------- Subscription + access + notifications
    const expires = new Date();
    expires.setDate(expires.getDate() + 30);

    // ------------------------------------------------------------ Promo coupons
    for (const coupon of [
      { id: "demo-coupon-1", code: "WELCOME10", type: "PERCENT", value: 10, maxUses: null as number | null },
      { id: "demo-coupon-2", code: "GENHUB500", type: "FIXED", value: 500, maxUses: 100 },
      {
        id: "demo-coupon-3",
        code: "TOPUP25",
        type: "PERCENT",
        value: 25,
        maxUses: 50,
      },
    ]) {
      if (!(await prisma.coupon.findUnique({ where: { code: coupon.code } }))) {
        await prisma.coupon.create({
          data: {
            id: coupon.id,
            code: coupon.code,
            type: coupon.type,
            value: coupon.value,
            maxUses: coupon.maxUses,
            expiresAt: new Date(Date.now() + 90 * 86400000),
          },
        });
        created.misc++;
      }
    }

    // --------------------------------------------------------- Creator timeline posts
    const posts = [
      {
        id: "demo-post-1",
        creatorId: "demo-creator-1",
        body: "New Midnight Sessions visual drops this Friday 🎬 Stay tuned — subscribers get it 24h early.",
        days: 1,
      },
      {
        id: "demo-post-2",
        creatorId: "demo-creator-2",
        body: "Live DJ set from Zanzibar this weekend! Full version drops here first 🎧🌊",
        days: 2,
      },
      {
        id: "demo-post-3",
        creatorId: "demo-creator-4",
        body: "Working on a free React course for East African devs — drop a 🔥 if you want early access.",
        days: 3,
      },
    ];
    for (const p of posts) {
      if (!(await prisma.creatorPost.findUnique({ where: { id: p.id } }))) {
        await prisma.creatorPost.create({
          data: { id: p.id, creatorId: p.creatorId, body: p.body, createdAt: daysAgo(p.days) },
        });
        created.misc++;
      }
    }

    // ------------------------------------------------------- Referral codes on demo users
    // Give each demo creator a distinct, shareable code
    for (let i = 0; i < DEMO_CREATORS.length; i++) {
      const code = `${DEMO_CREATORS[i].displayName.split(" ")[0].toUpperCase().slice(0, 5)}${i + 1}X`;
      await prisma.user
        .update({ where: { id: DEMO_CREATORS[i].id }, data: { referralCode: code } })
        .catch(() => undefined);
    }

    for (const sub of [
      { id: "demo-sub-1", viewerId: VIEWER_2_ID, creatorId: "demo-creator-2" },
      { id: "demo-sub-2", viewerId: VIEWER_ID, creatorId: "demo-creator-1" },
    ]) {
      if (
        !(await prisma.creatorSubscription.findUnique({
          where: { viewerId_creatorId: { viewerId: sub.viewerId, creatorId: sub.creatorId } },
        }))
      ) {
        await prisma.creatorSubscription.create({
          data: {
            id: sub.id,
            viewerId: sub.viewerId,
            creatorId: sub.creatorId,
            price: 5000,
            expiresAt: expires,
            isActive: true,
          },
        });
        created.misc++;
      }
    }

    if (
      !(await prisma.videoAccess.findUnique({
        where: { viewerId_videoId: { viewerId: VIEWER_2_ID, videoId: "demo-1" } },
      }))
    ) {
      await prisma.videoAccess.create({
        data: { id: "demo-acc-1", viewerId: VIEWER_2_ID, videoId: "demo-1" },
      });
      created.misc++;
    }

    for (const n of [
      {
        id: "demo-notif-1",
        title: "New sale! 💰",
        message: 'Baraka M. purchased "Midnight Sessions" — TZS 3,500 added to your balance.',
        isRead: false,
      },
      {
        id: "demo-notif-2",
        title: "New subscriber ⭐",
        message: "Kili Beats subscribed to your channel for TZS 5,000/month.",
        isRead: false,
      },
      {
        id: "demo-notif-3",
        title: "You are verified! 🎉",
        message: "Your account now displays the verified badge.",
        isRead: true,
      },
    ]) {
      if (!(await prisma.notification.findUnique({ where: { id: n.id } }))) {
        await prisma.notification.create({
          data: {
            id: n.id,
            userId: "demo-creator-1",
            title: n.title,
            message: n.message,
            type: "success",
            link: "/creator",
            isRead: n.isRead,
          },
        });
        created.misc++;
      }
    }

    // ------------------------------------------------------- Creator balance
    await prisma.creatorBalance.upsert({
      where: { creatorId: "demo-creator-1" },
      create: {
        creatorId: "demo-creator-1",
        pendingBalance: 184000,
        availableBalance: 426000,
        totalEarned: 610000,
      },
      update: {
        pendingBalance: 184000,
        availableBalance: 426000,
        totalEarned: 610000,
      },
    });

    // -------------------------------------------- Transactions (30-day revenue)
    // [daysAgo, type, amount, videoId]
    const txPlan: [number, "PPV_PURCHASE" | "SUBSCRIPTION" | "TIP", number, string | null][] = [
      [28, "PPV_PURCHASE", 5000, "demo-1"],
      [26, "SUBSCRIPTION", 5000, null],
      [24, "TIP", 2000, null],
      [21, "PPV_PURCHASE", 12000, "demo-4"],
      [19, "PPV_PURCHASE", 3000, "demo-3"],
      [16, "SUBSCRIPTION", 5000, null],
      [14, "PPV_PURCHASE", 5000, "demo-1"],
      [12, "TIP", 10000, null],
      [10, "PPV_PURCHASE", 8000, "demo-6"],
      [8, "PPV_PURCHASE", 4000, "demo-7"],
      [6, "SUBSCRIPTION", 5000, null],
      [4, "PPV_PURCHASE", 5000, "demo-1"],
      [2, "TIP", 5000, null],
      [1, "PPV_PURCHASE", 12000, "demo-4"],
    ];

    for (let i = 0; i < txPlan.length; i++) {
      const [ago, type, amount, videoId] = txPlan[i];
      const id = `demo-tx-${String(i + 1).padStart(2, "0")}`;
      if (await prisma.transaction.findUnique({ where: { id } })) continue;
      const platformFee = Math.round(amount * 0.3);
      await prisma.transaction.create({
        data: {
          id,
          userId: VIEWER_ID,
          creatorId: "demo-creator-1",
          videoId,
          amount,
          platformFee,
          creatorCut: amount - platformFee,
          type,
          status: "SUCCESS",
          createdAt: daysAgo(ago, 10 + (i % 12)),
        },
      });
      created.transactions++;
    }

    // ---------------------------- One charge nobody can classify yet
    // Without this, the admin reconciliation view (Admin → Payments → Being
    // checked) is empty until a real customer's payment goes wrong, so nobody
    // can see or practise the flow. This is the honest shape of the state: a
    // USSD prompt HarakaPay accepted and never settled, so the customer may
    // already have paid. It is deliberately NOT a failure — see the migration
    // comment on UNDER_INVESTIGATION.
    const stuckId = "demo-tx-investigation";
    if (!(await prisma.transaction.findUnique({ where: { id: stuckId } }))) {
      await prisma.transaction.create({
        data: {
          id: stuckId,
          userId: VIEWER_ID,
          creatorId: "demo-creator-3",
          videoId: "demo-13",
          amount: 1000,
          type: "PPV_PURCHASE",
          status: "UNDER_INVESTIGATION",
          gateway: "HARAKAPAY",
          providerRef: "HP-DEMO-NEVER-SETTLED",
          metadata: {
            investigation: true,
            reason: "gateway_never_settled",
            gatewayStatus: "processing",
          },
          // Yesterday, not today: it must read as being in the past whatever
          // timezone the seeder runs in, and an investigation is only interesting
          // once it has been sitting there a while.
          createdAt: daysAgo(1, 14),
        },
      });
      created.transactions++;
    }

    return api.success({
      ...created,
      corrected,
      total:
        created.creators +
        created.viewers +
        created.videos +
        created.comments +
        created.transactions +
        created.progress +
        created.gallery +
        created.misc,
      message: "Demo data seeded successfully",
    });
  } catch (error) {
    console.error("[Demo Seed Error]", error);
    return api.internal();
  }
}
