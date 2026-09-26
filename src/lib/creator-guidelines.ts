// =============================================================================
// GENHUB - Creator guidelines
//
// The rules a creator must read and accept BEFORE they can upload, and the
// numbers the platform backs them with. Two reasons this is a module and not
// prose pasted into the upload page:
//
//   1. The upload page renders them, and the server enforces the two that can be
//      measured (duration, and the accountability of a confirmed violation).
//      Both read MIN_VIDEO_DURATION_SECONDS from here, so the screen and the
//      rule cannot drift apart — the failure that produced this file was a rule
//      written in one place and checked in none.
//   2. Bilingual. The audience is Tanzanian creators who read Kiswahili first;
//      an English-only gate is a gate a creator clicks past without reading.
// =============================================================================

/** A paid scene shorter than this never publishes itself. 8 minutes = 480s. */
export const MIN_VIDEO_DURATION_SECONDS = 8 * 60;

/**
 * The withdrawal floor. Also lives in config.business.minPayoutAmount (the
 * server's enforcement point); repeated here so the guideline a creator reads
 * and the number the payout service enforces are recognisably the same one.
 */
export const CREATOR_MIN_WITHDRAWAL_TZS = 30_000;

export interface CreatorGuideline {
  /** Stable id — used as the React key and the acknowledgement receipt. */
  id: string;
  /** Kiswahili text, shown first. */
  sw: string;
  /** English text, shown underneath. */
  en: string;
  /** Emphasised as a hard rule with a stated consequence. */
  severe?: boolean;
}

export const CREATOR_GUIDELINES: CreatorGuideline[] = [
  {
    id: "quality",
    sw: "Rekodi video yenye ubora wa juu (HD) iliyowazi na inayovutia. Video yenye ubora hafifu au isiyoeleweka haitakubaliwa.",
    en: "Record in high quality (HD), clear and attractive. Blurry or unclear video will not be accepted.",
  },
  {
    id: "face",
    sw: "Video LAZIMA ionyeshe sura yako wazi. Kama video haionyeshi sura yako, akaunti yako itafungiwa (banned), hutaweza kutoa pesa uliyoipata, na akaunti yako itafungwa.",
    en: "Your video MUST clearly show YOUR face. A video that does not show your face gets you banned: you cannot withdraw the money you already earned, and your account is blocked.",
    severe: true,
  },
  {
    id: "duration",
    sw: `Video iwe na urefu wa angalau dakika 8 (${MIN_VIDEO_DURATION_SECONDS} sekunde) na kuendelea. Video fupi kuliko hapo haitachapishwa.`,
    en: `Your video must be at least 8 minutes long (${MIN_VIDEO_DURATION_SECONDS} seconds). Anything shorter will not publish.`,
    severe: true,
  },
  {
    id: "story",
    sw: "Video iwe na story fupi inayovutia watazamaji, ili wapende videos zako na uwe na watazamaji wengi.",
    en: "Give the video a short, attractive story so viewers enjoy it, come back, and you build a bigger audience.",
  },
  {
    id: "other-person",
    sw: "Unaruhusiwa kumficha mtu unayerekodi naye (sura yake isionekane), lakini WEWE unatakiwa kuonekana.",
    en: "You may hide the other person you record with, but YOU must be visible.",
  },
  {
    id: "presentation",
    sw: "Video iwe ya kuvutia na muonekano mzuri kama videos nyingine zilizopo kwenye website.",
    en: "The video should look attractive and professional, like the other videos on the site.",
  },
  {
    id: "withdrawal",
    sw: `Utaruhusiwa kutoa (withdraw) pesa zako pale tu salio lako linapofikia TZS ${CREATOR_MIN_WITHDRAWAL_TZS.toLocaleString()} ndipo unaweza kuanza kutoa.`,
    en: `You can withdraw only once your balance reaches TZS ${CREATOR_MIN_WITHDRAWAL_TZS.toLocaleString()}.`,
  },
];

/**
 * The exact text the creator ticks. Stored so a later dispute can show what was
 * agreed to, not just that a button was pressed.
 */
export const GUIDELINE_ACK_LABEL_SW =
  "Nimesoma na nakubaliana na masharti yote ya creators hapo juu.";
export const GUIDELINE_ACK_LABEL_EN =
  "I have read and accept all of the creator guidelines above.";

/**
 * Version of the ruleset. Bumping this invalidates a creator's previous
 * acknowledgement, so a rule that changed is re-read before the next upload —
 * a creation-time receipt nobody re-checks is not consent.
 */
export const CREATOR_GUIDELINES_VERSION = 1;

/** localStorage key holding `{ [userId]: version }` of what each account accepted. */
export const GUIDELINE_ACK_STORAGE_KEY = "genhub.creatorGuidelines.v1";
