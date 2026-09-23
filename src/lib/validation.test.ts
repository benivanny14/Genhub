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
      email: "test@example.com",
      password: "password123",
      role: "VIEWER",
      locale: "sw",
    });
    expect(result.success).toBe(true);
  });

  it("should accept valid registration with phone", () => {
    const result = registerSchema.safeParse({
      displayName: "Test User",
      phone: "+255712345678",
      password: "password123",
      role: "CREATOR",
    });
    expect(result.success).toBe(true);
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

  it("should reject invalid phone number", () => {
    const result = registerSchema.safeParse({
      displayName: "Test User",
      phone: "12345",
      password: "password123",
    });
    expect(result.success).toBe(false);
  });

  it("should reject when both email and phone are missing", () => {
    const result = registerSchema.safeParse({
      displayName: "Test User",
      password: "password123",
    });
    expect(result.success).toBe(false);
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
      price: 100,
      teaserDuration: 15,
      bunnyVideoId: "test",
      complianceAttested: true,
    });
    expect(result.success).toBe(true);
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
  it("should accept valid KYC submission", () => {
    const result = submitKycSchema.safeParse({
      idDocumentUrl: "https://storage.example.com/id.jpg",
      selfieUrl: "https://storage.example.com/selfie.jpg",
      idDocumentType: "NIDA",
    });
    expect(result.success).toBe(true);
  });

  it("should reject invalid URLs", () => {
    const result = submitKycSchema.safeParse({
      idDocumentUrl: "not-a-url",
      selfieUrl: "https://storage.example.com/selfie.jpg",
    });
    expect(result.success).toBe(false);
  });
});
