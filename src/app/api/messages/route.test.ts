// =============================================================================
// GENHUB - Who pays to send a message
//
// Chat used to be charged unconditionally: `amount` was required to be at least
// TZS 100, the wallet was debited on every message, and the receiver's
// CreatorBalance was credited whatever they were. Three things were wrong with
// that, and all three are money:
//
//   1. A subscriber was charged again. The monthly fee bought access to the
//      creator's videos, and writing to the creator they had just paid cost extra
//      — even though the same subscription is what lets them watch for free.
//   2. A CREATOR answering a fan paid the fan. `creatorBalance.upsert` on the
//      receiver invented a creator row for a viewer who can never request a
//      payout, and parked the money in a 14-day holding to nobody's benefit.
//   3. Every reply was charged, so the only way a creator could answer was to
//      move their own money into a fake balance.
//
// These tests pin the rules: free for an active subscriber, free when the
// receiver wrote first (the creator is answering), and the ledger that a paid
// message writes — creator holding balance for a creator, wallet for anyone
// else. Prisma, auth and the wallet service are mocked; no database, no money.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  checkRateLimit: vi.fn(),
  debitWallet: vi.fn(),
  findUser: vi.fn(),
  updateUser: vi.fn(),
  findSubscription: vi.fn(),
  findMessage: vi.fn(),
  createMessage: vi.fn(),
  upsertBalance: vi.fn(),
  createTransaction: vi.fn(),
  createNotification: vi.fn(),
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
    payMessage: { findFirst: (...a: unknown[]) => mocks.findMessage(...a) },
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

vi.mock("@/lib/services/balance.service", () => ({
  debitWallet: (...a: unknown[]) => mocks.debitWallet(...a),
}));

import { MIN_PAID_MESSAGE } from "@/lib/pay-message";
import { POST } from "./route";

const VIEWER = "viewer-1";
const CREATOR = "creator-1";

function send(body: Record<string, unknown>) {
  return new NextRequest("https://app.test/api/messages", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const asViewer = (id = VIEWER) =>
  mocks.requireAuth.mockResolvedValue({ userId: id, role: "VIEWER" });
const asCreator = (id = CREATOR) =>
  mocks.requireAuth.mockResolvedValue({ userId: id, role: "CREATOR" });

/** The receiver is a creator by default; pass "VIEWER" for a plain account. */
function receiver(role: "CREATOR" | "VIEWER" = "CREATOR") {
  mocks.findUser.mockResolvedValue({ id: CREATOR, isBanned: false, role });
}

/**
 * The route asks `findFirst` twice — "does the SENDER subscribe to the receiver"
 * and "does the RECEIVER subscribe to the sender" — so the stub is keyed on the
 * pair. Keying on `viewerId` alone silently returns the wrong answer for the
 * second question, which is the direction a creator answering their own
 * subscriber depends on.
 */
function subscriptions(byPair: Record<string, unknown> = {}) {
  mocks.findSubscription.mockImplementation(
    (args: { where: { viewerId: string; creatorId: string } }) =>
      Promise.resolve(byPair[`${args.where.viewerId}:${args.where.creatorId}`] ?? null)
  );
}

const HOLDING = { expiresAt: new Date("2026-10-25T00:00:00Z") };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkRateLimit.mockResolvedValue({ allowed: true });
  mocks.findMessage.mockResolvedValue(null);
  mocks.debitWallet.mockResolvedValue({ ok: true, balance: 4000 });
  mocks.createMessage.mockResolvedValue({
    id: "msg-1",
    senderId: VIEWER,
    receiverId: CREATOR,
    amount: 0,
    content: "hi",
  });
  subscriptions();
  receiver();
});

describe("a subscriber writes to their creator for free", () => {
  it("sends without touching the wallet", async () => {
    asViewer();
    subscriptions({ [`${VIEWER}:${CREATOR}`]: HOLDING });

    const res = await POST(send({ receiverId: CREATOR, amount: 0, content: "hi" }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data.paid).toBe(false);
    expect(body.data.freeReason).toBe("subscription");
    expect(mocks.debitWallet).not.toHaveBeenCalled();
    expect(mocks.createMessage).toHaveBeenCalledWith({
      data: { senderId: VIEWER, receiverId: CREATOR, amount: 0, content: "hi" },
    });
  });

  it("does not charge a subscriber who still sends an amount", async () => {
    // The client may keep sending the amount it had before the subscription was
    // read. The database decides the charge, not the number in the request.
    asViewer();
    subscriptions({ [`${VIEWER}:${CREATOR}`]: HOLDING });

    const res = await POST(send({ receiverId: CREATOR, amount: 5000, content: "hi" }));

    expect(res.status).toBe(201);
    expect(mocks.debitWallet).not.toHaveBeenCalled();
    expect(mocks.createMessage.mock.calls[0][0].data.amount).toBe(0);
  });

  it("writes no money transaction at all", async () => {
    asViewer();
    subscriptions({ [`${VIEWER}:${CREATOR}`]: HOLDING });

    await POST(send({ receiverId: CREATOR, amount: 0, content: "hi" }));

    expect(mocks.createTransaction).not.toHaveBeenCalled();
    expect(mocks.upsertBalance).not.toHaveBeenCalled();
  });

  it("tells the creator a subscriber wrote, not that they were paid", async () => {
    asViewer();
    subscriptions({ [`${VIEWER}:${CREATOR}`]: HOLDING });

    await POST(send({ receiverId: CREATOR, amount: 0, content: "hi" }));

    const note = mocks.createNotification.mock.calls[0][0].data;
    expect(note.message).toMatch(/subscriber/i);
    expect(note.message).not.toMatch(/TZS/);
  });
});

describe("a lapsed subscriber pays again", () => {
  it("refuses a free message and names the way out", async () => {
    asViewer();
    subscriptions(); // no active row: the membership lapsed

    const res = await POST(send({ receiverId: CREATOR, amount: 0, content: "hi" }));
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error).toContain(String(MIN_PAID_MESSAGE));
    expect(body.error).toMatch(/subscribe/i);
    expect(mocks.createMessage).not.toHaveBeenCalled();
  });

  it("refuses an amount below the floor", async () => {
    asViewer();

    const res = await POST(send({ receiverId: CREATOR, amount: 50, content: "hi" }));

    expect(res.status).toBe(422);
    expect(mocks.createMessage).not.toHaveBeenCalled();
  });

  it("sends when the amount is paid, crediting the creator's holding balance", async () => {
    asViewer();

    const res = await POST(send({ receiverId: CREATOR, amount: 500, content: "hi" }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data.paid).toBe(true);
    expect(body.data.freeReason).toBeNull();
    expect(mocks.debitWallet).toHaveBeenCalledWith(tx, { userId: VIEWER, amount: 500 });
    expect(mocks.upsertBalance.mock.calls[0][0].update.pendingBalance).toEqual({ increment: 500 });
    expect(mocks.createTransaction.mock.calls[0][0].data).toMatchObject({
      creatorId: CREATOR,
      amount: 500,
      creatorCut: 500,
    });
  });

  it("records what actually left the wallet, not what was asked for", async () => {
    asViewer();

    await POST(send({ receiverId: CREATOR, amount: 500, content: "hi" }));

    expect(mocks.createMessage.mock.calls[0][0].data.amount).toBe(500);
  });

  it("reports an empty wallet instead of sending", async () => {
    asViewer();
    mocks.debitWallet.mockResolvedValue({ ok: false, balance: 120 });

    const res = await POST(send({ receiverId: CREATOR, amount: 500, content: "hi" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("120");
    expect(mocks.createMessage).not.toHaveBeenCalled();
  });
});

describe("a creator answering their inbox", () => {
  it("is free when the fan wrote first", async () => {
    asCreator();
    mocks.findMessage.mockResolvedValue({ id: "msg-from-fan" });
    subscriptions();
    mocks.findUser.mockResolvedValue({ id: VIEWER, isBanned: false, role: "VIEWER" });

    const res = await POST(send({ receiverId: VIEWER, amount: 0, content: "thanks!" }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data.freeReason).toBe("reply");
    expect(mocks.debitWallet).not.toHaveBeenCalled();
  });

  it("is free when the receiver is their own subscriber", async () => {
    asCreator();
    mocks.findMessage.mockResolvedValue(null);
    // The fan holds the membership this time: viewer -> creator, read from the
    // receiver's side of the conversation.
    subscriptions({ [`${VIEWER}:${CREATOR}`]: { id: "sub-1" } });
    mocks.findUser.mockResolvedValue({ id: VIEWER, isBanned: false, role: "VIEWER" });

    const res = await POST(send({ receiverId: VIEWER, amount: 0, content: "hey" }));
    const body = await res.json();

    expect(body.data.freeReason).toBe("reply");
    expect(mocks.debitWallet).not.toHaveBeenCalled();
  });

  it("does not pay a viewer into a fake creator balance", async () => {
    asCreator();
    mocks.findMessage.mockResolvedValue(null);
    subscriptions();
    mocks.findUser.mockResolvedValue({ id: VIEWER, isBanned: false, role: "VIEWER" });

    const res = await POST(send({ receiverId: VIEWER, amount: 900, content: "cold dm" }));

    expect(res.status).toBe(201);
    // A viewer has no CreatorBalance to pay out from, so the money is theirs to
    // spend: straight into the wallet, and the transaction names the recipient
    // without pretending they are a creator.
    expect(mocks.upsertBalance).not.toHaveBeenCalled();
    expect(mocks.updateUser.mock.calls[0][0].data.walletBalance).toEqual({ increment: 900 });
    expect(mocks.createTransaction.mock.calls[0][0].data).toMatchObject({
      creatorId: null,
      metadata: { method: "pay_message", recipientId: VIEWER },
    });
  });
});
