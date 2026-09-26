// =============================================================================
// GENHUB - Who pays for a message
//
// The rule is simple and it is one-directional: a VIEWER pays to reach somebody,
// and a CREATOR (or an admin) answering their own inbox does not. The route used
// to ask the database three questions before naming a price — does the sender
// subscribe to the receiver, does the receiver subscribe to the sender, did the
// receiver write first — and a yes on any of them made the message free. That
// was wrong twice over: a subscription buys a creator's *videos* for a month,
// not their inbox, and the exemption made a reply cost money for the one person
// the product exists for, whose balance sits in earnings and not in a wallet.
//
// So: the free-reply rule is keyed on the SENDER'S ROLE, read from the database
// (a role can change long before a session is reissued) and on nothing else. No
// subscription is read, no thread history is read, and no viewer ever gets a
// free message. The amount is required, floored and capped by the same constants
// the composer renders.
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
  // Not called by the route any more. Kept as spies so that re-introducing a
  // subscription-or-thread based exemption has to delete an assertion rather
  // than slip in silently.
  findSubscription: vi.fn(),
  findMessage: vi.fn(),
  createMessage: vi.fn(),
  upsertBalance: vi.fn(),
  createTransaction: vi.fn(),
  createNotification: vi.fn(),
  // Read side: the thread and the inbox.
  findMany: vi.fn(),
  updateMany: vi.fn(),
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

import { MAX_PAID_MESSAGE, MIN_PAID_MESSAGE } from "@/lib/pay-message";
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
  mocks.debitWallet.mockResolvedValue({ ok: true, balance: 4000 });
  mocks.createNotification.mockResolvedValue({ id: "note-1" });
  mocks.createMessage.mockImplementation((args: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: "msg-1", ...args.data })
  );
});

describe("what a message costs a viewer", () => {
  it("refuses a message with no amount at all", async () => {
    asViewer();

    const res = await POST(send({ receiverId: CREATOR, content: "hi" }));

    expect(res.status).toBe(422);
    expect(mocks.createMessage).not.toHaveBeenCalled();
  });

  it("refuses zero — the amount a free composer used to send", async () => {
    asViewer();

    const res = await POST(send({ receiverId: CREATOR, amount: 0, content: "hi" }));
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error).toContain(String(MIN_PAID_MESSAGE));
    expect(mocks.createMessage).not.toHaveBeenCalled();
  });

  it("refuses an amount below the floor", async () => {
    asViewer();

    const res = await POST(send({ receiverId: CREATOR, amount: MIN_PAID_MESSAGE - 1, content: "hi" }));

    expect(res.status).toBe(422);
    expect(mocks.createMessage).not.toHaveBeenCalled();
  });

  it("refuses an amount above the ceiling, so a typo cannot drain a wallet", async () => {
    asViewer();

    const res = await POST(send({ receiverId: CREATOR, amount: MAX_PAID_MESSAGE + 1, content: "hi" }));

    expect(res.status).toBe(422);
    expect(mocks.debitWallet).not.toHaveBeenCalled();
    expect(mocks.createMessage).not.toHaveBeenCalled();
  });

  it("charges the full amount the composer offers by default", async () => {
    asViewer();

    const res = await POST(send({ receiverId: CREATOR, amount: MIN_PAID_MESSAGE, content: "hi" }));

    expect(res.status).toBe(201);
    expect(mocks.debitWallet).toHaveBeenCalledWith(tx, { userId: VIEWER, amount: MIN_PAID_MESSAGE });
    expect(mocks.createMessage.mock.calls[0][0].data.amount).toBe(MIN_PAID_MESSAGE);
  });
});

describe("the split", () => {
  it("pays the creator 70% and records the platform's 30%", async () => {
    asViewer();

    const res = await POST(send({ receiverId: CREATOR, amount: 500, content: "hi" }));

    expect(res.status).toBe(201);
    // A message is not an exception to the promise /about makes.
    expect(mocks.createTransaction.mock.calls[0][0].data).toMatchObject({
      amount: 500,
      platformFee: 150,
      creatorCut: 350,
    });
    expect(mocks.upsertBalance.mock.calls[0][0].update.pendingBalance).toEqual({
      increment: 350,
    });
  });

  it("gives the two halves back to the amount the fan paid", async () => {
    asViewer();

    // 333 is the case that would drift: 30% of it is not a whole shilling, so the
    // rounding has to leave the creator with the remainder rather than a share
    // that no longer adds up to what was charged.
    await POST(send({ receiverId: CREATOR, amount: 333, content: "hi" }));

    const recorded = mocks.createTransaction.mock.calls[0][0].data;
    expect(recorded.platformFee).toBe(Math.round(333 * 0.3));
    expect(recorded.platformFee + recorded.creatorCut).toBe(333);
  });

  it("tells the receiver what the sender paid and what their share is", async () => {
    asViewer();

    await POST(send({ receiverId: CREATOR, amount: 500, content: "hi" }));

    const note = mocks.createNotification.mock.calls[0][0].data;
    expect(note.message).toContain("500");
    expect(note.message).toContain("350");
  });
});

describe("a viewer never gets a free message", () => {
  it("never reads a subscription to decide the price", async () => {
    // A live membership row, if the route asked for one. It must not: the price
    // comes from the request, not from a relationship between the two accounts.
    asViewer();
    mocks.findSubscription.mockResolvedValue({ expiresAt: new Date("2026-10-25T00:00:00Z") });

    const res = await POST(send({ receiverId: CREATOR, amount: 500, content: "hi" }));

    expect(res.status).toBe(201);
    expect(mocks.findSubscription).not.toHaveBeenCalled();
    expect(mocks.debitWallet).toHaveBeenCalledWith(tx, { userId: VIEWER, amount: 500 });
  });

  it("never turns an existing thread into a free reply", async () => {
    // An earlier message from the receiver would have been the "they wrote
    // first" excuse. The route must not look for it either.
    asViewer();
    mocks.findMessage.mockResolvedValue({ id: "msg-from-receiver" });

    const res = await POST(send({ receiverId: CREATOR, amount: 500, content: "hi" }));

    expect(res.status).toBe(201);
    expect(mocks.findMessage).not.toHaveBeenCalled();
    expect(mocks.createMessage.mock.calls[0][0].data.amount).toBe(500);
  });

  it("charges a viewer writing back to a creator who answered", async () => {
    // The conversation is two-way, and the VIEWER is the one who pays for their
    // side of it — a reply from the creator does not make the next message free.
    asViewer();

    const res = await POST(send({ receiverId: CREATOR, amount: 900, content: "thanks!" }));

    expect(res.status).toBe(201);
    expect(mocks.debitWallet).toHaveBeenCalledWith(tx, { userId: VIEWER, amount: 900 });
  });
});

describe("a creator answering is free", () => {
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
    // A session issued before the role changed still says CREATOR. The database
    // is what decides who pays.
    mocks.requireAuth.mockResolvedValue({ userId: VIEWER, role: "CREATOR" });

    const res = await POST(send({ receiverId: CREATOR, content: "hi" }));

    expect(res.status).toBe(422);
    expect(mocks.createMessage).not.toHaveBeenCalled();
  });
});

describe("the ledger a paid message writes", () => {
  it("credits a creator's holding balance, not their wallet", async () => {
    asViewer();

    const res = await POST(send({ receiverId: CREATOR, amount: 500, content: "hi" }));

    expect(res.status).toBe(201);
    expect(mocks.updateUser).not.toHaveBeenCalled();
    // 70% of 500: the holding gets the creator's share, not what the fan paid.
    expect(mocks.upsertBalance.mock.calls[0][0]).toMatchObject({
      where: { creatorId: CREATOR },
      create: { creatorId: CREATOR, pendingBalance: 350, availableBalance: 0, totalEarned: 350 },
      update: {
        pendingBalance: { increment: 350 },
        totalEarned: { increment: 350 },
      },
    });
    expect(mocks.createTransaction.mock.calls[0][0].data).toMatchObject({
      userId: VIEWER,
      creatorId: CREATOR,
      amount: 500,
      type: "TIP",
      status: "SUCCESS",
      platformFee: 150,
      creatorCut: 350,
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

    const res = await POST(send({ receiverId: OTHER, amount: 900, content: "cold dm" }));

    expect(res.status).toBe(201);
    expect(mocks.upsertBalance).not.toHaveBeenCalled();
    // Their 70% of 900, into the wallet: the platform takes its 30% from an
    // ordinary account exactly as it does from a creator's message.
    expect(mocks.updateUser.mock.calls[0][0].data.walletBalance).toEqual({ increment: 630 });
    expect(mocks.createTransaction.mock.calls[0][0].data).toMatchObject({
      creatorId: null,
      amount: 900,
      platformFee: 270,
      creatorCut: 630,
      metadata: { method: "pay_message", recipientId: OTHER },
    });
  });

  it("reports an empty wallet instead of sending", async () => {
    asViewer();
    mocks.debitWallet.mockResolvedValue({ ok: false, balance: 120 });

    const res = await POST(send({ receiverId: CREATOR, amount: 500, content: "hi" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("120");
    expect(mocks.createMessage).not.toHaveBeenCalled();
    expect(mocks.upsertBalance).not.toHaveBeenCalled();
    expect(mocks.createTransaction).not.toHaveBeenCalled();
  });

  it("tells the receiver what the message was worth", async () => {
    asViewer();

    await POST(send({ receiverId: CREATOR, amount: 500, content: "hi" }));

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

  it("refuses a banned receiver", async () => {
    asViewer();
    account(CREATOR, "CREATOR", true);

    const res = await POST(send({ receiverId: CREATOR, amount: 500, content: "hi" }));

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
    amount: 500,
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
