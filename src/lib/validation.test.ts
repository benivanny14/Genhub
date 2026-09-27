// =============================================================================
// GENHUB - Validation Schema Unit Tests
// =============================================================================

import { describe, it, expect } from "vitest";
import {
  registerSchema,
  loginSchema,
  createVideoSchema,
  updateVideoSchema,
  initiatePaymentSchema,
  topUpWalletSchema,
  submitKycSchema,
  requestPayoutSchema,
  reportVideoSchema,
} from "./validation";

describe("registerSchema", () => {
  it("should accept valid registration with email", () => {
    const result = registerSchema.safeParse({
      displayName: "Test User",
      username: "test_user",
      email: "test@example.com",
      password: "password123",
      role: "VIEWER",
      locale: "sw",
    });
    expect(result.success).toBe(true);
  });

  // The phone-only sign-up path is gone, and it went with the SMS reset channel
  // that made it survivable: such an account could create a reset token and
  // never receive it. Email is now the one identifier sign-up accepts.
  it("refuses a registration that offers a phone number instead of an email", () => {
    const result = registerSchema.safeParse({
      displayName: "Test User",
      phone: "+255712345678",
      password: "password123",
      role: "CREATOR",
    });
    expect(result.success).toBe(false);
  });

  it("ignores a phone number rather than storing one", () => {
    // Unknown keys are stripped, so a caller that still sends a phone cannot
    // put one on the row and re-create the account this rule exists to prevent.
    const result = registerSchema.safeParse({
      displayName: "Test User",
      username: "test_user",
      email: "test@example.com",
      phone: "+255712345678",
      password: "password123",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).not.toHaveProperty("phone");
  });

  it("should reject short display name", () => {
    const result = registerSchema.safeParse({
      displayName: "T",
      email: "test@example.com",
      password: "password123",
    });
    expect(result.success).toBe(false);
  });

  it("should reject short password", () => {
    const result = registerSchema.safeParse({
      displayName: "Test User",
      email: "test@example.com",
      password: "short",
    });
    expect(result.success).toBe(false);
  });

  it("should reject invalid email", () => {
    const result = registerSchema.safeParse({
      displayName: "Test User",
      email: "not-an-email",
      password: "password123",
    });
    expect(result.success).toBe(false);
  });

  it("should reject a registration with no email", () => {
    const result = registerSchema.safeParse({
      displayName: "Test User",
      username: "test_user",
      password: "password123",
    });
    expect(result.success).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Username — the one name nobody else may take
// -----------------------------------------------------------------------------
describe("registerSchema username", () => {
  const withUsername = (username: unknown) =>
    registerSchema.safeParse({
      displayName: "Test User",
      username,
      email: "test@example.com",
      password: "password123",
    });

  it("requires a username", () => {
    expect(withUsername(undefined).success).toBe(false);
    expect(withUsername("").success).toBe(false);
  });

  it("normalises case, whitespace and a leading @", () => {
    const result = withUsername("  @Test_User  ");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.username).toBe("test_user");
  });

  it("refuses reserved names and impersonating prefixes", () => {
    for (const name of ["admin", "ADMIN", "support", "genhub", "official", "genhub_support", "admin_hq"]) {
      expect(withUsername(name).success, name).toBe(false);
    }
  });

  it("refuses invalid characters and lengths", () => {
    for (const name of ["ab", "has space", "dots.here", "dash-here", "emoji😀", "x".repeat(31)]) {
      expect(withUsername(name).success, name).toBe(false);
    }
  });
});

describe("loginSchema", () => {
  it("should accept valid email login", () => {
    const result = loginSchema.safeParse({
      email: "test@example.com",
      password: "password123",
    });
    expect(result.success).toBe(true);
  });

  it("should accept valid phone login", () => {
    const result = loginSchema.safeParse({
      phone: "+255712345678",
      password: "password123",
    });
    expect(result.success).toBe(true);
  });

  it("should reject empty password", () => {
    const result = loginSchema.safeParse({
      email: "test@example.com",
      password: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("createVideoSchema", () => {
  // The teaser is a SEPARATE asset. Pointing it at the scene itself would put a
  // non-buyer on the same playlist a buyer gets, which is the exact leak the
  // column exists to close — so the schema refuses the shortcut.
  it("rejects a teaser that is the main video", () => {
    const result = createVideoSchema.safeParse({
      title: "Scene with a fake trailer",
      price: 5000,
      teaserDuration: 15,
      bunnyVideoId: "scene-abc",
      teaserBunnyVideoId: "scene-abc",
      complianceAttested: true,
    });

    expect(result.success).toBe(false);
    expect(result.error?.errors[0].path).toContain("teaserBunnyVideoId");
  });

  it("accepts a distinct teaser asset", () => {
    const result = createVideoSchema.safeParse({
      title: "Scene with a real trailer",
      price: 5000,
      teaserDuration: 15,
      bunnyVideoId: "scene-abc",
      teaserBunnyVideoId: "trailer-xyz",
      complianceAttested: true,
    });
    expect(result.success).toBe(true);
  });

  it("accepts no teaser at all — a paid scene may simply have none", () => {
    const result = createVideoSchema.safeParse({
      title: "Scene without a trailer",
      price: 5000,
      teaserDuration: 15,
      bunnyVideoId: "scene-abc",
      complianceAttested: true,
    });
    expect(result.success).toBe(true);
  });

  it("should accept valid video data", () => {
    const result = createVideoSchema.safeParse({
      title: "My First Video",
      description: "A great video",
      price: 1000,
      teaserDuration: 15,
      bunnyVideoId: "abc-123",
      category: "music",
      tags: ["tanzania", "music"],
      complianceAttested: true,
    });
    expect(result.success).toBe(true);
  });

  it("should reject price below minimum", () => {
    const result = createVideoSchema.safeParse({
      title: "My Video",
      price: 50,
      teaserDuration: 15,
      bunnyVideoId: "abc-123",
    });
    expect(result.success).toBe(false);
  });

  it("should reject price below the TZS 500 floor", () => {
    const result = createVideoSchema.safeParse({
      title: "My Video",
      price: 499,
      teaserDuration: 15,
      bunnyVideoId: "abc-123",
      complianceAttested: true,
    });
    expect(result.success).toBe(false);
  });

  it("should reject title too short", () => {
    const result = createVideoSchema.safeParse({
      title: "Hi",
      price: 1000,
      teaserDuration: 15,
      bunnyVideoId: "abc-123",
    });
    expect(result.success).toBe(false);
  });

  it("should reject teaser duration outside range", () => {
    const result = createVideoSchema.safeParse({
      title: "Valid Title",
      price: 1000,
      teaserDuration: 60, // Max is 30
      bunnyVideoId: "abc-123",
    });
    expect(result.success).toBe(false);
  });

  it("should accept minimum values", () => {
    const result = createVideoSchema.safeParse({
      title: "ABC",
      price: 500,
      teaserDuration: 15,
      bunnyVideoId: "test",
      complianceAttested: true,
    });
    expect(result.success).toBe(true);
  });

  it("refuses a price below TZS 500", () => {
    // The floor is 500, not 100: a collect that small is mostly mobile-money
    // fee, so it is not a price the platform can settle.
    const at = (price: number) =>
      createVideoSchema.safeParse({
        title: "ABC",
        price,
        teaserDuration: 15,
        bunnyVideoId: "test",
        complianceAttested: true,
      }).success;

    expect(at(499)).toBe(false);
    expect(at(500)).toBe(true);
  });

  // 18 U.S.C. § 2257 — a video may not be created without the attestation
  it("should reject a video without the 2257 attestation", () => {
    const result = createVideoSchema.safeParse({
      title: "Valid Title",
      price: 1000,
      teaserDuration: 15,
      bunnyVideoId: "abc-123",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors[0].path).toContain("complianceAttested");
    }
  });

  it("should reject a video when the 2257 attestation is false", () => {
    const result = createVideoSchema.safeParse({
      title: "Valid Title",
      price: 1000,
      teaserDuration: 15,
      bunnyVideoId: "abc-123",
      complianceAttested: false,
    });
    expect(result.success).toBe(false);
  });
});

describe("initiatePaymentSchema", () => {
  it("should default to HarakaPay and accept a valid phone", () => {
    const result = initiatePaymentSchema.safeParse({
      videoId: "abc123",
      phoneNumber: "+255712345678",
    });
    expect(result.success).toBe(true);
    expect(result.data?.gateway).toBe("HARAKAPAY");
  });

  it("should accept the HarakaPay gateway explicitly", () => {
    const result = initiatePaymentSchema.safeParse({
      videoId: "abc123",
      gateway: "HARAKAPAY",
      phoneNumber: "0712345678",
    });
    expect(result.success).toBe(true);
  });

  it("should reject a decommissioned gateway", () => {
    const result = initiatePaymentSchema.safeParse({
      videoId: "abc123",
      gateway: "AZAMPAY",
      phoneNumber: "0712345678",
    });
    expect(result.success).toBe(false);
  });

  it("should reject invalid phone", () => {
    const result = initiatePaymentSchema.safeParse({
      videoId: "abc123",
      phoneNumber: "invalid",
    });
    expect(result.success).toBe(false);
  });
});

describe("topUpWalletSchema", () => {
  it("should accept valid top-up", () => {
    const result = topUpWalletSchema.safeParse({
      amount: 5000,
      phoneNumber: "+255712345678",
    });
    expect(result.success).toBe(true);
    expect(result.data?.gateway).toBe("HARAKAPAY");
  });

  it("should reject amount below minimum", () => {
    const result = topUpWalletSchema.safeParse({
      amount: 100,
      provider: "MPESA",
      phoneNumber: "+255712345678",
    });
    expect(result.success).toBe(false);
  });
});

describe("requestPayoutSchema", () => {
  it("should accept valid payout request", () => {
    const result = requestPayoutSchema.safeParse({
      amount: 50000,
      paymentMethod: "MPESA",
      accountDetails: "+255712345678",
    });
    expect(result.success).toBe(true);
  });

  it("should reject amount below minimum payout", () => {
    const result = requestPayoutSchema.safeParse({
      amount: 10000,
      paymentMethod: "MPESA",
      accountDetails: "+255712345678",
    });
    expect(result.success).toBe(false);
  });
});

describe("reportVideoSchema", () => {
  it("should accept valid report", () => {
    const result = reportVideoSchema.safeParse({
      videoId: "abc123",
      reason: "DMCA",
      description: "Copyright infringement",
    });
    expect(result.success).toBe(true);
  });

  it("should accept report without description", () => {
    const result = reportVideoSchema.safeParse({
      videoId: "abc123",
      reason: "SPAM",
    });
    expect(result.success).toBe(true);
  });
});

describe("submitKycSchema", () => {
  it("should accept photos uploaded here", () => {
    const result = submitKycSchema.safeParse({
      idDocumentUrl: "/api/media/private/u1/kyc/id.jpg",
      selfieUrl: "/api/media/private/u1/kyc/selfie.jpg",
      idDocumentType: "NIDA",
    });
    expect(result.success).toBe(true);
  });

  // The form used to offer a "paste an image URL" box beside each picker. A
  // link to somebody else's host is not an identity document we hold: the
  // reviewer sees whatever that host serves at review time, and the audit trail
  // records a URL instead of a file.
  it("refuses a link to a photo hosted somewhere else", () => {
    for (const url of [
      "https://storage.example.com/id.jpg",
      "http://example.com/selfie.jpg",
      "//example.com/id.jpg",
      "not-a-url",
      "/api/media/../../secret",
    ]) {
      const result = submitKycSchema.safeParse({
        idDocumentUrl: url,
        selfieUrl: "/api/media/private/u1/kyc/selfie.jpg",
      });
      expect(result.success, url).toBe(false);
    }
  });

  it("refuses a submission with no photos at all", () => {
    expect(submitKycSchema.safeParse({}).success).toBe(false);
  });
});
