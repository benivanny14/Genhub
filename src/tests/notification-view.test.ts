// =============================================================================
// GENHUB - src/lib/notification-view.ts
//
// The three decisions both notification surfaces make about a row. Each one has
// a failure that looks like success, which is why they are pinned:
//
//   1. TONE. An unknown type must read as neutral. If it fell through to the
//      last branch it would wear whatever colour that branch has, so a row with
//      no meaning would look like an alarm — or worse, like good news.
//   2. AGE. The buckets are what a person reads instead of a timestamp, so the
//      edges matter: 59 seconds is "just now" and 60 is "1m ago"; an
//      unparseable date must NOT read as "just now", because that makes a data
//      problem look like a brand-new message.
//   3. HREF. A link is followed by tapping a row. Only an in-app path counts:
//      `https://…`, `javascript:…` and the protocol-relative `//host` all have
//      to be refused, since each of them would navigate away from Genhub on a
//      tap the person thought was reading a notification.
// =============================================================================

import { describe, it, expect } from "vitest";
import {
  notificationTone,
  notificationHref,
  formatNotificationAge,
} from "@/lib/notification-view";

describe("notificationTone", () => {
  it("keeps each tone the API can send", () => {
    expect(notificationTone("success")).toBe("success");
    expect(notificationTone("warning")).toBe("warning");
    expect(notificationTone("error")).toBe("error");
    expect(notificationTone("info")).toBe("info");
  });

  it("reads a type in any case, with stray space around it", () => {
    expect(notificationTone(" Success ")).toBe("success");
    expect(notificationTone("ERROR")).toBe("error");
  });

  it("gives an unknown type the neutral tone, not an alarming one", () => {
    // A type this build does not know is a row it cannot interpret. Neutral is
    // the only honest answer; borrowing a colour would say something we do not
    // know to be true.
    expect(notificationTone("critical")).toBe("info");
    expect(notificationTone("")).toBe("info");
    expect(notificationTone(null)).toBe("info");
    expect(notificationTone(undefined)).toBe("info");
  });
});

describe("notificationHref", () => {
  it("passes an in-app path through", () => {
    expect(notificationHref("/creator")).toBe("/creator");
    expect(notificationHref("/video/abc?from=bell")).toBe("/video/abc?from=bell");
  });

  it("refuses anything that leaves the site", () => {
    // Each of these would be a tap that opens a notification and lands
    // somewhere else entirely.
    expect(notificationHref("https://evil.example/login")).toBeNull();
    expect(notificationHref("javascript:alert(1)")).toBeNull();
    expect(notificationHref("//evil.example/login")).toBeNull();
    expect(notificationHref("creator")).toBeNull();
  });

  it("treats a missing link as no link", () => {
    expect(notificationHref(null)).toBeNull();
    expect(notificationHref(undefined)).toBeNull();
    expect(notificationHref("   ")).toBeNull();
  });
});

describe("formatNotificationAge", () => {
  const now = Date.parse("2026-10-07T12:00:00.000Z");
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();

  it("calls the last minute 'just now'", () => {
    expect(formatNotificationAge(ago(0), now)).toBe("just now");
    expect(formatNotificationAge(ago(59), now)).toBe("just now");
  });

  it("turns over to minutes, hours and days at the boundary", () => {
    expect(formatNotificationAge(ago(60), now)).toBe("1m ago");
    expect(formatNotificationAge(ago(59 * 60 + 59), now)).toBe("59m ago");
    expect(formatNotificationAge(ago(60 * 60), now)).toBe("1h ago");
    expect(formatNotificationAge(ago(23 * 60 * 60 + 3599), now)).toBe("23h ago");
    expect(formatNotificationAge(ago(24 * 60 * 60), now)).toBe("1d ago");
    expect(formatNotificationAge(ago(29 * 24 * 60 * 60), now)).toBe("29d ago");
  });

  it("shows a real date once a month has passed", () => {
    // Past a month, "41d ago" is harder to read than the date it happened.
    // 31 days before the fixed "now" is 6 September.
    expect(formatNotificationAge(ago(31 * 24 * 60 * 60), now)).toMatch(/^6 Sep/);
  });

  it("does not call an unreadable timestamp 'just now'", () => {
    // The dangerous direction: a bad date wearing the freshest label would make
    // a broken row look like a message that just arrived.
    expect(formatNotificationAge("not a date", now)).toBe("");
    expect(formatNotificationAge(null, now)).toBe("");
  });

  it("reads a clock slightly ahead of ours as 'just now'", () => {
    expect(formatNotificationAge(ago(-30), now)).toBe("just now");
  });
});
