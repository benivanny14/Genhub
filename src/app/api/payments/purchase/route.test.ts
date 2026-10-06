// =============================================================================
// GENHUB - Tests for POST /api/payments/purchase — the price that gets charged
//
// The rule pinned here: the amount charged is ALWAYS the number on the video
// row. A request that sends its own amount is cross-checked against that row,
// and a disagreement refuses the payment outright — nothing is charged, no
// transaction row is written and the video stays locked — instead of quietly
// collecting the correct figure or letting the client's number through.
//
// Prisma, auth, redis and the payment services are mocked: no database, no
// gateway and no mail.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  videoFindUnique: vi.fn(),
  accessFindUnique: vi.fn(),
  transactionFindFirst: vi.fn(),
  transactionCreate: vi.fn(),
  transactionUpdate: vi.fn(),
  requireAuth: vi.fn(),
  checkRateLimit: vi.fn(),
  purchaseVideoWithWallet: vi.fn(),
  applyCoupon: vi.fn(),
  consumeCoupon: vi.fn(),
  notifyPaymentResult: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    video: { findUnique: mocks.videoFindUnique },
    videoAccess: { findUnique: mocks.accessFindUnique },
    transaction: {
      findFirst: mocks.transactionFindFirst,
      create: mocks.transactionCreate,
      update: mocks.transactionUpdate,
    },
  },
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireAuth: () => mocks.requireAuth() };
});

vi.mock("@/lib/redis", () => ({
  checkRateLimit: (...args: unknown[]) => mocks.checkRateLimit(...args),
  checkRateLimitStrict: async (...args: unknown[]) => ({
    ...(await mocks.checkRateLimit(...args)),
    unavailable: false,
  }),
}));

vi.mock("@/lib/payments/sonicpesa", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payments/sonicpesa")>();
  return {
    ...actual,
    sonicpesaCollect: vi.fn(),
    sonicpesaErrorReason: vi.fn(),
    sonicpesaStatus: vi.fn(),
    sonicpesaStatusToInternal: vi.fn(),
  };
});

vi.mock("@/lib/services/webhook.service", () => ({
  processPaymentWebhook: vi.fn(),
}));

vi.mock("@/lib/services/balance.service", () => ({
  purchaseVideoWithWallet: (...args: unknown[]) =>
    mocks.purchaseVideoWithWallet(...args),
}));

vi.mock("@/lib/services/payment-notify.service", () => ({
  notifyPaymentResult: (...args: unknown[]) => mocks.notifyPaymentResult(...args),
}));

vi.mock("@/lib/coupons", () => ({
  applyCoupon: (...args: unknown[]) => mocks.applyCoupon(...args),
  consumeCoupon: (...args: unknown[]) => mocks.consumeCoupon(...args),
}));

import { POST } from "./route";

const VIEWER = "viewer-1";
const CREATOR = "creator-1";
const VIDEO_PRICE = 2_000;

/** The row every case starts from; individual cases override the encoding. */
const VIDEO = {
  id: "video-1",
  title: "A scene",
  price: VIDEO_PRICE,
  creatorId: CREATOR,
  isPublished: true,
  isDeleted: false,
};

function request(body: Record<string, unknown>) {
  return new NextRequest("https://genhub.test/api/payments/purchase", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function post(body: Record<string, unknown>) {
  const res = await POST(request(body));
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ userId: VIEWER, role: "VIEWER" });
  mocks.checkRateLimit.mockResolvedValue({ allowed: true });
  mocks.videoFindUnique.mockResolvedValue({ ...VIDEO });
  mocks.accessFindUnique.mockResolvedValue(null);
  mocks.transactionFindFirst.mockResolvedValue(null);
  mocks.purchaseVideoWithWallet.mockResolvedValue({
    success: true,
    transactionId: "tx-1",
    newBalance: 8_000,
  });
});

describe("POST /api/payments/purchase — amount tampering", () => {
  it("refuses a payment whose amount differs from the video's price", async () => {
    const { status, body } = await post({
      videoId: "video-1",
      method: "WALLET",
      amount: 100,
    });

    expect(status).toBe(409);
    expect(body.code).toBe("AMOUNT_MISMATCH");
    // The refusal quotes the real price, so the customer is not left guessing
    // which number was right.
    expect(body.error).toContain("2,000");
  });

  it("charges nothing and writes nothing when the amount is refused", async () => {
    await post({ videoId: "video-1", method: "WALLET", amount: 5_000 });

    expect(mocks.purchaseVideoWithWallet).not.toHaveBeenCalled();
    expect(mocks.transactionCreate).not.toHaveBeenCalled();
    expect(mocks.accessFindUnique).not.toHaveBeenCalled();
  });

  it("refuses a mismatch on the phone path too, before any checkout is made", async () => {
    const { status, body } = await post({
      videoId: "video-1",
      gateway: "SONICPESA",
      phoneNumber: "0712345678",
      amount: 999,
    });

    expect(status).toBe(409);
    expect(body.code).toBe("AMOUNT_MISMATCH");
    expect(mocks.transactionCreate).not.toHaveBeenCalled();
  });

  it("charges the video's price, never the amount in the request", async () => {
    const { status } = await post({
      videoId: "video-1",
      method: "WALLET",
      amount: VIDEO_PRICE,
    });

    expect(status).toBe(200);
    expect(mocks.purchaseVideoWithWallet).toHaveBeenCalledTimes(1);
    expect(mocks.purchaseVideoWithWallet.mock.calls[0][0]).toMatchObject({
      amount: VIDEO_PRICE,
      originalPrice: VIDEO_PRICE,
    });
  });

  it("still works when no amount is sent at all — the normal client", async () => {
    const { status } = await post({ videoId: "video-1", method: "WALLET" });

    expect(status).toBe(200);
    expect(mocks.purchaseVideoWithWallet.mock.calls[0][0]).toMatchObject({
      amount: VIDEO_PRICE,
    });
  });
});

// =============================================================================
// A post that exists but cannot be played yet
//
// Instant publication put a price on screen while Bunny is still transcoding
// the scene underneath it (see /api/videos POST and lib/video-status.ts). A
// charge there takes money, pushes a USSD prompt and grants access to a video
// with no manifest — so it is refused before anything is written, quoting the
// reason and saying plainly that nobody was charged.
// =============================================================================

describe("POST /api/payments/purchase — still being prepared", () => {
  it("refuses to charge for a scene Bunny is still transcoding", async () => {
    mocks.videoFindUnique.mockResolvedValue({ ...VIDEO, encodingStatus: 1, encodeProgress: 20 });

    const { status, body } = await post({ videoId: "video-1", method: "WALLET" });

    expect(status).toBe(409);
    expect(body.code).toBe("VIDEO_PROCESSING");
    expect(body.error).toMatch(/not been charged/i);

    // Nothing at all happened: no charge, no transaction row to reconcile, no
    // coupon spent, and the customer never left the page.
    expect(mocks.purchaseVideoWithWallet).not.toHaveBeenCalled();
    expect(mocks.transactionCreate).not.toHaveBeenCalled();
    expect(mocks.applyCoupon).not.toHaveBeenCalled();
  });

  it("refuses the phone path too, before any USSD push", async () => {
    mocks.videoFindUnique.mockResolvedValue({ ...VIDEO, encodingStatus: 0, encodeProgress: 0 });

    const { status, body } = await post({
      videoId: "video-1",
      gateway: "SONICPESA",
      phoneNumber: "0712345678",
    });

    expect(status).toBe(409);
    expect(body.code).toBe("VIDEO_PROCESSING");
    expect(mocks.transactionCreate).not.toHaveBeenCalled();
  });

  it("refuses a scene whose encode failed", async () => {
    // The feed hides these, but a bookmark, a shared link or a stale page still
    // reaches this route. Access to something that will never play is not access.
    mocks.videoFindUnique.mockResolvedValue({ ...VIDEO, encodingStatus: 5, encodeProgress: 0 });

    const { status, body } = await post({ videoId: "video-1", method: "WALLET" });

    expect(status).toBe(409);
    expect(body.code).toBe("VIDEO_UNAVAILABLE");
    expect(mocks.purchaseVideoWithWallet).not.toHaveBeenCalled();
  });

  it("still sells a scene the host has finished", async () => {
    mocks.videoFindUnique.mockResolvedValue({ ...VIDEO, encodingStatus: 3, encodeProgress: 100 });

    const { status } = await post({ videoId: "video-1", method: "WALLET" });

    expect(status).toBe(200);
  });

  it("still sells a side-loaded scene Bunny never transcodes", async () => {
    // encodingStatus null = demo/migrated content, which plays from its own URL
    // and is not waiting for anything.
    mocks.videoFindUnique.mockResolvedValue({ ...VIDEO, encodingStatus: null, encodeProgress: 0 });

    const { status } = await post({ videoId: "video-1", method: "WALLET" });

    expect(status).toBe(200);
  });
});
