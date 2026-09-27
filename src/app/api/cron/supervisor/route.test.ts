// =============================================================================
// GENHUB - POST /api/cron/supervisor: the float alert, end to end
//
// The service-level tests (src/tests/harakapay-float-alert.test.ts) pin what the
// alert says and where the line is. This file pins the wiring the supervisor
// actually runs: a poke reads the gateway balance, and an empty float reaches
// the admins ONCE — then stays quiet on every later poke while the float is
// still down, and only speaks again after the float recovers and drops again.
//
// That is the behavior the operator lives with. An alarm that repeats every ten
// minutes gets muted; an alarm that fires once and never re-arms is worse. The
// only way to prove both halves is to drive the real route twice, which is what
// this does: every collaborator that would touch the network or the database is
// mocked, but the route, the supervisor and the float service are the real ones.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * The state the mocks share, created before the module graph is imported.
 *
 * `vi.hoisted` because `vi.mock` factories are lifted above the imports and
 * cannot close over an ordinary `const`.
 */
const state = vi.hoisted(() => ({
  /** The notification table, as the float service writes it. */
  rows: [] as Array<{ id: string; userId: string; title: string; message: string; type: string; link: string | null }>,
  /** Every mail the alert handed to the mailer. */
  mails: [] as Array<Record<string, unknown>>,
  /** What the gateway will report as the float on the next poke. */
  floatBalance: 0 as number | null,
}));

vi.mock("@/lib/config", () => ({
  default: {
    appUrl: "https://genhub.test",
    harakaPay: { floatFloorTzs: 10_000 },
  },
}));

vi.mock("@/lib/email", () => ({
  sendMail: async (message: Record<string, unknown>) => {
    state.mails.push(message);
    return { sent: true, transport: "console" };
  },
}));

vi.mock("@/lib/db", () => ({
  default: {
    user: { findMany: async () => [{ id: "admin-1", email: "owner@genhub.test" }] },
    notification: {
      findFirst: async ({ where }: { where: { userId: string; title: string } }) =>
        state.rows.find((row) => row.userId === where.userId && row.title === where.title) ?? null,
      create: async ({ data }: { data: Omit<(typeof state.rows)[number], "id"> }) => {
        const row = { id: `n${state.rows.length + 1}`, ...data };
        state.rows.push(row);
        return row;
      },
      deleteMany: async ({ where }: { where: { title: string } }) => {
        const before = state.rows.length;
        for (let i = state.rows.length - 1; i >= 0; i -= 1) {
          if (state.rows[i]!.title === where.title) state.rows.splice(i, 1);
        }
        return { count: before - state.rows.length };
      },
    },
  },
}));

// The one network call the poke makes. Everything else the supervisor touches is
// mocked below, so the only thing under test is the float path.
vi.mock("@/lib/payments/harakapay", () => ({
  harakaBalance: async () => ({
    success: true,
    wallet_balance: 0,
    float_balance: state.floatBalance,
  }),
}));

vi.mock("@/lib/cron-auth", () => ({
  requireCronSecret: () => null,
  SUPERVISOR_ORIGIN_LABEL: "started by the cron supervisor",
}));

vi.mock("@/lib/services/cron-heartbeat.service", () => ({
  // The plan is empty in every case here: this suite is about the float, not
  // about which workers are overdue.
  summarizeCronHealth: () => "ok",
  getCronHealth: async () => ({
    workers: [],
    needsAttention: [],
    attentionSummary: "",
    counts: { never: 0, late: 0, stalled: 0, failing: 0, running: 0, ok: 0 },
    alerting: 0,
    degraded: false,
    checkedAt: new Date().toISOString(),
  }),
}));

vi.mock("@/lib/services/cron-jobs.service", () => ({
  runWorkerNow: async () => ({ ran: false, reason: "no worker is overdue in this test" }),
}));

vi.mock("@/lib/services/cron-hold-alert.service", () => ({
  alertHeldWorkers: async () => ({ alerted: [], noAdmins: false }),
}));

vi.mock("@/lib/services/blue-tick.service", () => ({
  expireDueBlueTicks: async () => 0,
}));

vi.mock("@/lib/services/subscription-renewal.service", () => ({
  previewDueRenewals: async () => null,
  summarizeRenewalPreview: () => "",
}));

import { POST } from "@/app/api/cron/supervisor/route";

/** One scheduled poke, as GitHub Actions or Vercel Cron would deliver it. */
function poke() {
  return POST(new NextRequest("http://localhost/api/cron/supervisor", { method: "POST" }));
}

/** The float block the poke reported back. */
async function floatOf(response: Response) {
  const body = await response.json();
  return body.data.float as {
    read: boolean;
    level: "ok" | "low" | "empty" | null;
    snapshot: { floatTzs: number; floorTzs: number } | null;
    outcome: { alerted: boolean; alreadyTold: boolean; notifications: number; emails: number } | null;
  };
}

beforeEach(() => {
  state.rows.length = 0;
  state.mails.length = 0;
  state.floatBalance = 0;
});

describe("POST /api/cron/supervisor — the float alert", () => {
  it("tells the admins once, and stays quiet on every poke after", async () => {
    const first = await floatOf(await poke());

    expect(first.level).toBe("empty");
    expect(first.outcome?.alerted).toBe(true);
    // One episode is one row and one mail, not one per poke.
    expect(state.rows).toHaveLength(1);
    expect(state.mails).toHaveLength(1);
    expect(state.rows[0]!.title).toBe("HarakaPay float is running out");

    // The next poke finds the float just as empty, and says nothing.
    const second = await floatOf(await poke());

    expect(second.outcome?.alreadyTold).toBe(true);
    expect(second.outcome?.alerted).toBe(false);
    expect(state.rows).toHaveLength(1);
    expect(state.mails).toHaveLength(1);
  });

  it("re-arms when the float recovers, so a later drop is announced again", async () => {
    await poke();
    expect(state.rows).toHaveLength(1);

    // Somebody tops the float up: the episode is over and the row is cleared.
    state.floatBalance = 50_000;
    const recovered = await floatOf(await poke());

    expect(recovered.level).toBe("ok");
    expect(recovered.outcome).toBeNull();
    expect(state.rows).toHaveLength(0);

    // And it drops below the floor again — a new episode, a new alert.
    state.floatBalance = 0;
    const again = await floatOf(await poke());

    expect(again.outcome?.alerted).toBe(true);
    // One row in the bell, and the second mail overall: the first episode's mail
    // and this one's, with nothing in between for the recovery.
    expect(state.rows).toHaveLength(1);
    expect(state.mails).toHaveLength(2);
  });

  it("warns on the way down, at a float that is low but still usable", async () => {
    state.floatBalance = 4_000;

    const float = await floatOf(await poke());

    expect(float.level).toBe("low");
    expect(float.snapshot?.floorTzs).toBe(10_000);
    expect(state.rows).toHaveLength(1);
  });

  it("does not report a float the gateway could not be read as empty", async () => {
    // A balance field the gateway never sent is NOT zero: paging somebody about
    // a float that is fine is how the alarm gets ignored the one time it is
    // right. This is the route-level guard on that rule.
    state.floatBalance = null;

    const float = await floatOf(await poke());

    expect(float.read).toBe(false);
    expect(float.level).toBeNull();
    expect(float.outcome).toBeNull();
    expect(state.rows).toHaveLength(0);
    expect(state.mails).toHaveLength(0);
  });

  it("answers 200 even when the float is empty — the poke is not the failure", async () => {
    // The whole point of softening this: a merchant balance only HarakaPay can
    // change must not turn a healthy deployment's cron poke into a red run.
    const res = await poke();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });
});
