// =============================================================================
// GENHUB - Platform settings (operator switches)
// =============================================================================
// A tiny key/value store for switches an admin flips while the site is live.
//
//   videos.all_free     every paid scene plays for everyone (see the paywall)
//   features.uploads    false PAUSES creator uploads without a deploy
//   features.checkout   false PAUSES mobile-money checkout without a deploy
//   site.announcement   a JSON banner { active, message, tone }
//
// READ PATH: every value is read through one cached snapshot, so a request can
// ask for as many as it likes without a round trip each. The cache is per
// process and short on purpose — an admin who flips a switch must see it take
// effect on the next request, not after a redeploy.
//
// FAILURE DIRECTION: if the store cannot be read at all, an error-page pause is
// never the fallback. `videos.all_free` is treated as OFF (paid), while the two
// kill switches are treated as ON (uploads and checkout keep working) — a
// missing row must not silently stop the business. That asymmetry is deliberate:
// opening the catalogue for free is the dangerous direction, closing payments is
// the expensive one, and neither should be a guess.
// =============================================================================

import prisma from "@/lib/db";

export const PLATFORM_SETTING_KEYS = {
  /** "true" while every video is free to watch for everyone. */
  allVideosFree: "videos.all_free",
  /** "false" pauses creator uploads. Absent or anything else = enabled. */
  uploadsEnabled: "features.uploads",
  /** "false" pauses mobile-money checkout. Absent or anything else = enabled. */
  checkoutEnabled: "features.checkout",
  /** JSON: { active: boolean, message: string, tone: "info"|"warning"|"success" } */
  announcement: "site.announcement",
} as const;

export type PlatformSettingKey =
  (typeof PLATFORM_SETTING_KEYS)[keyof typeof PLATFORM_SETTING_KEYS];

/** How long a read is trusted. Short: an operator switch must feel immediate. */
const CACHE_TTL_MS = 5_000;

let cached: { at: number; values: Record<string, string> } | null = null;

async function loadAll(): Promise<Record<string, string>> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.values;

  try {
    const rows = await prisma.platformSetting.findMany({
      select: { key: true, value: true },
    });
    const values = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    cached = { at: Date.now(), values };
    return values;
  } catch {
    // Unreadable store: keep the last snapshot if there is one, otherwise an
    // empty map — and let each reader apply its own safe default below.
    return cached?.values ?? {};
  }
}

/**
 * Is the platform-wide "everything is free" switch on?
 *
 * Fails CLOSED: an unreadable store means paid, never free.
 */
export async function getAllVideosFree(): Promise<boolean> {
  const values = await loadAll();
  return values[PLATFORM_SETTING_KEYS.allVideosFree] === "true";
}

export interface FeatureFlags {
  /** Kill switch for creator uploads. Default ON. */
  uploadsEnabled: boolean;
  /** Kill switch for mobile-money checkout. Default ON. */
  checkoutEnabled: boolean;
}

/**
 * The kill switches.
 *
 * Fails OPEN: only an explicit `"false"` turns either off, so a missing row or
 * an unreadable store leaves the site working. An availability switch that
 * disables itself when it cannot be read is a switch that causes an outage.
 */
export async function getFeatureFlags(): Promise<FeatureFlags> {
  const values = await loadAll();
  return {
    uploadsEnabled: values[PLATFORM_SETTING_KEYS.uploadsEnabled] !== "false",
    checkoutEnabled: values[PLATFORM_SETTING_KEYS.checkoutEnabled] !== "false",
  };
}

/**
 * The banner's colour. `danger` is the loud red one, and it is the default: an
 * announcement exists to be noticed, and a banner that blends into the page is a
 * banner nobody reads ("malipo yamerudi", "tunafanya matengenezo"). The other
 * three stay for the cases where red would be crying wolf — a soft greeting, a
 * scheduled-window note — so `danger` is not forced on every message.
 */
export type AnnouncementTone = "danger" | "info" | "warning" | "success";

const ANNOUNCEMENT_TONES: readonly AnnouncementTone[] = [
  "danger",
  "info",
  "warning",
  "success",
];

/**
 * A stored tone, or the red default.
 *
 * Anything unrecognised — an older row, a hand-edited value, a typo — becomes
 * `danger` rather than `info`. The failure this avoids: an operator publishes a
 * warning, the tone is not one we know, and it renders as a quiet blue note.
 */
export function normalizeAnnouncementTone(value: unknown): AnnouncementTone {
  return ANNOUNCEMENT_TONES.includes(value as AnnouncementTone)
    ? (value as AnnouncementTone)
    : "danger";
}

export interface Announcement {
  active: boolean;
  message: string;
  tone: AnnouncementTone;
}

const NO_ANNOUNCEMENT: Announcement = { active: false, message: "", tone: "danger" };

/** The site-wide banner an admin sets, or an inactive one. Parse failures are inactive. */
export async function getAnnouncement(): Promise<Announcement> {
  const values = await loadAll();
  const raw = values[PLATFORM_SETTING_KEYS.announcement];
  if (!raw) return NO_ANNOUNCEMENT;

  try {
    const parsed = JSON.parse(raw) as Partial<Announcement>;
    return {
      active: parsed.active === true,
      message: typeof parsed.message === "string" ? parsed.message.slice(0, 500) : "",
      tone: normalizeAnnouncementTone(parsed.tone),
    };
  } catch {
    return NO_ANNOUNCEMENT;
  }
}

/** Write one setting and drop the cache so the next request sees it at once. */
export async function setSetting(
  key: PlatformSettingKey,
  value: string,
  updatedBy: string | null
): Promise<void> {
  await prisma.platformSetting.upsert({
    where: { key },
    create: { key, value, updatedBy },
    update: { value, updatedBy },
  });
  cached = null;
}

/** Flip the all-videos-free switch. */
export async function setAllVideosFree(free: boolean, updatedBy: string | null): Promise<void> {
  await setSetting(PLATFORM_SETTING_KEYS.allVideosFree, free ? "true" : "false", updatedBy);
}

/**
 * Drop the cached answer. Exported for tests, which share one process and would
 * otherwise carry a switch from one case into the next.
 */
export function invalidatePlatformSettingCache(): void {
  cached = null;
}
