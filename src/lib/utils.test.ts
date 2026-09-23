// =============================================================================
// GENHUB - Utility Functions Unit Tests
// =============================================================================

import { describe, it, expect } from "vitest";
import {
  formatTZS,
  formatCount,
  generateSlug,
  formatDuration,
  isValidTZPhone,
  truncate,
  generateOrderId,
  cn,
} from "./utils";

describe("formatTZS", () => {
  it("should format zero", () => {
    expect(formatTZS(0)).toContain("0");
  });

  it("should format 1000 TZS", () => {
    const result = formatTZS(1000);
    expect(result).toContain("1");
    expect(result).toContain("000");
  });

  it("should format large amounts", () => {
    const result = formatTZS(100000);
    expect(result).toContain("100");
  });

  it("should handle negative amounts", () => {
    const result = formatTZS(-5000);
    expect(result).toContain("5");
    expect(result).toContain("000");
  });
});

describe("formatCount", () => {
  it("should format numbers below 1000 as-is", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
  });

  it("should format thousands with K", () => {
    expect(formatCount(1000)).toBe("1.0K");
    expect(formatCount(1500)).toBe("1.5K");
    expect(formatCount(999000)).toBe("999.0K");
  });

  it("should format millions with M", () => {
    expect(formatCount(1000000)).toBe("1.0M");
    expect(formatCount(2500000)).toBe("2.5M");
  });
});

describe("generateSlug", () => {
  it("should create lowercase slug", () => {
    expect(generateSlug("Hello World")).toBe("hello-world");
  });

  it("should handle special characters", () => {
    expect(generateSlug("Video #1: The Best!")).toBe("video-1-the-best");
  });

  it("should trim leading/trailing dashes", () => {
    expect(generateSlug("--test--")).toBe("test");
  });

  it("should truncate long titles", () => {
    const longTitle = "a".repeat(200);
    expect(generateSlug(longTitle).length).toBeLessThanOrEqual(100);
  });
});

describe("formatDuration", () => {
  it("should format 0 seconds", () => {
    expect(formatDuration(0)).toBe("0:00");
  });

  it("should format minutes and seconds", () => {
    expect(formatDuration(65)).toBe("1:05");
  });

  it("should format exact minutes", () => {
    expect(formatDuration(120)).toBe("2:00");
  });

  it("should pad single digits", () => {
    expect(formatDuration(301)).toBe("5:01");
  });
});

describe("isValidTZPhone", () => {
  it("should accept +255 format", () => {
    expect(isValidTZPhone("+255712345678")).toBe(true);
  });

  it("should accept 0 format", () => {
    expect(isValidTZPhone("0712345678")).toBe(true);
  });

  it("should accept numbers starting with 6", () => {
    expect(isValidTZPhone("0612345678")).toBe(true);
  });

  it("should reject too short numbers", () => {
    expect(isValidTZPhone("071234")).toBe(false);
  });

  it("should reject invalid prefixes", () => {
    expect(isValidTZPhone("0812345678")).toBe(false);
  });

  it("should accept with spaces", () => {
    expect(isValidTZPhone("071 234 5678")).toBe(true);
  });
});

describe("truncate", () => {
  it("should return original if shorter than limit", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("should truncate long text", () => {
    expect(truncate("hello world", 5)).toBe("he...");
  });

  it("should return exact text at limit", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });
});

describe("generateOrderId", () => {
  it("should generate ID with default prefix", () => {
    const id = generateOrderId();
    expect(id).toMatch(/^FBF-/);
  });

  it("should generate ID with custom prefix", () => {
    const id = generateOrderId("PPV");
    expect(id).toMatch(/^PPV-/);
  });

  it("should generate unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateOrderId()));
    expect(ids.size).toBe(100);
  });
});

describe("cn", () => {
  it("should merge class names", () => {
    const result = cn("text-red-500", "text-blue-500");
    expect(result).toBe("text-blue-500");
  });

  it("should handle conditional classes", () => {
    const result = cn("base", false && "hidden", "extra");
    expect(result).toContain("base");
    expect(result).toContain("extra");
    expect(result).not.toContain("hidden");
  });
});
