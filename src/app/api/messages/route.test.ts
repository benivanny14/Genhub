// =============================================================================
// GENHUB - Who pays for a message
//
// Three rules, and they are separate:
//
//   1. A viewer can only write to a CREATOR they are subscribed to. The
//      subscription is the door.
//   2. Once inside, the viewer still pays — one fixed price per message
//      (PAID_MESSAGE_PRICE). A subscription does not make a message cheaper, and
//      a viewer never gets a free message.
//   3. A CREATOR (or an admin) ANSWERING a fan who wrote first pays nothing at
//      all. The exemption is the thread, not the role: a creator writing to
//      someone who never wrote to them is making first contact, and pays.
//
// The route used to ask three questions before naming a price — does the sender
// subscribe, does the receiver subscribe, did the receiver write first — and a
// yes on any of them made the message free. It then took the amount from the
// request, so "100 per message" was a rule only the composer followed. The door
// is the subscription now and the price is a server-side constant — but the
// free-reply rule is what these tests pin hardest, because a role-only check
// let any viewer who tapped "Become a creator" write to every creator for
// nothing.
//
// Prisma, auth and the wallet service are mocked; no database, no money.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  checkRateLimit: vi.fn(),
  debitWallet: vi.fn(),
  findUser: vi.fn(),
  updateUser: vi.fn(),
  // The subscription gate: a viewer may only write to a creator they follow.
  findSubscription: vi.fn(),
  // Read only to decide whether a creator is ANSWERING a fan — the one free
  // case. A viewer's send never consults it (the rule short-circuits on role).
  findMessage: vi.fn(),
  createMessage: vi.fn(),
  upsertBalance: vi.fn(),
  createTransaction: vi.fn(),
  createNotification: vi.fn(),
  // Read side: the thread, the inbox, and the badge's bare count.
  findMany: vi.fn(),
  updateMany: vi.fn(),
  count: vi.fn(),
  // The daily spend cap, which is exercised on its own in
  // src/tests/spend-cap.test.ts. Here it is a switch, so a send test can prove
  // that a refused cap stops the charge before any money moves.
  checkSpendCap: vi.fn(),
}));

// The transaction client shares the mock functions, so an assertion does not
// care whether a write happened inside or outside the transaction.
const tx = {
  payMessage: { create: (...a: unknown[]) => mocks.createMessage(...a) },
  creatorBalance: { upsert: (...a: unknown[]) => mocks.upsertBalance(...a) },
  transaction: { create: (...a: unknown[]) => mocks.createTransaction(...a) },
  notification: { create: (...a: unknown[]) => mocks.createNotification(...a) },
  user: { update: (...a: unknown[]) => mocks.updateUser(...a) },
};

vi.mock("@/lib/db", () => ({
  default: {
    user: { findUnique: (...a: unknown[]) => mocks.findUser(...a) },
    creatorSubscription: { findFirst: (...a: unknown[]) => mocks.findSubscription(...a) },
    payMessage: {
      findFirst: (...a: unknown[]) => mocks.findMessage(...a),
      findMany: (...a: unknown[]) => mocks.findMany(...a),
      updateMany: (...a: unknown[]) => mocks.updateMany(...a),
      count: (...a: unknown[]) => mocks.count(...a),
    },
    $transaction: (fn: (client: unknown) => unknown) => fn(tx),
  },
}));

vi.mock("@/lib/auth", () => ({
  requireAuth: () => mocks.requireAuth(),
  AuthError: class AuthError extends Error {
    statusCode = 401;
  },
}));

vi.mock("@/lib/redis", () => ({
  checkRateLimit: () => mocks.checkRateLimit(),
}));

// The real module, with only the wallet debit replaced: `splitRevenue` is the
// platform's 70/30 promise and these tests should exercise the arithmetic that
// ships, not a second copy of it written for the test.
vi.mock("@/lib/services/balance.service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/services/balance.service")>();
  return { ...actual, debitWallet: (...a: unknown[]) => mocks.debitWallet(...a) };
});

vi.mock("@/lib/services/spend-cap.service", () => ({
  checkSpendCap: (...a: unknown[]) => mocks.checkSpendCap(...a),
  spendCapMessage: () => "Daily spend limit reached (test)",
}));

import { PAID_MESSAGE_PRICE } from "@/lib/pay-message";
import { GET, POST } from "./route";

const VIEWER = "viewer-1";
const CREATOR = "creator-1";

function send(body: Record<string, unknown>) {
  return new NextRequest("https://app.test/api/messages", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** A read: `?userId=X` is one thread, no query is the whole inbox. */
function read(query = "") {
  return new NextRequest(`https://app.test/api/messages${query}`);
}

const asViewer = (id = VIEWER) =>
  mocks.requireAuth.mockResolvedValue({ userId: id, role: "VIEWER" });
const asCreator = (id = CREATOR) =>
  mocks.requireAuth.mockResolvedValue({ userId: id, role: "CREATOR" });

/**
 * The mocked `user.findUnique` answers BY ID.
 *
 * It used to answer with one object no matter what was asked, which was fine
 * while the route only ever looked the receiver up. It now resolves the sender
 * too — the sender's role is what decides who pays — and a mock that returned
 * the receiver for both would have every "viewer" test run as a creator.
 */
const ACCOUNTS: Record<string, { role: "CREATOR" | "VIEWER"; isBanned: boolean }> = {};

function account(id: string, role: "CREATOR" | "VIEWER", isBanned = false) {
  ACCOUNTS[id] = { role, isBanned };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(ACCOUNTS)) delete ACCOUNTS[key];
  account(VIEWER, "VIEWER");
  account(CREATOR, "CREATOR");

  mocks.findUser.mockImplementation((args: { where?: { id?: string } }) => {
    const found = args?.where?.id ? ACCOUNTS[args.where.id] : undefined;
    return Promise.resolve(
      found ? { id: args.where!.id, isBanned: found.isBanned, role: found.role } : null
    );
  });
  mocks.checkRateLimit.mockResolvedValue({ allowed: true });
  mocks.checkSpendCap.mockResolvedValue({
    allowed: true,
    cap: 0,
    spent: 0,
    remaining: Infinity,
    overBy: 0,
  });
  mocks.debitWallet.mockResolvedValue({ ok: true, balance: 4000 });
  // Default: the viewer follows the creator, so the send path is reachable. Tests
  // that care about the gate override this with null.
  mocks.findSubscription.mockResolvedValue({ id: "sub-1" });
  mocks.createNotification.mockResolvedValue({ id: "note-1" });
  mocks.createMessage.mockImplementation((args: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: "msg-1", ...args.data })
  );
});

describe("what a message costs a viewer", () => {
  it("charges the fixed price, with nothing in the request to choose it", async () => {
    asViewer();

    const res = await POST(send({ receiverId: CREATOR, content: "hi" }));

    expect(res.status).toBe(201);
    expect(mocks.debitWallet).toHaveBeenCalledWith(tx, {
      userId: VIEWER,
      amount: PAID_MESSAGE_PRICE,
    });
    expect(mocks.createMessage.mock.calls[0][0].data.amount).toBe(PAID_MESSAGE_PRICE);
  });

  it("charges that price even when a client sends an amount of its own", async () => {
    // An old composer, a stale tab or a scripted client used to set the price —
    // a message for a shilling, or one that drained a wallet. The amount is the
    // server's now, so an amount in the body changes nothing either way.
    asViewer();

    const res = await POST(send({ receiverId: CREATOR, amount: 50_000, content: "hi" }));

    expect(res.status).toBe(201);
    expect(mocks.debitWallet).toHaveBeenCalledWith(tx, {
      userId: VIEWER,
      amount: PAID_MESSAGE_PRICE,
    });
    expect(mocks.createMessage.mock.calls[0][0].data.amount).toBe(PAID_MESSAGE_PRICE);
  });
});

describe("the split", () => {
  it("pays the creator 70% and records the platform's 30%", async () => {
    asViewer();

    const res = await POST(send({ receiverId: CREATOR, content: "hi" }));

    expect(res.status).toBe(201);
    // A message is not an exception to the promise /about makes.
    expect(mocks.createTransaction.mock.calls[0][0].data).toMatchObject({
      amount: PAID_MESSAGE_PRICE,
      platformFee: 30,
      creatorCut: 70,
    });
    // No holding period: the creator's share lands straight in the withdrawable
    // balance.
    expect(mocks.upsertBalance.mock.calls[0][0].update.availableBalance).toEqual({
      increment: 70,
    });
  });

  it("gives the two halves back to exactly what the fan paid", async () => {
    asViewer();

    await POST(send({ receiverId: CREATOR, content: "hi" }));

    const recorded = mocks.createTransaction.mock.calls[0][0].data;
    expect(recorded.platformFee + recorded.creatorCut).toBe(PAID_MESSAGE_PRICE);
  });

  it("tells the receiver what the sender paid and what their share is", async () => {
    asViewer();

    await POST(send({ receiverId: CREATOR, content: "hi" }));

    const note = mocks.createNotification.mock.calls[0][0].data;
    expect(note.message).toContain(String(PAID_MESSAGE_PRICE));
    expect(note.message).toContain("70");
  });
});

describe("a creator's inbox is for their subscribers", () => {
  it("refuses a viewer who does not follow the creator", async () => {
    asViewer();
    mocks.findSubscription.mockResolvedValue(null);

    const res = await POST(send({ receiverId: CREATOR, content: "hi" }));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe("SUBSCRIPTION_REQUIRED");
    expect(mocks.debitWallet).not.toHaveBeenCalled();
    expect(mocks.createMessage).not.toHaveBeenCalled();
  });

  it("asks for a live subscription to THIS creator", async () => {
    asViewer();

    await POST(send({ receiverId: CREATOR, content: "hi" }));

    const where = mocks.findSubscription.mock.calls[0][0].where;
    expect(where).toMatchObject({
      viewerId: VIEWER,
      creatorId: CREATOR,
      isActive: true,
    });
    // A cancelled membership keeps its row until the period ends, so the expiry
    // is what decides, not the flag alone.
    expect(where.expiresAt.gt).toBeInstanceOf(Date);
  });

  it("does not gate a message to a plain account", async () => {
    const OTHER = "viewer-3";
    account(OTHER, "VIEWER");
    asViewer();

    const res = await POST(send({ receiverId: OTHER, content: "hi" }));

    expect(res.status).toBe(201);
    expect(mocks.findSubscription).not.toHaveBeenCalled();
  });

  it("does not gate a creator writing to a peer — it charges them", async () => {
    // A subscription is a fan's door to an inbox, not a toll between creators.
    // With no inbound thread this creator is not answering anyone, so it is a
    // first contact and it costs the price like anyone else's.
    const OTHER_CREATOR = "creator-2";
    account(OTHER_CREATOR, "CREATOR");
    asCreator();
    mocks.findSubscription.mockResolvedValue(null);

    const res = await POST(send({ receiverId: OTHER_CREATOR, content: "hey" }));

    expect(res.status).toBe(201);
    expect(mocks.findSubscription).not.toHaveBeenCalled();
    expect(mocks.debitWallet).toHaveBeenCalledWith(tx, {
      userId: CREATOR,
      amount: PAID_MESSAGE_PRICE,
    });
  });
});

describe("a viewer never gets a free message", () => {
  it("still pays the price, even while subscribed", async () => {
    // The subscription is the door, not the price: being subscribed to the
    // creator does not make a message cheaper, and it never makes it free.
    asViewer();
    mocks.findSubscription.mockResolvedValue({ id: "sub-1" });

    const res = await POST(send({ receiverId: CREATOR, content: "hi" }));

    expect(res.status).toBe(201);
    expect(mocks.debitWallet).toHaveBeenCalledWith(tx, {
      userId: VIEWER,
      amount: PAID_MESSAGE_PRICE,
    });
  });

  it("never turns an existing thread into a free reply", async () => {
    // An earlier message from the receiver would have been the "they wrote
    // first" excuse. The route must not look for it either.
    asViewer();
    mocks.findMessage.mockResolvedValue({ id: "msg-from-receiver" });

    const res = await POST(send({ receiverId: CREATOR, content: "hi" }));

    expect(res.status).toBe(201);
    expect(mocks.findMessage).not.toHaveBeenCalled();
    expect(mocks.createMessage.mock.calls[0][0].data.amount).toBe(PAID_MESSAGE_PRICE);
  });

  it("charges a viewer writing back to a creator who answered", async () => {
    // The conversation is two-way, and the VIEWER is the one who pays for their
    // side of it — a reply from the creator does not make the next message free.
    asViewer();

    const res = await POST(send({ receiverId: CREATOR, content: "thanks!" }));

    expect(res.status).toBe(201);
    expect(mocks.debitWallet).toHaveBeenCalledWith(tx, {
      userId: VIEWER,
      amount: PAID_MESSAGE_PRICE,
    });
  });
});

describe("a creator answering is free", () => {
  beforeEach(() => {
    // The fan wrote first — which is what makes this an answer rather than a
    // cold message. Without it the same send is charged (see below).
    mocks.findMessage.mockResolvedValue({ id: "inbound-from-fan" });
  });

  it("charges nothing, moves no balance and writes no ledger row", async () => {
    asCreator();

    const res = await POST(send({ receiverId: VIEWER, content: "thanks for watching" }));

    expect(res.status).toBe(201);
    expect(mocks.debitWallet).not.toHaveBeenCalled();
    expect(mocks.upsertBalance).not.toHaveBeenCalled();
    expect(mocks.updateUser).not.toHaveBeenCalled();
    // No ledger row either: a 0-amount TIP would be a transaction every earnings
    // and revenue read would then have to learn to ignore.
    expect(mocks.createTransaction).not.toHaveBeenCalled();
  });

  it("still delivers the message, and tells the viewer it arrived", async () => {
    asCreator();

    await POST(send({ receiverId: VIEWER, content: "thanks for watching" }));

    const stored = mocks.createMessage.mock.calls[0][0].data;
    expect(stored).toMatchObject({ receiverId: VIEWER, amount: 0, content: "thanks for watching" });

    const note = mocks.createNotification.mock.calls[0][0].data;
    expect(note.userId).toBe(VIEWER);
    expect(note.link).toBe("/inbox");
  });

  it("ignores an amount a creator's client happens to send", async () => {
    // The composer stops sending it, but a stale tab or a scripted client might.
    // A reply must not become a purchase because of it.
    asCreator();

    const res = await POST(send({ receiverId: VIEWER, amount: 5_000, content: "hi" }));

    expect(res.status).toBe(201);
    expect(mocks.debitWallet).not.toHaveBeenCalled();
    expect(mocks.createMessage.mock.calls[0][0].data.amount).toBe(0);
  });

  it("reads the sender's role from the database, not from the token", async () => {
    // A session issued before the role changed still says CREATOR, which would
    // have made the message free. The database is what decides who pays, and it
    // says VIEWER — so the price applies.
    mocks.requireAuth.mockResolvedValue({ userId: VIEWER, role: "CREATOR" });

    const res = await POST(send({ receiverId: CREATOR, content: "hi" }));

    expect(res.status).toBe(201);
    expect(mocks.debitWallet).toHaveBeenCalledWith(tx, {
      userId: VIEWER,
      amount: PAID_MESSAGE_PRICE,
    });
  });
});

describe("only a reply is free", () => {
  it("charges a creator who writes to a fan who never wrote first", async () => {
    // The fan never wrote, so there is nothing to answer: this is first
    // contact, and the role-only rule used to let the caller in for nothing.
    asCreator();
    mocks.findMessage.mockResolvedValue(null);

    const res = await POST(send({ receiverId: VIEWER, content: "hello there" }));

    expect(res.status).toBe(201);
    expect(mocks.debitWallet).toHaveBeenCalledWith(tx, {
      userId: CREATOR,
      amount: PAID_MESSAGE_PRICE,
    });
  });

  it("does not extend the exception to another creator, even with a thread", async () => {
    // An inbox's free reply is an answer to a FAN. A creator writing to a peer
    // is not answering a fan, so every such message is paid — which is what
    // closes the "become a creator, then message creators for free" hole.
    const OTHER_CREATOR = "creator-2";
    account(OTHER_CREATOR, "CREATOR");
    asCreator();
    mocks.findMessage.mockResolvedValue({ id: "inbound" });

    const res = await POST(send({ receiverId: OTHER_CREATOR, content: "hey" }));

    expect(res.status).toBe(201);
    expect(mocks.debitWallet).toHaveBeenCalledWith(tx, {
      userId: CREATOR,
      amount: PAID_MESSAGE_PRICE,
    });
  });
});

describe("the ledger a paid message writes", () => {
  it("credits a creator's withdrawable balance, not their wallet", async () => {
    asViewer();

    const res = await POST(send({ receiverId: CREATOR, content: "hi" }));

    expect(res.status).toBe(201);
    expect(mocks.updateUser).not.toHaveBeenCalled();
    // The creator's 70% of the price, available immediately.
    expect(mocks.upsertBalance.mock.calls[0][0]).toMatchObject({
      where: { creatorId: CREATOR },
      create: { creatorId: CREATOR, availableBalance: 70, totalEarned: 70 },
      update: {
        availableBalance: { increment: 70 },
        totalEarned: { increment: 70 },
      },
    });
    expect(mocks.createTransaction.mock.calls[0][0].data).toMatchObject({
      userId: VIEWER,
      creatorId: CREATOR,
      amount: PAID_MESSAGE_PRICE,
      type: "TIP",
      status: "SUCCESS",
      platformFee: 30,
      creatorCut: 70,
      metadata: { method: "pay_message", recipientId: CREATOR },
    });
  });

  it("pays a plain account into their wallet instead of a fake creator balance", async () => {
    // One viewer messaging another: the receiver has no CreatorBalance to pay
    // out from, so their share goes into the wallet they can actually spend,
    // and the ledger does not pretend they are a creator.
    const OTHER = "viewer-2";
    account(OTHER, "VIEWER");
    asViewer();

    const res = await POST(send({ receiverId: OTHER, content: "cold dm" }));

    expect(res.status).toBe(201);
    expect(mocks.upsertBalance).not.toHaveBeenCalled();
    // Their 70% of the price, into the wallet: the platform takes its 30% from
    // an ordinary account exactly as it does from a creator's message.
    expect(mocks.updateUser.mock.calls[0][0].data.walletBalance).toEqual({ increment: 70 });
    expect(mocks.createTransaction.mock.calls[0][0].data).toMatchObject({
      creatorId: null,
      amount: PAID_MESSAGE_PRICE,
      platformFee: 30,
      creatorCut: 70,
      metadata: { method: "pay_message", recipientId: OTHER },
    });
  });

  it("reports an empty wallet instead of sending", async () => {
    asViewer();
    mocks.debitWallet.mockResolvedValue({ ok: false, balance: 120 });

    const res = await POST(send({ receiverId: CREATOR, content: "hi" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("120");
    expect(mocks.createMessage).not.toHaveBeenCalled();
    expect(mocks.upsertBalance).not.toHaveBeenCalled();
    expect(mocks.createTransaction).not.toHaveBeenCalled();
  });

  it("tells the receiver what the message was worth", async () => {
    asViewer();

    await POST(send({ receiverId: CREATOR, content: "hi" }));

    const note = mocks.createNotification.mock.calls[0][0].data;
    expect(note.userId).toBe(CREATOR);
    expect(note.message).toMatch(/TZS/);
    expect(note.link).toBe("/inbox");
  });
});

describe("guards", () => {
  it("refuses a message to yourself", async () => {
    asViewer();

    const res = await POST(send({ receiverId: VIEWER, amount: 500, content: "hi" }));

    expect(res.status).toBe(400);
    expect(mocks.debitWallet).not.toHaveBeenCalled();
  });

  it("refuses a send once the daily spend cap is reached, before any money moves", async () => {
    asViewer();
    mocks.checkSpendCap.mockResolvedValue({
      allowed: false,
      cap: 500_000,
      spent: 500_000,
      remaining: 0,
      overBy: 500,
    });

    const res = await POST(send({ receiverId: CREATOR, content: "hi" }));

    expect(res.status).toBe(429);
    expect(mocks.debitWallet).not.toHaveBeenCalled();
    expect(mocks.createMessage).not.toHaveBeenCalled();
  });

  it("never caps a creator's free reply — a reply is not spending", async () => {
    asCreator();
    // The fan wrote first: this is the reply that is free, so the cap that only
    // governs spending must not touch it.
    mocks.findMessage.mockResolvedValue({ id: "inbound-from-fan" });
    mocks.checkSpendCap.mockResolvedValue({
      allowed: false,
      cap: 500_000,
      spent: 500_000,
      remaining: 0,
      overBy: 500,
    });

    const res = await POST(send({ receiverId: VIEWER, content: "thanks" }));

    expect(res.status).toBe(201);
    // The cap is only consulted when something is actually being charged.
    expect(mocks.checkSpendCap).not.toHaveBeenCalled();
  });

  it("refuses a banned receiver", async () => {
    asViewer();
    account(CREATOR, "CREATOR", true);

    const res = await POST(send({ receiverId: CREATOR, content: "hi" }));

    expect(res.status).toBe(404);
    expect(mocks.debitWallet).not.toHaveBeenCalled();
  });
});

// =============================================================================
// The other half of "pay to chat": the delivery.
//
// The POST tests above prove who is charged. They say nothing about whether the
// message is then READABLE by both people — and a platform where a fan pays and
// sees nothing back is the failure this whole feature exists to avoid. These
// tests pin the read side: one thread is the conversation in BOTH directions, so
// both the fan and the creator see both messages.
// =============================================================================

describe("both sides of the conversation can read it", () => {
  const PAID = {
    id: "msg-paid",
    senderId: VIEWER,
    receiverId: CREATOR,
    amount: PAID_MESSAGE_PRICE,
    content: "hello from the fan",
    isRead: false,
    createdAt: new Date("2026-09-26T10:00:00Z"),
    sender: { id: VIEWER, displayName: "Fan", avatarUrl: null, role: "VIEWER" },
    receiver: { id: CREATOR, displayName: "Creator", avatarUrl: null, role: "CREATOR" },
  };
  const REPLY = {
    id: "msg-reply",
    senderId: CREATOR,
    receiverId: VIEWER,
    amount: 0,
    content: "thanks for watching",
    isRead: false,
    createdAt: new Date("2026-09-26T10:05:00Z"),
    sender: { id: CREATOR, displayName: "Creator", avatarUrl: null, role: "CREATOR" },
    receiver: { id: VIEWER, displayName: "Fan", avatarUrl: null, role: "VIEWER" },
  };

  beforeEach(() => {
    // Newest first, the way the route asks for them.
    mocks.findMany.mockResolvedValue([REPLY, PAID]);
    mocks.updateMany.mockResolvedValue({ count: 1 });
  });

  it("asks for the conversation in both directions, not one", async () => {
    asViewer();

    await GET(read(`?userId=${CREATOR}`));

    // The bug this guards: querying only `senderId = me`, which shows a fan
    // their own outgoing messages and hides every reply.
    expect(mocks.findMany.mock.calls[0][0].where.OR).toEqual([
      { senderId: VIEWER, receiverId: CREATOR },
      { senderId: CREATOR, receiverId: VIEWER },
    ]);
  });

  it("shows the fan the paid message AND the creator's reply", async () => {
    asViewer();

    const res = await GET(read(`?userId=${CREATOR}`));
    const body = (await res.json()) as {
      data: Array<{ id: string; content: string; senderId: string }>;
    };

    expect(res.status).toBe(200);
    expect(body.data.map((m) => m.content)).toEqual([
      "thanks for watching",
      "hello from the fan",
    ]);
    expect(body.data.map((m) => m.senderId)).toContain(VIEWER);
    expect(body.data.map((m) => m.senderId)).toContain(CREATOR);
  });

  it("shows the creator the same two messages", async () => {
    asCreator();

    const res = await GET(read(`?userId=${VIEWER}`));
    const body = (await res.json()) as { data: Array<{ id: string }> };

    expect(body.data).toHaveLength(2);
    expect(body.data.map((m) => m.id).sort()).toEqual([PAID.id, REPLY.id].sort());
  });

  it("marks the OTHER side's messages read, and leaves your own alone", async () => {
    asViewer();

    await GET(read(`?userId=${CREATOR}`));

    // readAt is stamped with the read, not just a boolean flipped.
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { senderId: CREATOR, receiverId: VIEWER, isRead: false },
      data: { isRead: true, readAt: expect.any(Date) },
    });
  });

  it("lists the creator in the fan's inbox, with the unread count", async () => {
    asViewer();

    const res = await GET(read());
    const body = await res.json();

    expect(body.data.conversations).toHaveLength(1);
    expect(body.data.conversations[0].partner.id).toBe(CREATOR);
    // The reply is what the fan has not read yet.
    expect(body.data.conversations[0].unreadCount).toBe(1);
  });
});

// =============================================================================
// How many are waiting — the number the Inbox link and the list both show.
//
// A creator earns from their inbox, so the one thing they must not miss is a fan
// who has paid to be heard. The badge asks a question of its own rather than
// reading the conversation list, because it runs on every page of the site.
// =============================================================================

describe("how many messages are waiting", () => {
  it("answers a bare count for the badge, without building the inbox", async () => {
    asViewer();
    mocks.count.mockResolvedValue(3);

    const res = await GET(read("?unread=1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.unreadCount).toBe(3);
    expect(mocks.count).toHaveBeenCalledWith({
      where: { receiverId: VIEWER, isRead: false },
    });
    // The point of the mode: one indexed count, not the 300-message read the
    // conversation list performs — on every page of the site, for one digit.
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("reports the total the badges add up to, beside the list", async () => {
    asViewer();
    const message = (id: string) => ({
      id,
      senderId: CREATOR,
      receiverId: VIEWER,
      amount: PAID_MESSAGE_PRICE,
      content: "hi",
      isRead: false,
      createdAt: new Date("2026-09-26T10:00:00Z"),
      sender: { id: CREATOR, displayName: "Creator", avatarUrl: null, role: "CREATOR" },
      receiver: { id: VIEWER, displayName: "Fan", avatarUrl: null, role: "VIEWER" },
    });
    mocks.findMany.mockResolvedValue([message("m1"), message("m2")]);

    const res = await GET(read());
    const body = await res.json();

    expect(body.data.conversations[0].unreadCount).toBe(2);
    expect(body.data.unreadTotal).toBe(2);
  });
});
