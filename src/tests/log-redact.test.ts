// =============================================================================
// GENHUB - What a log line is allowed to contain
//
// Two failures are being prevented, and they pull in opposite directions:
//
//   * a credential or a customer's phone number written into a log, where it is
//     copied, shipped to a hosting provider's log viewer and kept for months;
//   * a log so thoroughly redacted that the fault it describes cannot be found.
//
// So each rule below is paired with the thing that must SURVIVE it. A reference
// number, an order id, a status, a hostname and a stack frame are diagnostics,
// not secrets, and a test that only checked the redaction would happily bless an
// implementation that redacts everything.
// =============================================================================

import { describe, it, expect } from "vitest";
import {
  REDACTED,
  redactLogValue,
  redactText,
  safeErrorForLog,
} from "@/lib/log-redact";

describe("credentials never reach a log", () => {
  it("replaces a JWT", () => {
    // Shaped like a real session cookie, built here rather than copied from one.
    const jwt = `eyJ${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(10)}`;
    const out = redactText(`verify failed for ${jwt}`);
    expect(out).not.toContain(jwt);
    expect(out).toContain(REDACTED);
    expect(out).toContain("verify failed for");
  });

  it("replaces a bearer or named token", () => {
    expect(redactText("Authorization: Bearer abc123def456ghi789")).not.toContain("abc123def456ghi789");
    expect(redactText("token=abcdef1234567890xyz")).not.toContain("abcdef1234567890xyz");
  });

  it("replaces a secret carried in the query string", () => {
    // The cron secret used to be passable as `?secret=` — query strings are what
    // access logs and analytics keep.
    const out = redactText(
      "GET /api/cron/release-earnings?secret=super-secret-value&x=1"
    );
    expect(out).not.toContain("super-secret-value");
    // The path and the other parameter are the diagnosis; they stay.
    expect(out).toContain("/api/cron/release-earnings");
    expect(out).toContain("x=1");
  });

  it("replaces credentials in a URL", () => {
    const out = redactText("redis://default:hunter2@redis.example.test:6379");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("redis.example.test");
  });

  it("replaces a whole credential header", () => {
    const out = redactText("cookie: genhub_token=abcdefghijklmnop; other=1");
    expect(out).not.toContain("abcdefghijklmnop");
    expect(out.toLowerCase()).toContain("cookie");
  });

  it("replaces a long opaque secret", () => {
    const key = "a1b2c3d4e5f6".repeat(4); // 48 hex characters
    const out = redactText(`key ${key} refused`);
    expect(out).not.toContain(key);
    expect(out).toContain("refused");
  });
});

describe("personal data is masked, not deleted", () => {
  it("keeps enough of an email to correlate two lines", () => {
    const out = redactText("reset requested for amani@example.co.tz");
    expect(out).not.toContain("amani@example.co.tz");
    expect(out).toContain("a***@example.co.tz");
  });

  it("keeps enough of a phone number to match a customer's screenshot", () => {
    const out = redactText("collect failed for +255682642219");
    expect(out).not.toContain("682642219");
    expect(out).toContain("+25568*****");
  });
});

describe("diagnostics survive", () => {
  it("leaves the things an operator actually reads", () => {
    const line =
      "reference=7QF3K9ZM order=ORD-20260930-1042 status=FAILED host=storage.example.test";
    expect(redactText(line)).toBe(line);
  });

  it("does not treat a stack frame as a secret", () => {
    const stack = "at createTransaction (/app/src/lib/services/pay.service.ts:41:9)";
    expect(redactText(stack)).toContain("createTransaction");
    expect(redactText(stack)).toContain("pay.service.ts:41");
  });
});

describe("safeErrorForLog", () => {
  it("keeps the name and the stack, redacts credential-shaped values", () => {
    // The shape this exists for: a database client puts the PARAMETERS of the
    // failed statement into its message, and a reset token is one of them.
    const tokenHash = "9f2c7ab41d8e6350".repeat(4); // 64 hex characters
    const error = new Error(
      `Unique constraint failed on the fields: (\`token\`) value ${tokenHash}`
    );
    const out = safeErrorForLog(error);
    expect(out).toContain("Error");
    expect(out).not.toContain(tokenHash);
    // The fault itself is still readable, which is the whole point of the log.
    expect(out).toContain("Unique constraint failed");
    expect(out).toContain("at "); // the stack
  });

  it("redacts what it can recognise and says nothing about what it cannot", () => {
    // Honest about the limit: redaction is by shape and by key name, so an
    // arbitrary sentence that happens to contain a secret-looking word is not
    // detected. Field-level redaction (redactLogValue) is the answer for that,
    // which is why logging objects rather than interpolated strings is the rule.
    const out = safeErrorForLog(new Error("connection refused"));
    expect(out).toContain("connection refused");
  });

  it("handles something that is not an Error at all", () => {
    expect(safeErrorForLog("plain string")).toBe("plain string");
    expect(typeof safeErrorForLog({ code: "X" })).toBe("string");
  });
});

describe("redactLogValue", () => {
  it("drops a value whose NAME says it is a secret", () => {
    const out = redactLogValue({
      orderId: "ORD-1",
      password: "hunter2",
      webhookSecret: "abc",
      token: "xyz",
    }) as Record<string, unknown>;

    expect(out.orderId).toBe("ORD-1");
    expect(out.password).toBe(REDACTED);
    expect(out.webhookSecret).toBe(REDACTED);
    expect(out.token).toBe(REDACTED);
  });

  it("redacts inside a nested payload without losing its shape", () => {
    const out = redactLogValue({
      event: "payment.settled",
      customer: { phone: "0682642219", amount: 1000 },
    }) as Record<string, any>;

    expect(out.event).toBe("payment.settled");
    expect(out.customer.amount).toBe(1000);
    expect(String(out.customer.phone)).not.toContain("642219");
  });

  it("cannot be made to recurse or explode on a hostile object", () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 30; i++) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }
    const cyclic: Record<string, unknown> = { name: "x" };
    cyclic.self = cyclic;

    expect(() => redactLogValue(deep)).not.toThrow();
    expect(() => redactLogValue(cyclic)).not.toThrow();
    expect(JSON.stringify(redactLogValue(deep))).toContain("depth limit");
  });
});
