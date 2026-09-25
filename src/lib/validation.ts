// =============================================================================
// GENHUB - Request Validation Schemas
// Uses Zod for type-safe input validation
// =============================================================================

import { z } from "zod";
import { MEDIA_ROUTE_PREFIX, isSafeMediaKey } from "./media";

/**
 * A URL that we uploaded ourselves, or a plain external one.
 *
 * Uploads come back as an in-app path (`/api/media/...`), which `z.string().url()`
 * rejects — so a form could upload an image successfully and then be refused by
 * its own schema. Paths are still constrained: they must start with
 * `/api/media/` and the rest must be a safe media key, so this is not a licence
 * to store `javascript:` or a protocol-relative `//evil.example`.
 *
 * Declared above the schemas that use it: `z.object({...})` runs at module
 * evaluation, so a helper defined lower down would throw a TDZ error on import.
 */
export function mediaOrExternalUrl(label: string) {
  return z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .refine(
      (value) =>
        value.startsWith(MEDIA_ROUTE_PREFIX)
          ? isSafeMediaKey(value.slice(MEDIA_ROUTE_PREFIX.length))
          : z.string().url().safeParse(value).success,
      { message: `Enter a valid ${label}` }
    );
}

// =============================================================================
// Auth Schemas
// =============================================================================

export const registerSchema = z.object({
  displayName: z.string().min(2, "Name must be at least 2 characters").max(50),
  email: z.string().email("Enter a valid email address").optional(),
  phone: z
    .string()
    .regex(/^(\+255|0)[67]\d{8}$/, "Enter a valid phone number")
    .optional(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  role: z.enum(["VIEWER", "CREATOR"]).default("VIEWER"),
  locale: z.enum(["sw", "en"]).default("sw"),
  referralCode: z.string().trim().max(32).optional(),
}).refine((data) => data.email || data.phone, {
  message: "An email address or phone number is required",
});

export const loginSchema = z.object({
  email: z.string().email().optional(),
  phone: z.string().optional(),
  password: z.string().min(1, "Password is required"),
}).refine((data) => data.email || data.phone, {
  message: "An email address or phone number is required",
});

// =============================================================================
// Video Schemas
// =============================================================================

export const createVideoSchema = z.object({
  title: z.string().min(3, "Title must be at least 3 characters").max(200),
  description: z.string().max(5000).optional(),
  price: z
    .number()
    .int()
    .min(100, "The price must be at least TZS 100")
    .max(1000000, "The price cannot exceed TZS 1,000,000"),
  teaserDuration: z.number().int().min(15).max(30).default(15),
  category: z.string().optional(),
  tags: z.array(z.string()).max(10).optional(),
  bunnyVideoId: z.string().min(1, "A video ID is required"),
  // Optional trailer clip. A paid scene with no trailer shows a poster instead
  // of a playable preview, because a Bunny token cannot limit how much of the
  // main video it unlocks (see resolveTeaserUrl).
  teaserBunnyVideoId: z.string().min(1, "The teaser ID cannot be empty").optional(),
  thumbnailUrl: mediaOrExternalUrl("thumbnail URL").optional(),
  // 18 U.S.C. § 2257 — the uploader must affirm this before content is stored.
  complianceAttested: z
    .boolean({
      required_error:
        "You must confirm that every performer is an adult (18+) and that age records are kept",
      invalid_type_error: "The 2257 attestation is missing",
    })
    .refine((v) => v === true, {
      message:
        "You must confirm that every performer is an adult (18+) and that age records are kept",
    }),
})
  // Pointing the trailer at the scene itself would recreate exactly the leak the
  // teaser column exists to close: non-buyers would be signed into the whole
  // video. One Bunny asset may be a scene or a trailer, never both.
  .refine((v) => !v.teaserBunnyVideoId || v.teaserBunnyVideoId !== v.bunnyVideoId, {
    message: "The teaser must be a different video from the main video",
    path: ["teaserBunnyVideoId"],
  });

/**
 * A WebVTT captions file the player can hand to a <track> element.
 *
 * Accepts three shapes and nothing else:
 *   ""                        remove the captions that were attached
 *   /api/media/...vtt         a file uploaded through our own upload route
 *   https://...vtt            a file hosted elsewhere (Bunny Storage, a CDN)
 *
 * `.vtt` is REQUIRED, not cosmetic. A browser given an .srt file plays nothing
 * and reports no error, so a creator who attached subtitles would believe they
 * had published them — the failure mode is silence, and silence is the one thing
 * captions exist to fix. Rejecting it here is the only place the creator finds
 * out while they can still do something about it.
 */
export const captionsUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine(
    (value) => {
      if (value === "") return true;
      const isVtt = /\.vtt(\?.*)?$/i.test(value);
      if (!isVtt) return false;
      return value.startsWith(MEDIA_ROUTE_PREFIX)
        ? isSafeMediaKey(value.slice(MEDIA_ROUTE_PREFIX.length).split("?")[0])
        : /^https:\/\//i.test(value);
    },
    {
      message:
        "Captions must be a .vtt (WebVTT) file — upload one, or paste an https:// link that ends in .vtt",
    }
  );

export const updateVideoSchema = z.object({
  title: z.string().min(3).max(200).optional(),
  description: z.string().max(5000).optional(),
  // 0 is allowed here and only here: the edit form offers "0 makes it free",
  // and it used to be a promise the schema broke with "must be >= 100". A
  // creator can therefore turn a scene free after the fact; uploads still
  // require a price, because a price is the one decision made at upload time
  // that cannot be undone for buyers who already paid.
  price: z
    .number()
    .int()
    .min(0, "The price cannot be negative")
    .max(1000000, "The price cannot exceed TZS 1,000,000")
    .optional(),
  teaserDuration: z.number().int().min(15).max(30).optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).max(10).optional(),
  isPublished: z.boolean().optional(),
  teaserBunnyVideoId: z.string().min(1).optional(),
  thumbnailUrl: mediaOrExternalUrl("thumbnail URL").optional(),
  // Edit-only, like the price: the upload flow has no captions step, and
  // captions are usually written after a scene is already live. "" clears them.
  captionsUrl: captionsUrlSchema.optional(),
});

// =============================================================================
// Payment Schemas
// HarakaPay is the only gateway: checkout is a USSD push to the customer's
// phone number, so the mobile network is resolved from the number itself.
// =============================================================================

export const initiatePaymentSchema = z
  .object({
    videoId: z.string().min(1),
    gateway: z.enum(["HARAKAPAY"]).default("HARAKAPAY"),
    // PHONE = HarakaPay USSD push (default). WALLET = spend the existing balance.
    method: z.enum(["PHONE", "WALLET"]).default("PHONE"),
    phoneNumber: z
      .string()
      .regex(/^(\+255|0)[67]\d{8}$/, "Enter a valid phone number (for example 0712345678)")
      .optional(),
    email: z.string().email().optional(),
    couponCode: z.string().trim().max(32).optional(),
  })
  .refine((data) => data.method !== "PHONE" || !!data.phoneNumber, {
    message: "A phone number is required for mobile money payments",
    path: ["phoneNumber"],
  });

export const topUpWalletSchema = z.object({
  amount: z.number().int().min(500, "The minimum amount is TZS 500").max(5000000),
  gateway: z.enum(["HARAKAPAY"]).default("HARAKAPAY"),
  phoneNumber: z
    .string()
    .regex(/^(\+255|0)[67]\d{8}$/, "Enter a valid phone number (for example 0712345678)"),
  couponCode: z.string().trim().max(32).optional(),
});

export const tipCreatorSchema = z.object({
  creatorId: z.string().min(1),
  amount: z.number().int().min(500, "The minimum tip is TZS 500").max(100000),
  phoneNumber: z.string().regex(/^(\+255|0)[67]\d{8}$/),
  message: z.string().max(500).optional(),
});

// =============================================================================
// KYC Schema
// =============================================================================

export const submitKycSchema = z.object({
  idDocumentUrl: mediaOrExternalUrl("ID document URL"),
  selfieUrl: mediaOrExternalUrl("selfie URL"),
  idDocumentType: z.enum(["NIDA", "PASSPORT", "DRIVING_LICENSE"]).optional(),
});

// =============================================================================
// Payout Request Schema
// =============================================================================

export const requestPayoutSchema = z.object({
  amount: z.number().int().min(30000, "The minimum is TZS 30,000"),
  paymentMethod: z.enum(["MPESA", "TIGO_PESA", "AIRTEL_MONEY", "BANK_TRANSFER"]),
  accountDetails: z.string().min(5, "Account details are required"),
  bankName: z.string().optional(),
});

// =============================================================================
// Admin Schemas
// =============================================================================

export const reviewKycSchema = z.object({
  kycId: z.string().min(1),
  status: z.enum(["APPROVED", "REJECTED"]),
  rejectionReason: z.string().optional(),
});

export const moderateVideoSchema = z.object({
  reportId: z.string().min(1),
  action: z.enum(["HIDDEN", "FROZEN_EARNINGS", "WARNING", "BANNED", "DISMISSED"]),
  reason: z.string().min(1, "A reason is required"),
});

// =============================================================================
// Report Schema
// =============================================================================

export const reportVideoSchema = z.object({
  videoId: z.string().min(1),
  reason: z.enum(["DMCA", "INAPPROPRIATE", "SPAM", "VIOLENCE", "OTHER"]),
  description: z.string().max(2000).optional(),
});

// =============================================================================
// Coupon Schema (admin)
// =============================================================================

export const createCouponSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(3, "A coupon must be at least 3 characters")
      .max(32)
      .regex(/^[A-Za-z0-9_-]+$/, "A coupon may only contain letters and numbers"),
    type: z.enum(["PERCENT", "FIXED"]).default("PERCENT"),
    value: z.number().int().min(1, "The value must be 1 or more"),
    maxUses: z.number().int().min(1).max(1000000).optional(),
    expiresInDays: z.number().int().min(1).max(3650).optional(),
  })
  .refine((d) => d.type !== "PERCENT" || d.value <= 100, {
    message: "A percentage cannot exceed 100",
  });

// =============================================================================
// Coupon validation at checkout (purchase / top-up)
// =============================================================================

export const validateCouponSchema = z.object({
  code: z.string().trim().min(1).max(32),
  amount: z.number().int().min(0),
  context: z.enum(["purchase", "topup"]).default("purchase"),
});

// =============================================================================
// Creator status post (timeline)
// =============================================================================

export const creatorPostSchema = z.object({
  body: z.string().trim().min(1, "The message cannot be empty").max(1000),
  imageUrl: z.string().url().optional(),
});

// =============================================================================
// Type exports
// =============================================================================

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreateVideoInput = z.infer<typeof createVideoSchema>;
export type UpdateVideoInput = z.infer<typeof updateVideoSchema>;
export type InitiatePaymentInput = z.infer<typeof initiatePaymentSchema>;
export type TopUpWalletInput = z.infer<typeof topUpWalletSchema>;
export type SubmitKycInput = z.infer<typeof submitKycSchema>;
export type RequestPayoutInput = z.infer<typeof requestPayoutSchema>;
