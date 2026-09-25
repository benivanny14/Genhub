// =============================================================================
// GENHUB - Every message is a paid message
//
// Chat is charged on every send. The route used to ask the database three
// questions before it would name a price — does the SENDER subscribe to the
// receiver, does the RECEIVER subscribe to the sender, did the receiver write
// first — and a yes on any of them made the message free. That is wrong twice
// over: a subscription buys a creator's *videos* for a month, not their inbox,
// and a creator answering a fan is not a reason to move money out of the
// creator's own wallet and into a fake CreatorBalance row.
//
// These tests pin the paid-every-message rules: the amount is required, floored
// and capped by the same constants the composer renders, no sender is exempt,
// and the ledger names the right recipient — a creator's 14-day holding balance,
// or the wallet of anybody else. Prisma, auth and the wallet service are mocked;
// no database, no money.
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
  // free-chat exemption has to delete an assertion rather than slip in silently.
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

// The real module, with only the wallet debit replaced: `splitRevenue` is the
// platform's 70/30 promise and these tests should exercise the arithmetic that
// ships, not a second copy of it written for the test.
vi.mock("@/lib/services/balance.service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/services/balance.service")>();
  return { ...actual, debitWallet: (...a: unknown[]) => mocks.debitWallet(...a) };
});

import { MAX_PAID_MESSAGE, MIN_PAID_MESSAGE } from "@/lib/pay-message";
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkRateLimit.mockResolvedValue({ allowed: true });
  mocks.debitWallet.mockResolvedValue({ ok: true, balance: 4000 });
  mocks.createMessage.mockImplementation((args: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: "msg-1", ...args.data })
  );
  receiver();
});

describe("what a message costs", () => {
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

describe("nobody is exempt", () => {
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

  it("charges a creator answering a fan", async () => {
    asCreator();
    receiver("VIEWER");

    const res = await POST(send({ receiverId: VIEWER, amount: 900, content: "thanks!" }));

    expect(res.status).toBe(201);
    expect(mocks.debitWallet).toHaveBeenCalledWith(tx, { userId: CREATOR, amount: 900 });
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
    asCreator();
    receiver("VIEWER");

    const res = await POST(send({ receiverId: VIEWER, amount: 900, content: "cold dm" }));

    expect(res.status).toBe(201);
    // A viewer has no CreatorBalance to pay out from, so the money is theirs to
    // spend: straight into the wallet, and the transaction names the recipient
    // without pretending they are a creator.
    expect(mocks.upsertBalance).not.toHaveBeenCalled();
    // Their 70% of 900, into the wallet: the platform takes its 30% from an
    // ordinary account exactly as it does from a creator's message.
    expect(mocks.updateUser.mock.calls[0][0].data.walletBalance).toEqual({ increment: 630 });
    expect(mocks.createTransaction.mock.calls[0][0].data).toMatchObject({
      creatorId: null,
      amount: 900,
      platformFee: 270,
      creatorCut: 630,
      metadata: { method: "pay_message", recipientId: VIEWER },
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
    mocks.findUser.mockResolvedValue({ id: CREATOR, isBanned: true, role: "CREATOR" });

    const res = await POST(send({ receiverId: CREATOR, amount: 500, content: "hi" }));

    expect(res.status).toBe(404);
    expect(mocks.debitWallet).not.toHaveBeenCalled();
  });
});
