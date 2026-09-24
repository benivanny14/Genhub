// =============================================================================
// GENHUB - The hold alert
//
// The supervisor runs every worker whose schedule has not — except
// `renew-subscriptions`, which can send a USSD charge request to a fan's phone.
// Refusing to start it is right; refusing to start it AND telling nobody is how a
// renewal silently lapses, so this suite is about the two ways that goes wrong:
//
//   1. Nobody is told. The poke succeeds, the worker stays overdue, and the only
//      record is a workflow log nobody opens.
//   2. Everybody is told, repeatedly. The supervisor runs on every poke (~14
//      times a day); a warning that arrives fourteen times gets muted, taking
//      the alarm with it.
//
// The database and the mailer are mocked, so the throttle — the part that decides
// between those two failures — is checked without a database and without sending
// anything.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/config", () => ({
  default: { appUrl: "https://genhub.test" },
}));

vi.mock("@/lib/db", () => ({
  default: {
    user: { findMany: vi.fn() },
    notification: { findFirst: vi.fn(), create: vi.fn() },
  },
}));

vi.mock("@/lib/email", () => ({
  sendMail: vi.fn(async () => ({ sent: true, transport: "console" })),
}));

import prisma from "@/lib/db";
import { sendMail } from "@/lib/email";
import {
  HOLD_ALERT_LINK,
  HOLD_ALERT_WINDOW_MS,
  alertHeldWorkers,
  holdAlertCopy,
  workersNeedingAPerson,
} from "@/lib/services/cron-hold-alert.service";
import type { SupervisorDecision } from "@/lib/services/cron-supervisor.service";

const findMany = vi.mocked(prisma.user.findMany);
const findFirst = vi.mocked(prisma.notification.findFirst);
const create = vi.mocked(prisma.notification.create);
const mail = vi.mocked(sendMail);

function held(over: Partial<SupervisorDecision> = {}): SupervisorDecision {
  return {
    id: "renew-subscriptions",
    name: "Renew subscriptions",
    state: "late",
    reason: "renew-subscriptions can send a charge request to a customer's phone, so it is never started automatically",
    ...over,
  };
}

/** The admin row shape the service selects. */
const admin = { id: "admin-1", email: "owner@genhub.test" };

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([admin] as never);
  findFirst.mockResolvedValue(null);
  create.mockResolvedValue({ id: "n1" } as never);
});

// ---------------------------------------------------------------------------
// Who is worth waking somebody up for
// ---------------------------------------------------------------------------

describe("workersNeedingAPerson", () => {
  it("picks the worker that is overdue and may not be started", () => {
    expect(workersNeedingAPerson([held()]).map((w) => w.id)).toEqual([
      "renew-subscriptions",
    ]);
  });

  it.each(["never", "stalled", "failing", "ok", "running"] as const)(
    "leaves a %s worker out",
    (state) => {
      // `never` is a schedule nobody configured (setup work, said loudly on the
      // card); `stalled` and `failing` are jobs that die when they run — a fix,
      // not a button. Repeating any of those every poke is how the bell gets
      // muted before the case that matters arrives.
      expect(workersNeedingAPerson([held({ state })])).toEqual([]);
    }
  );

  it("does nothing at all when there is nothing to report", async () => {
    const outcome = await alertHeldWorkers([held({ state: "stalled" })]);

    expect(outcome.alerted).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
    expect(mail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// What it says
// ---------------------------------------------------------------------------

describe("holdAlertCopy", () => {
  const copy = holdAlertCopy(held(), "https://genhub.test");

  it("names the worker in the line somebody sees first", () => {
    expect(copy.title).toContain("Renew subscriptions");
    expect(copy.title).toContain("overdue");
  });

  it("carries the reason and the action, in that order", () => {
    // An alert that names a problem without an action is a notification somebody
    // reads and closes.
    expect(copy.message).toContain("customer's phone");
    expect(copy.message).toContain("Run now");
    expect(copy.message).toContain(`https://genhub.test${HOLD_ALERT_LINK}`);
  });

  it("gives the email everything a reader needs without opening the app", () => {
    expect(copy.emailSubject).toContain("Renew subscriptions");
    expect(copy.emailText).toContain("Background jobs");
    expect(copy.emailText).toContain(`https://genhub.test${HOLD_ALERT_LINK}`);
    // The cadence, stated: an operator should know whether this is the first
    // time they are hearing it or the fifth.
    expect(copy.emailText).toContain(String(HOLD_ALERT_WINDOW_MS / 3600_000));
    expect(copy.emailHtml).toContain(`https://genhub.test${HOLD_ALERT_LINK}`);
  });

  it("does not say the same thing twice", () => {
    // The bug this wording came from: the plan's reason used to end with
    // "run it from Admin → Background jobs", and the copy appended its own
    // instruction — one sentence with the same three words in it twice.
    const occurrences = copy.message.split(HOLD_ALERT_LINK).length - 1;
    expect(occurrences).toBe(1);
    expect(copy.message).not.toContain("run it from Admin");
  });

  it("tolerates a trailing slash on the app URL", () => {
    expect(holdAlertCopy(held(), "https://genhub.test/").message).toContain(
      `https://genhub.test${HOLD_ALERT_LINK}`
    );
  });
});

// ---------------------------------------------------------------------------
// Telling people
// ---------------------------------------------------------------------------

describe("alertHeldWorkers", () => {
  it("tells every admin once, in the bell and by email", async () => {
    const outcome = await alertHeldWorkers([held()]);

    expect(create).toHaveBeenCalledTimes(1);
    const data = create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.userId).toBe("admin-1");
    expect(data.type).toBe("warning");
    expect(data.link).toBe(HOLD_ALERT_LINK);
    expect(String(data.title)).toContain("Renew subscriptions");

    // The email is the channel for somebody who is not on the site, so the two
    // arrive together — same throttle, one decision.
    expect(mail).toHaveBeenCalledTimes(1);
    expect((mail.mock.calls[0][0] as { to: string }).to);
    expect((mail.mock.calls[0][0] as { to: string }).to).toBe("owner@genhub.test");

    expect(outcome.alerted).toEqual(["renew-subscriptions"]);
    expect(outcome.notifications).toBe(1);
    expect(outcome.emails).toBe(1);
    expect(outcome.failed).toEqual([]);
    expect(outcome.noAdmins).toBe(false);
  });

  it("tells each admin once", async () => {
    findMany.mockResolvedValue([
      { id: "admin-1", email: "a@genhub.test" },
      { id: "admin-2", email: "b@genhub.test" },
    ] as never);

    const outcome = await alertHeldWorkers([held()]);

    expect(create).toHaveBeenCalledTimes(2);
    expect(mail).toHaveBeenCalledTimes(2);
    expect(outcome.notifications).toBe(2);
    // One worker, reported once — the id is not repeated per admin.
    expect(outcome.alerted).toEqual(["renew-subscriptions"]);
  });

  it("stays quiet when the same worker was reported inside the window", async () => {
    findFirst.mockResolvedValue({ id: "recent" } as never);

    const outcome = await alertHeldWorkers([held()]);

    expect(create).not.toHaveBeenCalled();
    expect(mail).not.toHaveBeenCalled();
    // Reported as throttled rather than as "nothing happened": the workflow log
    // can then show the difference between silence and a decision.
    expect(outcome.alreadyTold).toEqual(["renew-subscriptions"]);
    expect(outcome.alerted).toEqual([]);
  });

  it("throttles on the worker's own title, not on the bell being busy", async () => {
    // A different worker's alert must not suppress this one: each is its own
    // outage, and one overdue job hiding another is the failure mode.
    await alertHeldWorkers([held({ id: "release-earnings", name: "Release matured earnings" })]);

    const where = findFirst.mock.calls[0][0]!.where as Record<string, unknown>;
    expect(String(where.title)).toContain("Release matured earnings");
    expect(where.userId).toBe("admin-1");
    expect((where.createdAt as { gt: Date }).gt).toBeInstanceOf(Date);
  });

  it("marks a bell-only admin without mailing them", async () => {
    findMany.mockResolvedValue([{ id: "admin-1", email: null }] as never);

    const outcome = await alertHeldWorkers([held()]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(mail).not.toHaveBeenCalled();
    expect(outcome.emails).toBe(0);
  });

  it("shouts when there is no admin to tell", async () => {
    findMany.mockResolvedValue([] as never);

    const outcome = await alertHeldWorkers([held()]);

    expect(outcome.noAdmins).toBe(true);
    expect(outcome.alerted).toEqual([]);
    expect(create).not.toHaveBeenCalled();
    expect(mail).not.toHaveBeenCalled();
  });

  it("does not take the poke down when the database refuses", async () => {
    // This runs inside a poke that keeps renewals, releases and publishing
    // alive; an alert failing must cost a log line, never the poke.
    findMany.mockRejectedValue(new Error("connection refused"));

    await expect(alertHeldWorkers([held()])).resolves.toMatchObject({ alerted: [] });
  });

  it("does not take the poke down when the mail host refuses", async () => {
    mail.mockRejectedValue(new Error("smtp down"));

    const outcome = await alertHeldWorkers([held()]);

    // The record survives the mail failure — the bell is what the app can
    // promise, the email is best effort.
    expect(create).toHaveBeenCalledTimes(1);
    expect(outcome.alerted).toEqual(["renew-subscriptions"]);
    expect(outcome.emails).toBe(0);
  });

  it("does not file a refused write as 'we chose to stay quiet'", async () => {
    // "we already told them" and "we could not tell them at all" are different
    // facts, and a log line that lumps them together reads as the throttle
    // working while a worker is overdue and nobody knows.
    create.mockRejectedValue(new Error("write refused"));

    const outcome = await alertHeldWorkers([held()]);

    expect(outcome.failed).toEqual(["renew-subscriptions"]);
    expect(outcome.alerted).toEqual([]);
    expect(outcome.alreadyTold).toEqual([]);
  });
});
