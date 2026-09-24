// =============================================================================
// GENHUB - The credential alarm: prompt, once, and never in the way
//
// The hourly watchdog is the net; this is what makes the alarm prompt. A gateway
// key revoked at 10:02 must not wait until 11:00 to be mentioned, because every
// collect in between is accepted by a gateway that will never deliver it.
//
// Four properties are pinned here, and each one is a decision rather than a
// detail:
//
//   * it never depends on Redis — a dead cache is one of the faults it reports;
//   * it says a thing once per window, or it gets muted;
//   * it never throws and never blocks, so a failure to report a failure cannot
//     become a second failure; and
//   * it distinguishes "your credential is wrong" from "this one address was
//     wrong", because reporting a customer's typo as a revoked SMTP password is
//     how an operator learns to ignore the channel.
// =============================================================================

import { describe, it, expect, beforeEach } from "vitest";

import {
  isCredentialFailure,
  reportCredentialFault,
  resetCredentialAlerts,
} from "@/lib/credential-alert";

const ok = () => new Response("{}", { status: 200 });

/** A fetch stand-in that records what was posted and always succeeds. */
function recordingFetch() {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body || "{}")) });
    return ok();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

beforeEach(() => {
  resetCredentialAlerts();
});

describe("reportCredentialFault", () => {
  it("posts once and says so the second time", async () => {
    const { calls, fetchImpl } = recordingFetch();

    const first = await reportCredentialFault(
      { service: "HarakaPay", detail: "the gateway rejected the key" },
      { fetchImpl, webhookUrl: "https://hooks.example/genhub", now: () => 1_000 }
    );
    const second = await reportCredentialFault(
      { service: "HarakaPay", detail: "the gateway rejected the key" },
      { fetchImpl, webhookUrl: "https://hooks.example/genhub", now: () => 1_001 }
    );

    expect(first).toBe("sent");
    expect(second).toBe("cooldown");
    // The whole point: a payment path that retries must not page somebody per
    // attempt.
    expect(calls).toHaveLength(1);
  });

  it("speaks again once the window has passed", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const now = { value: 0 };

    await reportCredentialFault(
      { service: "SMTP", detail: "auth failed" },
      { fetchImpl, webhookUrl: "https://hooks.example/genhub", now: () => now.value }
    );
    now.value = 31 * 60_000;

    const again = await reportCredentialFault(
      { service: "SMTP", detail: "auth failed" },
      { fetchImpl, webhookUrl: "https://hooks.example/genhub", now: () => now.value }
    );

    expect(again).toBe("sent");
    expect(calls).toHaveLength(2);
  });

  it("keeps services separate, so one fault does not mute another", async () => {
    const { calls, fetchImpl } = recordingFetch();

    await reportCredentialFault(
      { service: "Redis", detail: "not answering" },
      { fetchImpl, webhookUrl: "https://hooks.example/genhub" }
    );
    const other = await reportCredentialFault(
      { service: "Bunny Stream", detail: "401" },
      { fetchImpl, webhookUrl: "https://hooks.example/genhub" }
    );

    expect(other).toBe("sent");
    expect(calls).toHaveLength(2);
  });

  it("still records the fault with no webhook configured", async () => {
    const { calls, fetchImpl } = recordingFetch();

    const outcome = await reportCredentialFault(
      { service: "Redis", detail: "not answering" },
      { fetchImpl, webhookUrl: "" }
    );

    // No webhook is not a failure: the log line is the record, and the site must
    // not need one to be configured.
    expect(outcome).toBe("no-webhook");
    expect(calls).toHaveLength(0);
  });

  it("sends a body both Slack and Discord can read", async () => {
    const { calls, fetchImpl } = recordingFetch();

    await reportCredentialFault(
      { service: "HarakaPay", detail: "the gateway stopped answering" },
      { fetchImpl, webhookUrl: "https://hooks.example/genhub" }
    );

    const body = calls[0].body as Record<string, unknown>;
    expect(body.service).toBe("HarakaPay");
    expect(String(body.text)).toContain("HarakaPay");
    expect(String(body.content)).toContain("HarakaPay");
    expect(body.detail).toBe("the gateway stopped answering");
  });

  it("never throws when the alert channel is broken", async () => {
    const failingFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    await expect(
      reportCredentialFault(
        { service: "Redis", detail: "not answering" },
        { fetchImpl: failingFetch, webhookUrl: "https://hooks.example/genhub" }
      )
    ).resolves.toBe("failed");

    const rejectingFetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(
      reportCredentialFault(
        { service: "SMTP", detail: "auth failed" },
        { fetchImpl: rejectingFetch, webhookUrl: "https://hooks.example/genhub" }
      )
    ).resolves.toBe("failed");
  });
});

describe("isCredentialFailure", () => {
  it("is true for the codes that mean the credential is wrong", () => {
    expect(isCredentialFailure({ code: "EAUTH" })).toBe(true);
    expect(isCredentialFailure({ code: "ECONNECTION" })).toBe(true);
    expect(isCredentialFailure({ code: "etimedout" })).toBe(true);
  });

  it("is false for a rejected recipient, which is a typo rather than a password", () => {
    // Reporting a signup form's bad address as a revoked SMTP password is how
    // whoever reads the alerts learns to stop reading them.
    expect(isCredentialFailure({ code: "EENVELOPE" })).toBe(false);
    expect(isCredentialFailure(new Error("Invalid recipient"))).toBe(false);
    expect(isCredentialFailure(undefined)).toBe(false);
  });
});
