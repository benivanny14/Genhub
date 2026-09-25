// =============================================================================
// GENHUB - The float alert
//
// The gateway does not refuse a payment when its float is gone: it accepts the
// collect, answers "USSD push sent", and never delivers the prompt. The customer
// is told it worked and no order settles. By then the only fix left is a top-up
// on the merchant account, so the alarm has to arrive on the way down — which
// makes three things worth pinning:
//
//   1. WHERE the line is. At the floor it is fine (the floor is the last safe
//      number, not the first bad one), a shilling under it is a warning, and 0
//      is the state that silently eats payments.
//   2. That the two levels share ONE throttle key. A float that crosses the
//      floor and then empties inside the window is one problem and must produce
//      one row, not two.
//   3. That "could not read the balance" is never reported as a healthy float,
//      and never pages anybody as if it were zero.
//
// The database and the mailer are mocked, so the throttle and the wording are
// checked without a database and without sending anything.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/config", () => ({
  default: {
    appUrl: "https://genhub.test",
    harakaPay: { floatFloorTzs: 10_000 },
  },
}));

vi.mock("@/lib/db", () => ({
  default: {
    user: { findMany: vi.fn() },
    notification: { findFirst: vi.fn(), create: vi.fn() },
  },
}));

// The config mock above is minimal on purpose, and the float gate made the
// gateway module import the cache (the gate trusts one reading for a minute), so
// the cache is stubbed too: this suite is about the ALARM, and it must not need
// a Redis to describe one.
vi.mock("@/lib/redis", () => ({
  cacheGet: async () => null,
  cacheSet: async () => {},
}));

vi.mock("@/lib/email", () => ({
  sendMail: vi.fn(async () => ({ sent: true, transport: "console" })),
}));

import prisma from "@/lib/db";
import { sendMail } from "@/lib/email";
import { formatTZS } from "@/lib/utils";
import {
  DEFAULT_FLOAT_FLOOR_TZS,
  FLOAT_ALERT_LINK,
  FLOAT_ALERT_WINDOW_MS,
  alertFloat,
  assessFloat,
  floatAlertCopy,
  floatFloorTzs,
  watchFloat,
  type FloatSnapshot,
} from "@/lib/services/harakapay-float-alert.service";

const findMany = vi.mocked(prisma.user.findMany);
const findFirst = vi.mocked(prisma.notification.findFirst);
const create = vi.mocked(prisma.notification.create);
const mail = vi.mocked(sendMail);

const admin = { id: "admin-1", email: "owner@genhub.test" };

/**
 * The row the service asked to write, read loosely.
 *
 * This suite is about what the alert says and how often, not about Prisma's
 * argument types, and a cast here keeps the assertions about the words.
 */
function createdRow(index: number): Record<string, unknown> {
  const call = create.mock.calls[index];
  if (!call) throw new Error(`no notification was written (call ${index + 1})`);
  return call[0].data as unknown as Record<string, unknown>;
}

/** The `where` the service asked for. Same reasoning as `createdRow`. */
function whereOf(index: number): { title?: string; createdAt?: { gt?: Date } } {
  const call = findFirst.mock.calls[index];
  if (!call) throw new Error(`notification.findFirst was not called (call ${index + 1})`);
  return call[0]!.where as unknown as { title?: string; createdAt?: { gt?: Date } };
}

const snapshot = (floatTzs: number, floorTzs = 10_000): FloatSnapshot => ({
  floatTzs,
  walletTzs: 0,
  floorTzs,
});

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([admin] as never);
  findFirst.mockResolvedValue(null);
  create.mockResolvedValue({ id: "n1" } as never);
});

// ---------------------------------------------------------------------------
// Where the line is
// ---------------------------------------------------------------------------

describe("assessFloat", () => {
  it("calls a float of zero empty, because that is when payments stop arriving", () => {
    expect(assessFloat(0, 10_000)).toBe("empty");
  });

  it("calls a negative balance empty too", () => {
    expect(assessFloat(-500, 10_000)).toBe("empty");
  });

  it("treats the floor itself as fine", () => {
    // The floor is the last safe number, not the first bad one: warning exactly
    // at it would make the operator's own setting look like a fault.
    expect(assessFloat(10_000, 10_000)).toBe("ok");
  });

  it("warns one shilling under the floor", () => {
    expect(assessFloat(9_999, 10_000)).toBe("low");
  });

  it("does not call a non-number healthy", () => {
    expect(assessFloat(Number.NaN, 10_000)).toBe("empty");
  });
});

describe("floatFloorTzs", () => {
  it("uses the configured floor", () => {
    expect(floatFloorTzs()).toBe(10_000);
  });

  it("falls back to the default rather than to no floor at all", () => {
    // config holds 0 for "unset" (see lib/config.ts); a floor of 0 would mean
    // "say nothing until the float is gone", which is the state this exists to
    // arrive at early.
    expect(DEFAULT_FLOAT_FLOOR_TZS).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// What the alert says
// ---------------------------------------------------------------------------

describe("floatAlertCopy", () => {
  it("keeps one title for both levels, because the title is the throttle key", () => {
    expect(floatAlertCopy("low", snapshot(4_000), "https://genhub.test").title).toBe(
      floatAlertCopy("empty", snapshot(0), "https://genhub.test").title
    );
  });

  it("says what the float is and what the floor is", () => {
    const copy = floatAlertCopy("low", snapshot(4_000), "https://genhub.test");
    // Asserted through the app's own money formatter rather than a literal, so
    // the test is about the number being in the sentence — the same helper the
    // dashboard uses, so the bell and the page cannot disagree on the format.
    expect(copy.message).toContain(formatTZS(4_000));
    expect(copy.message).toContain(formatTZS(10_000));
    expect(copy.emailSubject).toContain("4,000");
  });

  it("explains the empty case in the words that matter — accepted, not refused", () => {
    const copy = floatAlertCopy("empty", snapshot(0), "https://genhub.test");
    expect(copy.message).toContain("USSD push sent");
    expect(copy.message).toContain("never reaches the customer's phone");
    expect(copy.emailSubject).toContain("EMPTY");
  });

  it("carries an action and a place to verify it", () => {
    for (const level of ["low", "empty"] as const) {
      const copy = floatAlertCopy(level, snapshot(0), "https://genhub.test");
      expect(copy.message).toContain(`https://genhub.test${FLOAT_ALERT_LINK}`);
      expect(copy.emailText).toContain("Top up the float");
    }
  });

  it("does not leave a trailing slash doubled in the link", () => {
    const copy = floatAlertCopy("empty", snapshot(0), "https://genhub.test/");
    expect(copy.message).toContain(`https://genhub.test${FLOAT_ALERT_LINK}`);
    expect(copy.message).not.toContain("genhub.test//");
  });
});

// ---------------------------------------------------------------------------
// Who is told, and how often
// ---------------------------------------------------------------------------

describe("alertFloat", () => {
  it("writes one notification per admin, with a link the bell can follow", async () => {
    const outcome = await alertFloat("low", snapshot(4_000));

    expect(outcome.alerted).toBe(true);
    expect(outcome.notifications).toBe(1);
    expect(outcome.emails).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(createdRow(0)).toMatchObject({
      userId: "admin-1",
      type: "warning",
      link: FLOAT_ALERT_LINK,
    });
    expect(mail.mock.calls[0][0].to).toBe("owner@genhub.test");
  });

  it("stays quiet inside the window", async () => {
    findFirst.mockResolvedValue({ id: "already" } as never);

    const outcome = await alertFloat("low", snapshot(4_000));

    expect(outcome.alreadyTold).toBe(true);
    expect(outcome.alerted).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(mail).not.toHaveBeenCalled();
  });

  it("throttles on the title, not on the level", async () => {
    // The row written for "low" must also silence "empty": one float went bad,
    // and two rows about it is the alarm somebody mutes.
    await alertFloat("low", snapshot(4_000));
    const written = createdRow(0).title;

    findFirst.mockResolvedValue({ id: "already" } as never);
    const second = await alertFloat("empty", snapshot(0));

    expect(second.alreadyTold).toBe(true);
    expect(whereOf(1).title).toBe(written);
  });

  it("asks for the reminder window in the past, not for everything", async () => {
    await alertFloat("empty", snapshot(0));
    const since = whereOf(0).createdAt?.gt;
    if (!since) throw new Error("the alert did not ask for a window at all");
    const age = Date.now() - since.getTime();

    expect(age).toBeGreaterThanOrEqual(FLOAT_ALERT_WINDOW_MS - 1_000);
    expect(age).toBeLessThan(FLOAT_ALERT_WINDOW_MS + 5_000);
  });

  it("shouts when there is no admin to tell", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    findMany.mockResolvedValue([] as never);

    const outcome = await alertFloat("empty", snapshot(0));

    expect(outcome.noAdmins).toBe(true);
    expect(create).not.toHaveBeenCalled();
    expect(errors.mock.calls.flat().join(" ")).toContain("no ADMIN");
    errors.mockRestore();
  });

  it("does not take the poke down when the database refuses", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    findMany.mockRejectedValueOnce(new Error("connection refused"));

    const outcome = await alertFloat("empty", snapshot(0));

    expect(outcome.noAdmins).toBe(false);
    expect(outcome.alerted).toBe(false);
    errors.mockRestore();
  });

  it("files a refused write as failed, never as 'we chose to stay quiet'", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    create.mockRejectedValueOnce(new Error("write refused"));

    const outcome = await alertFloat("empty", snapshot(0));

    expect(outcome.failed).toBe(true);
    expect(outcome.alreadyTold).toBe(false);
    errors.mockRestore();
  });

  it("keeps the record when only the mail host fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    mail.mockRejectedValueOnce(new Error("smtp down"));

    const outcome = await alertFloat("low", snapshot(4_000));

    expect(outcome.alerted).toBe(true);
    expect(outcome.notifications).toBe(1);
    errors.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Reading the balance
// ---------------------------------------------------------------------------

describe("watchFloat", () => {
  it("says nothing when the float is fine, and does not touch the database", async () => {
    const watch = await watchFloat({
      read: async () => ({ success: true, float_balance: 25_000, wallet_balance: 500 }),
    });

    expect(watch.read).toBe(true);
    expect(watch.level).toBe("ok");
    expect(watch.outcome).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("alerts on the way down", async () => {
    const watch = await watchFloat({
      read: async () => ({ success: true, float_balance: 4_000, wallet_balance: 0 }),
    });

    expect(watch.level).toBe("low");
    expect(watch.outcome?.alerted).toBe(true);
    expect(watch.snapshot?.floorTzs).toBe(10_000);
  });

  it("alerts at zero", async () => {
    const watch = await watchFloat({
      read: async () => ({ success: true, float_balance: 0 }),
    });

    expect(watch.level).toBe("empty");
    expect(watch.outcome?.notifications).toBe(1);
  });

  it("reads a gateway that will not answer as unreadable, not as healthy", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const watch = await watchFloat({
      read: async () => {
        throw new Error("HarakaPay /api/v1/balance error 503: upstream down");
      },
    });

    expect(watch.read).toBe(false);
    expect(watch.note).toContain("503");
    expect(watch.outcome).toBeNull();
    // A balance nobody could read must not be reported as a warning OR as fine:
    // `read: false` is the third answer, and the caller has to notice it.
    expect(watch.level).toBeNull();
    errors.mockRestore();
  });

  it("refuses to read a missing float as zero", async () => {
    // Paging somebody about a float that is fine is how the alarm gets ignored
    // the one time it is right.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const watch = await watchFloat({
      read: async () => ({ success: true, wallet_balance: 0 }),
    });

    expect(watch.read).toBe(false);
    expect(watch.level).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("accepts a numeric string from the gateway", async () => {
    const watch = await watchFloat({
      read: async () => ({ success: true, float_balance: "25000" as unknown as number }),
    });

    expect(watch.read).toBe(true);
    expect(watch.snapshot?.floatTzs).toBe(25_000);
  });
});
