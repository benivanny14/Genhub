#!/usr/bin/env node
// =============================================================================
// GENHUB - "Where is this payment?"  (READ-ONLY, moves no money)
//
//   node scripts/payment-lookup.mjs                 list every charge that has
//                                                   not settled, with who is
//                                                   affected and what is missing
//   node scripts/payment-lookup.mjs <orderId>       full detail for one order,
//   node scripts/payment-lookup.mjs <orderId> -g    and ask SonicPesa directly
//
// The question this exists for is the one that has no symptom inside the app: a
// customer paid, the gateway says SUCCESS, and our row still reads PENDING — so
// the creator was never credited and the video never unlocked. It answers from
// both sides at once, because "our row says PENDING" and "the gateway says
// SUCCESS" are exactly the pair that says a notification was lost.
//
// It never writes. A charge that settled at the gateway but not here is
// recovered by the reconcile job (`POST /api/cron/reconcile-payments`, or Admin
// → Background jobs → Run now), which routes through processPaymentWebhook and
// applies the same 70/30 split and access grant as any webhook.
//
//   <orderId> may be OUR transaction id or the gateway's `sp_...` providerRef.
// =============================================================================

import { loadEnv } from "./_env.mjs";
import { PrismaClient } from "@prisma/client";

loadEnv();
const prisma = new PrismaClient();

const orderId = process.argv[2];
const askGateway = process.argv.includes("-g") || process.argv.includes("--gateway");
const ts = (d) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 19) : "-");

/** Ask SonicPesa what it thinks happened to this order. Never throws. */
async function gatewayStatus(providerRef) {
  const baseUrl = process.env.SONICPESA_BASE_URL || "https://api.sonicpesa.com/api/v1";
  const accessKey = process.env.SONICPESA_ACCESS_KEY || "";
  if (!accessKey) return "SONICPESA_ACCESS_KEY is not set in .env.local";
  try {
    const res = await fetch(`${baseUrl}/payment/order_status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": accessKey },
      body: JSON.stringify({ order_id: providerRef }),
      cache: "no-store",
    });
    const body = await res.json().catch(() => ({}));
    const d = body?.data;
    if (!d) return `HTTP ${res.status} — ${body?.message || "no payment in the answer"}`;
    return (
      `${d.payment_status ?? d.status}  TZS ${d.amount}  channel=${d.channel ?? "-"}  ` +
      `transid=${d.transid ?? "-"}  phone=${d.phone ?? d.msisdn ?? "-"}  ` +
      `created=${d.created_at ?? "-"}`
    );
  } catch (error) {
    return `unreachable: ${error instanceof Error ? error.message : error}`;
  }
}

async function detail(tx) {
  const [user, creator, video, access, balance, earning, events] = await Promise.all([
    prisma.user.findUnique({ where: { id: tx.userId }, select: { username: true, email: true } }),
    tx.creatorId
      ? prisma.user.findUnique({ where: { id: tx.creatorId }, select: { username: true } })
      : null,
    tx.videoId
      ? prisma.video.findUnique({ where: { id: tx.videoId }, select: { title: true, price: true } })
      : null,
    tx.videoId
      ? prisma.videoAccess.findUnique({
          where: { viewerId_videoId: { viewerId: tx.userId, videoId: tx.videoId } },
          select: { expiresAt: true },
        })
      : null,
    tx.creatorId
      ? prisma.creatorBalance.findUnique({
          where: { creatorId: tx.creatorId },
          select: { pendingBalance: true, availableBalance: true, totalEarned: true },
        })
      : null,
    tx.videoId ? prisma.videoEarning.findUnique({ where: { videoId: tx.videoId } }) : null,
    prisma.paymentEvent.findMany({ where: { transactionId: tx.id }, orderBy: { createdAt: "asc" } }),
  ]);

  console.log(`order        ${tx.id}`);
  console.log(`status       ${tx.status}   gateway=${tx.gateway ?? "-"}   providerRef=${tx.providerRef ?? "-"}`);
  console.log(`type/amount  ${tx.type}  TZS ${tx.amount}   platformFee=${tx.platformFee ?? "-"}  creatorCut=${tx.creatorCut ?? "-"}`);
  console.log(`created      ${ts(tx.createdAt)}  (updated ${ts(tx.updatedAt)})`);
  console.log(`buyer        ${user?.username ?? tx.userId} <${user?.email || "-"}>`);
  console.log(`creator      ${creator?.username ?? tx.creatorId ?? "-"}`);
  console.log(`video        ${video ? `${video.title} (price ${video.price})` : tx.videoId ?? "-"}`);
  console.log("");
  console.log(`video unlocked   ${access ? `YES (expires=${access.expiresAt ?? "lifetime"})` : "NO"}`);
  console.log(
    `creator credited ${
      balance
        ? `pending=${balance.pendingBalance} available=${balance.availableBalance} totalEarned=${balance.totalEarned}`
        : "(no balance row)"
    }`
  );
  if (earning) console.log(`video earnings   totalEarned=${earning.totalEarned} purchases=${earning.totalPurchases}`);
  console.log("");
  console.log(`journey (${events.length}):`);
  for (const e of events) console.log(`  [${ts(e.createdAt)}] ${e.kind} — ${e.detail ?? ""}`);
}

try {
  if (orderId) {
    const tx = await prisma.transaction.findFirst({
      where: { OR: [{ id: orderId }, { providerRef: orderId }] },
    });
    if (!tx) {
      console.log(`No transaction for "${orderId}" (matches neither our id nor providerRef).`);
    } else {
      await detail(tx);
      if (tx.providerRef && askGateway) {
        console.log("");
        console.log(`gateway says     ${await gatewayStatus(tx.providerRef)}`);
      }
    }
  } else {
    const unsettled = await prisma.transaction.findMany({
      where: { status: { in: ["PENDING", "UNDER_INVESTIGATION"] } },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    console.log(`=== charges that have not settled (${unsettled.length}) ===`);
    if (unsettled.length === 0) console.log("(none — every gateway charge is final)");
    for (const tx of unsettled) {
      const [user, creator] = await Promise.all([
        prisma.user.findUnique({ where: { id: tx.userId }, select: { username: true } }),
        tx.creatorId
          ? prisma.user.findUnique({ where: { id: tx.creatorId }, select: { username: true } })
          : null,
      ]);
      const ageMin = Math.round((Date.now() - +tx.createdAt) / 60000);
      console.log(
        `\n${tx.id}\n  ${tx.status}  ${tx.type}  TZS ${tx.amount}  ${tx.gateway ?? "-"}  ${tx.providerRef ?? "-"}` +
          `\n  buyer=${user?.username ?? tx.userId}  creator=${creator?.username ?? "-"}  age=${ageMin} min`
      );
      if (askGateway && tx.providerRef) {
        console.log(`  gateway says: ${await gatewayStatus(tx.providerRef)}`);
      }
    }
    console.log(
      `\nTip: a charge the gateway has already SUCCESS is recovered by the reconcile job —` +
        `\n  POST /api/cron/reconcile-payments  (or Admin → Background jobs → Run now).`
    );
  }
} catch (error) {
  console.error("Lookup failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
