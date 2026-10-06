// =============================================================================
// GENHUB - Request Validation Schemas
// Uses Zod for type-safe input validation
// =============================================================================

import { z } from "zod";
import { MEDIA_ROUTE_PREFIX, isSafeMediaKey } from "./media";
// The same 2 GB ceiling the upload form and the transport enforce. One number,
// three places it is checked, so a file that passes the picker cannot be refused
// by the schema that stores it.
import { MAX_VIDEO_BYTES, UPLOAD_FAILURE_REASONS } from "./video-upload";
import { normalizeUsername, usernameFormatError } from "./usernames";

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

/**
 * A file WE stored, and nothing else — no pasted link from another host.
 *
 * Used where the point of the field is that the file was uploaded through
 * /api/upload, into the bucket that belongs to this deployment. An identity
 * document is the case that matters: `mediaOrExternalUrl` would happily accept
 * `https://example.com/some-id.jpg`, which makes the submission a URL anybody
 * can point at anything — the reviewer sees whatever that host serves at review
 * time, the document is not held by us, and the audit trail records a link
 * instead of a file. Photos for KYC come from a phone, so the picker is the only
 * way in and this refuses the rest.
 */
export function ownMediaUrl(label: string) {
  return z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .refine(
      (value) =>
        value.startsWith(MEDIA_ROUTE_PREFIX) &&
        isSafeMediaKey(value.slice(MEDIA_ROUTE_PREFIX.length)),
      { message: `${label} must be a photo uploaded here` }
    );
}

// =============================================================================
// Auth Schemas
// =============================================================================

// The email address is REQUIRED, and there is no phone field.
//
// Signing up with a phone number instead of an email was allowed for a while,
// because that is how many people in Tanzania prefer to be reached. It was taken
// out because the account it produced could not be recovered: password reset has
// no SMS channel (Africa's Talking was never configured, so the text went to a
// console), which left a phone-only account with no way back in short of asking
// the operator. Requiring an email at sign-up is what makes "reset by email" a
// promise the platform can keep. Phone numbers are still accepted at sign-IN,
// for the accounts that predate this rule.
/**
 * The one name nobody else may take.
 *
 * Normalised (trimmed, `@` dropped, lowercased) and then judged by the shared
 * rules in lib/usernames.ts, so the form, the API and the change flow all refuse
 * the same things: too short, too long, invalid characters, or a reserved name.
 * The uniqueness half of the rule cannot live here — it needs the database — so
 * it is enforced by the UNIQUE index and checked in the routes.
 *
 * Its shape half is exported on its own because the change-username route has
 * to recognise "this is already my username" BEFORE the rules above are applied
 * — see /api/account/username.
 */
export const usernameShapeSchema = z
  .string({
    required_error: "Choose a username",
    invalid_type_error: "Choose a username",
  })
  .trim();

export const usernameSchema = usernameShapeSchema
  .transform((value) => normalizeUsername(value))
  // The message is derived from the value that failed, so the field explains
  // exactly what is wrong ("reserved", "too short", "invalid characters")
  // instead of one generic refusal.
  .refine((value) => usernameFormatError(value) === null, (value) => ({
    message: usernameFormatError(value) ?? "Choose a different username",
  }));

/**
 * The one form of an email address this app stores or looks up.
 *
 * `email String? @unique` on PostgreSQL is case-SENSITIVE, so without this
 * `User@Example.com` and `user@example.com` are two different accounts: the
 * second sign-up passes the "already in use" check, and the person who typed a
 * capital letter at sign-up is later told "Incorrect sign-in details" for the
 * same address in lowercase. Every write goes through here; every read matches
 * case-insensitively (see the login, register and forgot-password routes), so
 * accounts created before this rule can still sign in.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * A case-insensitive match on one email address, for a `where` clause.
 *
 * `findUnique` accepts only the exact unique value, so a lookup that must also
 * find a row stored with capitals has to be a `findFirst` with a filter — this
 * keeps that filter identical everywhere it is needed.
 */
export function emailMatch(raw: string) {
  return { email: { equals: normalizeEmail(raw), mode: "insensitive" as const } };
}

export const registerSchema = z.object({
  displayName: z.string().min(2, "Name must be at least 2 characters").max(50),
  // Optional, because the name above IS the username: the route derives the
  // handle from it and numbers the handle when somebody already holds that
  // name (see /api/auth/register). A form that still sends one is treated as
  // having NAMED a handle — its collision is reported rather than numbered.
  //
  // Not `.optional()` alone: a client that clears the field sends `null`, which
  // means "no handle of my own" just as plainly as omitting it does.
  username: usernameSchema.nullish(),
  email: z
    .string()
    .trim()
    .email("Enter a valid email address")
    // Stored lowercase: the column is unique and case-sensitive, so this is what
    // stops the same person ending up with two accounts, and what makes the
    // second sign-up see the first one's row.
    .transform(normalizeEmail),
  password: z.string().min(8, "Password must be at least 8 characters"),
  role: z.enum(["VIEWER", "CREATOR"]).default("VIEWER"),
  locale: z.enum(["sw", "en"]).default("sw"),
  referralCode: z.string().trim().max(32).optional(),
});

// There is deliberately no `changeUsernameSchema` beside this one. Changing a
// handle is the same rules applied to a NEW name, and the route that does it
// needs those rules *after* it has compared the value with the account's
// current handle (see /api/account/username). A second schema wrapping
// `usernameSchema` would let the change flow drift away from the sign-up flow
// without either one failing.

export const loginSchema = z.object({
  email: z.string().email().optional().transform((value) => (value ? normalizeEmail(value) : value)),
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
  // The floor is TZS 500. A price under it is not worth the mobile-money fee
  // that settles it — SonicPesa's cut on a TZS 100 collect is a large fraction
  // of the sale — and the amount a buyer sees has to be a price a creator would
  // actually charge, not a number that cannot pay for itself.
  price: z
    .number()
    .int()
    .min(500, "The price must be at least TZS 500")
    .max(1000000, "The price cannot exceed TZS 1,000,000"),
  teaserDuration: z.number().int().min(15).max(30).default(15),
  category: z.string().optional(),
  tags: z.array(z.string()).max(10).optional(),
  bunnyVideoId: z.string().min(1, "A video ID is required"),
  // Signed by the server when the browser starts the direct Bunny TUS upload.
  // New posts must prove this session belongs to the authenticated creator.
  uploadSessionToken: z.string().min(80).max(20_000).optional(),
  teaserUploadSessionToken: z.string().min(80).max(20_000).optional(),
  // The creator's own file size, so the dashboard can show what the host holds
  // AGAINST what was sent. Optional on purpose: rows created before this
  // existed, and an older client mid-deploy, must still be accepted — the
  // comparison is useful, not required.
  fileSize: z.number().int().positive().max(MAX_VIDEO_BYTES).optional(),
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
  // Scheduling a post. `publishAt` is an ISO timestamp: a future time holds the
  // post unpublished until then, a past one publishes it now. `isDraft` keeps it
  // unpublished with no schedule, for a creator who is not finished. The two are
  // mutually exclusive in spirit — a draft has no time — and the route resolves
  // them in that order.
  isDraft: z.boolean().optional(),
  publishAt: z.string().datetime({ offset: true }).optional(),
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
  // Scheduling / drafts, editable after upload: publish later, or hold as a
  // draft until the creator is ready. `""` in publishAt clears the schedule.
  publishAt: z.union([z.string().datetime({ offset: true }), z.literal("")]).optional(),
  isDraft: z.boolean().optional(),
  teaserBunnyVideoId: z.string().min(1).optional(),
  teaserUploadSessionToken: z.string().min(80).max(20_000).optional(),
  thumbnailUrl: mediaOrExternalUrl("thumbnail URL").optional(),
  // Edit-only, like the price: the upload flow has no captions step, and
  // captions are usually written after a scene is already live. "" clears them.
  captionsUrl: captionsUrlSchema.optional(),
});

// =============================================================================
// Payment Schemas
// SonicPesa is the only gateway: checkout is a USSD push to the customer's
// phone number, so the mobile network is resolved from the number itself.
// =============================================================================

export const initiatePaymentSchema = z
  .object({
    videoId: z.string().min(1),
    gateway: z.enum(["SONICPESA"]).default("SONICPESA"),
    // PHONE = SonicPesa USSD push (default). WALLET = spend the existing balance.
    method: z.enum(["PHONE", "WALLET"]).default("PHONE"),
    phoneNumber: z
      .string()
      .regex(/^(\+255|0)[67]\d{8}$/, "Enter a valid phone number (for example 0712345678)")
      .optional(),
    email: z.string().email().optional(),
    couponCode: z.string().trim().max(32).optional(),
    // Optional, and never the price that gets charged — the charge is always the
    // number on the video row. It is accepted only so a client that sends an
    // amount can be CHECKED against that row and refused when it disagrees; see
    // the AMOUNT_MISMATCH refusal in /api/payments/purchase. Dropping the field
    // silently (what an unknown key does) would leave the same client thinking
    // it had paid one price while another was taken.
    amount: z.number().int().min(0).max(10_000_000).optional(),
  })
  .refine((data) => data.method !== "PHONE" || !!data.phoneNumber, {
    message: "A phone number is required for mobile money payments",
    path: ["phoneNumber"],
  });

export const topUpWalletSchema = z.object({
  amount: z.number().int().min(500, "The minimum amount is TZS 500").max(5000000),
  gateway: z.enum(["SONICPESA"]).default("SONICPESA"),
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
  // ownMediaUrl, not mediaOrExternalUrl: a pasted link to somebody else's host
  // is not an identity document we hold. See ownMediaUrl above.
  idDocumentUrl: ownMediaUrl("ID document"),
  selfieUrl: ownMediaUrl("Selfie"),
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
// A failed video upload, as the creator's browser reports it
//
// The transfer goes straight to Bunny, so the server has no other way to learn
// that one died — see lib/services/upload-failure.service.ts. Every field is
// bounded rather than trusted: the payload is echoed into the admin panel and
// the log, and it arrives from a browser we do not control.
//
// Nothing here is requirable. A report with only a code and a message is still
// worth storing, and a schema that refused it would turn a partial diagnostic
// into no diagnostic at all.
// =============================================================================

export const uploadFailureSchema = z.object({
  /** VideoUploadError.code — NETWORK / HTTP / EXPIRED / CONFLICT / UNKNOWN. */
  code: z.string().trim().min(1).max(40),
  stage: z.enum(["reserve", "chunk", "put"]).nullish(),
  /** Bunny's HTTP status, or null when nothing answered. */
  status: z.number().int().min(0).max(599).nullish(),
  /** What the creator was shown. */
  message: z.string().trim().min(1).max(300),
  /** Bunny's own response body, verbatim — the half that names the cause. */
  providerBody: z.string().max(600).nullish(),
  /** The physical fault, from the closed set the transport can produce. */
  reason: z.enum(UPLOAD_FAILURE_REASONS).nullish(),
  /** The reserved slot, so an operator can find the orphan in the library. */
  bunnyVideoId: z.string().trim().max(64).nullish(),
  fileName: z.string().trim().max(200).nullish(),
  // Twice the ceiling the client enforces: a bound, not a policy.
  fileSize: z.number().int().min(0).max(MAX_VIDEO_BYTES * 2).nullish(),
  bytesSent: z.number().int().min(0).max(MAX_VIDEO_BYTES * 2).nullish(),
  bytesTotal: z.number().int().min(0).max(MAX_VIDEO_BYTES * 2).nullish(),
  offset: z.number().int().min(0).max(MAX_VIDEO_BYTES * 2).nullish(),
  chunkIndex: z.number().int().min(0).max(1_000_000).nullish(),
  retryCount: z.number().int().min(0).max(1000).nullish(),
  // How long each attempt lasted. Bounded in count as well as in value: this is
  // read by a human and rendered by the panel, not graphed.
  attemptMs: z.array(z.number().int().min(0).max(3_600_000)).max(20).nullish(),
  /** What the browser would say about its own link, when it will say anything. */
  connectionType: z.string().trim().max(20).nullish(),
  downlinkMbps: z.number().min(0).max(10_000).nullish(),
  rttMs: z.number().min(0).max(600_000).nullish(),
});

export type UploadFailureInput = z.infer<typeof uploadFailureSchema>;

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
