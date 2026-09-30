// =============================================================================
// GENHUB - Creator guidelines
//
// The rules a creator must read and accept BEFORE they can upload, and the
// numbers the platform backs them with. Two reasons this is a module and not
// prose pasted into the upload page:
//
//   1. The upload page renders them, and the numbers they quote come from here
//      (the withdrawal floor, the holding period, the recommended length) so the
//      screen and the platform cannot drift apart — the failure that produced
//      this file was a rule written in one place and checked in none.
//
//      The length is GUIDANCE, not a gate: an upload of any duration is accepted,
//      and nothing takes a published video down for being short. It used to be
//      enforced twice — a probe in the upload page and a length check in the
//      encoding lifecycle — which meant a creator who chose a shorter scene lost
//      the upload they had already paid for. Eight minutes is what these
//      guidelines ask for and what performs here, which is why the number is
//      still quoted on this screen and nowhere in a refusal.
//   2. Bilingual. The audience is Tanzanian creators who read Kiswahili first;
//      an English-only gate is a gate a creator clicks past without reading.
// =============================================================================

/**
 * The length these guidelines recommend for a scene. 8 minutes = 480s.
 *
 * A RECOMMENDATION. It is quoted on the guidelines screen and in no refusal:
 * see the header, and note that nothing measures a video against it any more.
 */
export const MIN_VIDEO_DURATION_SECONDS = 8 * 60;

/**
 * The withdrawal floor. Also lives in config.business.minPayoutAmount (the
 * server's enforcement point); repeated here so the guideline a creator reads
 * and the number the payout service enforces are recognisably the same one.
 */
export const CREATOR_MIN_WITHDRAWAL_TZS = 30_000;

/**
 * Days a sale is held before it becomes withdrawable. Mirrors
 * config.business.holdingPeriodDays, and kept here so the guideline that
 * explains the wait reads the same number the release job enforces.
 */
export const HOLDING_PERIOD_DAYS = 14;

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
    sw: `Video inashauriwa kuwa na urefu wa angalau dakika 8 (${MIN_VIDEO_DURATION_SECONDS} sekunde) — urefu huo huwafanya watazamaji wabaki na kupenda video zako. Video fupi pia inaruhusiwa; hakuna video inayokataliwa kwa ajili ya urefu wake.`,
    en: `A video of at least 8 minutes (${MIN_VIDEO_DURATION_SECONDS} seconds) is recommended — that is what holds viewers and builds your audience. Shorter clips are allowed: no video is refused, and none is taken down, because of its length.`,
    // No longer `severe`: a severe rule is one with a stated consequence, and the
    // consequence is gone. Keeping the flag would make the gate that renders it
    // promise a punishment the platform does not carry out.
  },
  {
    id: "clean-set",
    sw: "Chumba unachorekodi kiwe safi, chenye mpangilio na kitasaidia video kuwa nzuri. Video isiwe na uchafu wowote unaoonekana — kama vile vinyesi, taka, nguo chafu au kitu chochote kisichopendeza. Video yenye uchafu haitakubaliwa.",
    en: "Record in a clean, tidy room. Nothing unpleasant may be visible on camera — mucus, rubbish, dirty linen or anything else that spoils the video. A dirty-looking video will not be accepted.",
    severe: true,
  },
  {
    id: "lighting",
    sw: "Chumba kiwe na mwanga wa kutosha (mwanga wa asili au taa nzuri) ili video itoke clean, wazi na yenye rangi ya kuvutia. Video yenye giza au ukungu haitakubaliwa.",
    en: "Light the room well — daylight or proper lamps — so the video comes out clean, bright and clear. Dark or murky video will not be accepted.",
  },
  {
    id: "story",
    sw: "Video iwe na story fupi inayovutia watazamaji, ili wapende videos zako na uwe na watazamaji wengi.",
    en: "Give the video a short, attractive story so viewers enjoy it, come back, and you build a bigger audience.",
  },
  {
    id: "audience",
    sw: "Jitangaze pia kwenye mitandao mingine (Instagram, TikTok, X, Facebook n.k.) ukijijenga kama creator wa Genhub. Kadri unavyojulikana huko, watazamaji wengi huja kuangalia video zako hapa — mauzo ya video zako yanaongezeka, na unapata watazamaji wengi na pesa nyingi kwa wakati mmoja.",
    en: "Promote yourself on other platforms too (Instagram, TikTok, X, Facebook, and so on) as a Genhub creator. The more people know you there, the more viewers come here to watch your videos — your sales grow, and you gain many viewers and long money at the same time.",
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
  {
    id: "holding",
    sw: `Pesa yako inaingia akaunti yako mara moja, lakini kila malipo hukaa siku ${HOLDING_PERIOD_DAYS} (kipindi cha mwanunuzi kurudisha pesa) kabla ya kuwa Available. Siku ${HOLDING_PERIOD_DAYS} ni kwa kila malipo yenyewe — sio siku ${HOLDING_PERIOD_DAYS} moja kwa akaunti yako yote: ukiuza kila siku, baada ya siku ${HOLDING_PERIOD_DAYS} pesa huanza kufunguka kila siku. Kutoa (withdraw) hakusubiri siku ${HOLDING_PERIOD_DAYS}; unatoa Available yoyote mara tu inapofikia TZS ${CREATOR_MIN_WITHDRAWAL_TZS.toLocaleString()}.`,
    en: `Your money reaches your account immediately, but each sale is held for ${HOLDING_PERIOD_DAYS} days (the window a buyer can dispute it in) before it becomes Available. The ${HOLDING_PERIOD_DAYS} days attach to each sale — not one ${HOLDING_PERIOD_DAYS}-day wait for the whole account: sell daily and after ${HOLDING_PERIOD_DAYS} days money starts unlocking every day. Withdrawals do not wait ${HOLDING_PERIOD_DAYS} days: withdraw any Available balance once it reaches TZS ${CREATOR_MIN_WITHDRAWAL_TZS.toLocaleString()}.`,
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
export const CREATOR_GUIDELINES_VERSION = 4;

/**
 * True when an account's accepted version is behind the rules as they stand
 * now, so the guidelines must be shown and ticked again. This is the whole point
 * of the version number: bump it and every creator who accepted the previous
 * wording is asked again.
 *
 * The acceptance is stored on the account (`User.guidelinesAcceptedVersion`),
 * not in the browser, so the gate is the same on every device — a receipt in
 * localStorage alone let a creator who accepted on their phone sail past the
 * new rules on their laptop.
 */
export function needsGuidelineAcceptance(
  acceptedVersion: number | null | undefined
): boolean {
  return (acceptedVersion ?? 0) < CREATOR_GUIDELINES_VERSION;
}
