// =============================================================================
// GENHUB - What renewing right now would charge
//
// renew-subscriptions is the one worker the supervisor refuses to start, because
// a USSD push lands on a fan's phone (cron-hold-alert.service.ts). That refusal
// leaves the person who has to press "Run now" deciding blind, so the preview
// answers the question first — and the whole value of it is that it answers it
// *without doing anything*:
//
//   * no transaction row, no attempt counter, no notification, no prompt;
//   * no heartbeat slot, because the heartbeat is the record of what moved money
//     and a dry run that claimed it would also hide the worker from the overdue
//     alarm — the one thing that makes somebody press the button.
//
// The second half is the gate. Both the worker and the preview decide with
// `renewalGate`, and this suite pins its boundaries so the sentence in the bell
// ("a run now would charge 3") cannot drift from what the worker then does.
//
// The database is mocked: nothing here needs a database, and the assertions are
// largely about what was NOT written.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/config", () => ({
  default: {
    appUrl: "https://genhub.test",
    nodeEnv: "test",
    harakaPay: { apiKey: "", sandbox: true, webhookToken: "" },
    business: { holdingPeriodDays: 14 },
  },
}));

vi.mock("@/lib/db", () => ({
  default: {
    creatorSubscription: { findMany: vi.fn(), update: vi.fn() },
    transaction: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
    notification: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/services/subscription.service", () => ({
  grantSubscription: vi.fn(),
  resyncSubscriberCount: vi.fn(),
}));

vi.mock("@/lib/services/balance.service", () => ({
  debitWallet: vi.fn(),
}));

vi.mock("@/lib/payments/harakapay", () => ({
  harakaCollect: vi.fn(),
  harakaErrorReason: (error: unknown) => String((error as Error)?.message || error),
  floatGate: vi.fn(),
}));

import prisma from "@/lib/db";
import { floatGate } from "@/lib/payments/harakapay";
import {
  MAX_RENEW_ATTEMPTS,
  RETRY_GAP_MS,
  RENEW_LEAD_MS,
  renewalGate,
  previewDueRenewals,
  summarizeRenewalPreview,
  type RenewalCandidate,
} from "@/lib/services/subscription-renewal.service";

const findMany = vi.mocked(prisma.creatorSubscription.findMany);
const findPending = vi.mocked(prisma.transaction.findFirst);
const findUser = vi.mocked(prisma.user.findUnique);
const createTransaction = vi.mocked(prisma.transaction.create);
const createNotification = vi.mocked(prisma.notification.create);
const updateSubscription = vi.mocked(prisma.creatorSubscription.update);

const NOW = new Date("2026-09-01T12:00:00.000Z");
const inHours = (hours: number) => new Date(NOW.getTime() + hours * 3600_000);

/** A due membership, three hours from expiring. */
function due(over: Partial<RenewalCandidate> = {}): RenewalCandidate {
  return {
    id: "sub-1",
    viewerId: "fan-1",
    creatorId: "creator-1",
    price: 5_000,
    expiresAt: inHours(3),
    renewAttempts: 0,
    lastRenewAttemptAt: null,
    renewPhone: null,
    creator: { displayName: "Ivanny" },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([due()] as never);
  findPending.mockResolvedValue(null);
  findUser.mockResolvedValue({ walletBalance: 0 } as never);
  vi.mocked(floatGate).mockResolvedValue({ state: "ok", floatTzs: 50_000, cached: false });
});

// ---------------------------------------------------------------------------
// The gate: one decision, used by the worker and the preview
// ---------------------------------------------------------------------------

describe("renewalGate", () => {
  it("charges a due membership with nothing in the way", () => {
    expect(renewalGate(due(), NOW)).toEqual({ action: "charge" });
  });

  it("still charges a membership whose period ended an hour ago", () => {
    // The grace window is days wide on purpose: an hour past the end is a cron
    // that was late, not a fan who left, and the membership is still theirs.
    expect(renewalGate(due({ expiresAt: inHours(-1) }), NOW)).toEqual({ action: "charge" });
  });

  it("skips a membership that is out of attempts with time left", () => {
    const gate = renewalGate(
      due({ renewAttempts: MAX_RENEW_ATTEMPTS, expiresAt: inHours(48) }),
      NOW
    );
    expect(gate.action).toBe("skip");
  });

  it("lapses a membership that is out of attempts and has ended", () => {
    const gate = renewalGate(
      due({ renewAttempts: MAX_RENEW_ATTEMPTS, expiresAt: inHours(-1) }),
      NOW
    );
    expect(gate.action).toBe("lapse");
  });

  it("never charges a membership that lapsed long ago", () => {
    const gate = renewalGate(due({ expiresAt: inHours(-24 * 30) }), NOW);
    expect(gate.action).toBe("lapse");
  });

  it("respects the retry gap", () => {
    const gate = renewalGate(
      due({ lastRenewAttemptAt: new Date(NOW.getTime() - RETRY_GAP_MS + 60_000) }),
      NOW
    );
    expect(gate.action).toBe("skip");
  });

  it("tries again once the gap has passed", () => {
    const gate = renewalGate(
      due({ lastRenewAttemptAt: new Date(NOW.getTime() - RETRY_GAP_MS - 60_000) }),
      NOW
    );
    expect(gate.action).toBe("charge");
  });

  it("always says why it is not charging", () => {
    // The preview prints this reason to a person who is deciding, so "skip"
    // without a sentence would be a blank line in the answer.
    const gate = renewalGate(due({ renewAttempts: MAX_RENEW_ATTEMPTS, expiresAt: inHours(48) }), NOW);
    expect(gate.action === "skip" && gate.reason.length).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// The preview: who would be charged, and by which route
// ---------------------------------------------------------------------------

describe("previewDueRenewals", () => {
  it("uses the wallet when it covers the price, and asks for no phone", async () => {
    findUser.mockResolvedValue({ walletBalance: 20_000 } as never);

    const preview = await previewDueRenewals({ now: NOW });

    expect(preview.wouldCharge).toBe(1);
    expect(preview.fromWallet).toBe(1);
    expect(preview.byPhone).toBe(0);
    expect(preview.lines[0]).toMatchObject({
      subscriptionId: "sub-1",
      method: "wallet",
      price: 5_000,
      creatorName: "Ivanny",
    });
    expect(preview.lines[0].phone).toBeUndefined();
  });

  it("falls back to the phone remembered on the subscription", async () => {
    findUser.mockResolvedValue({ walletBalance: 1_000 } as never);
    findMany.mockResolvedValue([due({ renewPhone: "+255700000000" })] as never);

    const preview = await previewDueRenewals({ now: NOW });

    expect(preview.byPhone).toBe(1);
    expect(preview.lines[0].method).toBe("ussd");
    expect(preview.lines[0].phone).toBe("+255700000000");
  });

  it("recovers the phone from the fan's last gateway checkout", async () => {
    findUser.mockResolvedValue({ walletBalance: 0 } as never);
    findPending
      // No pending SUBSCRIPTION checkout, then the last gateway charge.
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ metadata: { phone: "+255711111111" } } as never);

    const preview = await previewDueRenewals({ now: NOW });

    expect(preview.byPhone).toBe(1);
    expect(preview.lines[0].phone).toBe("+255711111111");
  });

  it("holds a USSD line when the float is empty, and says why", async () => {
    findUser.mockResolvedValue({ walletBalance: 1_000 } as never);
    findMany.mockResolvedValue([due({ renewPhone: "+255700000000" })] as never);
    vi.mocked(floatGate).mockResolvedValue({ state: "empty", floatTzs: 0, cached: false });

    const preview = await previewDueRenewals({ now: NOW });

    // The preview has to answer with what the worker would actually do. Saying
    // "1 by USSD push" here, while the worker holds the very same fan, is the
    // disagreement this preview exists to prevent.
    expect(preview.wouldCharge).toBe(0);
    expect(preview.byPhone).toBe(0);
    expect(preview.notCharged[0].reason).toContain("float is empty");
    expect(preview.float).toMatchObject({ state: "empty", floatTzs: 0 });
    expect(summarizeRenewalPreview(preview)).toContain("held");
  });

  it("charges the wallet while the float is empty, and does not ask the gateway", async () => {
    findUser.mockResolvedValue({ walletBalance: 20_000 } as never);
    vi.mocked(floatGate).mockResolvedValue({ state: "empty", floatTzs: 0, cached: false });

    const preview = await previewDueRenewals({ now: NOW });

    expect(preview.fromWallet).toBe(1);
    expect(preview.wouldCharge).toBe(1);
    // No phone in the plan means no float reading: a run of wallet renewals
    // must not depend on the gateway answering.
    expect(floatGate).not.toHaveBeenCalled();
    expect(preview.float).toBeNull();
  });

  it("says why a membership with no wallet and no phone will not be charged", async () => {
    findUser.mockResolvedValue({ walletBalance: 0 } as never);

    const preview = await previewDueRenewals({ now: NOW });

    expect(preview.wouldCharge).toBe(0);
    expect(preview.notCharged).toHaveLength(1);
    expect(preview.notCharged[0].reason).toContain("no phone number is on file");
  });

  it("holds back a membership whose earlier checkout is still awaiting approval", async () => {
    findUser.mockResolvedValue({ walletBalance: 20_000 } as never);
    findPending.mockResolvedValue({ id: "tx-1" } as never);

    const preview = await previewDueRenewals({ now: NOW });

    expect(preview.wouldCharge).toBe(0);
    expect(preview.notCharged[0].reason).toContain("awaiting approval");
    // A PENDING checkout blocks the attempt whatever its age — a late settlement
    // is honoured, so a second charge could extend the membership twice.
    expect(findUser).not.toHaveBeenCalled();
  });

  it("does not double as the worker — it writes nothing at all", async () => {
    findUser.mockResolvedValue({ walletBalance: 20_000 } as never);

    await previewDueRenewals({ now: NOW });

    expect(createTransaction).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    expect(updateSubscription).not.toHaveBeenCalled();
    expect(vi.mocked(prisma.$transaction)).not.toHaveBeenCalled();
  });

  it("counts what it looked at, including what it held back", async () => {
    findMany.mockResolvedValue([due(), due({ id: "sub-2", expiresAt: inHours(-24 * 30) })] as never);
    findUser.mockResolvedValue({ walletBalance: 20_000 } as never);

    const preview = await previewDueRenewals({ now: NOW });

    expect(preview.considered).toBe(2);
    expect(preview.wouldCharge).toBe(1);
    expect(preview.notCharged).toHaveLength(1);
  });

  it("counts a row it could not read instead of reporting zero", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    findUser.mockRejectedValueOnce(new Error("connection refused"));

    const preview = await previewDueRenewals({ now: NOW });

    expect(preview.errors).toBe(1);
    expect(preview.wouldCharge).toBe(0);
    warn.mockRestore();
  });

  it("looks at exactly the rows the worker would: active, auto-renewing, inside the lead window", async () => {
    await previewDueRenewals({ now: NOW });

    const where = findMany.mock.calls[0][0]?.where as Record<string, { lte: Date }> & {
      isActive: boolean;
      autoRenew: boolean;
    };
    expect(where.isActive).toBe(true);
    expect(where.autoRenew).toBe(true);
    expect(where.expiresAt.lte.getTime()).toBe(NOW.getTime() + RENEW_LEAD_MS);
  });
});

// ---------------------------------------------------------------------------
// The sentence the person actually reads
// ---------------------------------------------------------------------------

describe("summarizeRenewalPreview", () => {
  it("names the split between wallet and phone when it would charge", () => {
    const sentence = summarizeRenewalPreview({
      considered: 3,
      wouldCharge: 3,
      fromWallet: 2,
      byPhone: 1,
      notCharged: [],
      lines: [],
      errors: 0,
      float: null,
    });

    expect(sentence).toContain("3");
    expect(sentence).toContain("2 from wallet");
    expect(sentence).toContain("1 by USSD push");
  });

  it("says nobody would be charged rather than leaving the number out", () => {
    const sentence = summarizeRenewalPreview({
      considered: 2,
      wouldCharge: 0,
      fromWallet: 0,
      byPhone: 0,
      notCharged: [
        { subscriptionId: "sub-1", reason: "stale" },
        { subscriptionId: "sub-2", reason: "no phone" },
      ],
      lines: [],
      errors: 0,
      float: null,
    });

    expect(sentence).toContain("charge nobody");
    expect(sentence).toContain("none of them is chargeable");
  });
});
