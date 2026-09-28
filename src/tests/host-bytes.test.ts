// =============================================================================
// GENHUB - What the video host reports holding
//
// This is the line the creator reads beside the progress bar, so two mistakes
// matter more than anything else here:
//
//   1. Showing a zero as if it were a failure. Bunny reports `storageSize 0` for
//      the whole transfer AND the whole transcode — measured: a real 2.8 MB clip
//      read 0 at 0 s, 3 s and 8 s and only reported its 37 MB footprint at 18 s.
//      An alarm on every healthy upload is worse than no number at all.
//   2. Showing nothing when the host has not answered. NULL is "no answer", and
//      it must not be rendered as a zero, for the same reason.
//
// Both are pinned below, because both decide whether a creator with a genuinely
// stuck transfer can tell it apart from one that is simply still working.
// =============================================================================

import { describe, it, expect } from "vitest";
import { formatBytes, describeHostStoredBytes } from "@/lib/host-bytes";

describe("formatBytes", () => {
  it("writes the small end in bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("steps up in 1024s, matching the rest of the product", () => {
    // The upload form says "Max 2GB" for 2 * 1024^3, so a size from Bunny must
    // mean the same thing here as it does there.
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(437_736_786)).toBe("417 MB");
    expect(formatBytes(2 * 1024 ** 3)).toBe("2.0 GB");
  });

  it("keeps one decimal below ten and rounds above it", () => {
    // `1.4 GB` is read at a glance; `437.3 MB` is noise in the same glance.
    expect(formatBytes(1.5 * 1024 ** 3)).toBe("1.5 GB");
    expect(formatBytes(37_709_741)).toBe("36 MB");
  });

  it("never invents a size for a missing or impossible one", () => {
    // These are rendered as words, not as 0 — a number implies a measurement.
    expect(formatBytes(null)).toBe("unknown");
    expect(formatBytes(undefined)).toBe("unknown");
    expect(formatBytes(-1)).toBe("unknown");
    expect(formatBytes(Number.NaN)).toBe("unknown");
  });
});

describe("describeHostStoredBytes", () => {
  it("says nothing at all when the host has not reported and no size was recorded", () => {
    // The dashboard shows a badge, not a blank line: nothing to say means the
    // line is not rendered.
    expect(describeHostStoredBytes({ storedBytes: null, sourceBytes: null })).toBeNull();
    expect(describeHostStoredBytes({})).toBeNull();
  });

  it("shows what the host holds against what the creator sent", () => {
    const summary = describeHostStoredBytes({
      storedBytes: 437_736_786,
      sourceBytes: 851_443_712,
    });
    expect(summary?.text).toBe("Host holds 417 MB of 812 MB");
    expect(summary?.empty).toBe(false);
  });

  it("flags an empty host as empty, with the size that should have arrived", () => {
    // The stalled-transfer case: the file was 812 MB and the host holds none of
    // it. This is the whole point of the line, so the flag is asserted directly.
    const summary = describeHostStoredBytes({ storedBytes: 0, sourceBytes: 851_443_712 });
    expect(summary?.text).toBe("Host holds 0 B of 812 MB");
    expect(summary?.empty).toBe(true);
    expect(summary?.detail).toMatch(/transfer has not finished arriving/i);
  });

  it("still speaks when only the host's number exists", () => {
    // Rows created before the file size was recorded are the common case today.
    const summary = describeHostStoredBytes({ storedBytes: 512_000 });
    expect(summary?.text).toBe("Host holds 500 KB");
    expect(summary?.empty).toBe(false);
  });

  it("distinguishes an unanswered host from an empty one", () => {
    // "not reported yet" must never be rendered as 0 B: that would accuse an
    // upload Bunny has said nothing about of having delivered nothing.
    const summary = describeHostStoredBytes({ storedBytes: null, sourceBytes: 1024 });
    expect(summary?.text).toMatch(/has not reported/i);
    expect(summary?.empty).toBe(false);
    expect(summary?.text).not.toContain("0 B");
  });

  it("ignores a nonsense source size rather than printing it", () => {
    const summary = describeHostStoredBytes({ storedBytes: 2048, sourceBytes: 0 });
    expect(summary?.text).toBe("Host holds 2.0 KB");
  });
});
