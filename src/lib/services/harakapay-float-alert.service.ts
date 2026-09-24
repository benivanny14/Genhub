// =============================================================================
// GENHUB - Say the float is running out while there is still time to top up
//
// HarakaPay settles a USSD prompt out of a prepaid float on the merchant
// account. At 0 the gateway does not refuse: it accepts the collect, answers
// "USSD push sent", and never delivers the prompt. The customer taps Pay on a
// screen that says it worked, nothing arrives, and the merchant finds out from a
// complaint — this deployment's first one is in the bell ("Wallet top-up — TZS
// 1,000 did not go through. The USSD prompt was never approved").
//
// The service probe already reports float 0 as a hard failure, and that is
// correct but late: by then customers are already being turned away. Topping the
// float up means moving money onto the merchant account, which takes minutes at
// best and a business day at worst, so the alarm has to fire on the way *down* —
// at a floor the operator chooses, not at the bottom.
//
// Three rules, the same three the overdue-worker alert follows
// (cron-hold-alert.service.ts):
//
//   * One row per window. The supervisor pokes this every ten minutes, and a
//     warning that arrives that often is a warning somebody mutes. The record in
//     the bell is the throttle, not process memory: on serverless hosting each
//     instance would keep its own cooldown and mail the same operator once per
//     instance.
//   * Never throw. This runs inside the poke that also starts the workers, so a
//     balance call that times out may cost the alarm and must not cost the poke.
//   * "Could not read the balance" is not "the balance is fine". A gateway that
//     will not answer is reported as unreadable, which is a different fact from a
//     healthy float and must never be dressed up as one.
// =============================================================================

import prisma from "@/lib/db";
import config from "@/lib/config";
import { sendMail } from "@/lib/email";
import { formatTZS } from "@/lib/utils";
import { harakaBalance, type HarakaBalanceResponse } from "@/lib/payments/harakapay";

/**
 * How long before the same operator is told again.
 *
 * Twelve hours: long enough that a float can sit low across a working day
 * without filling the bell, short enough that somebody who reads it in the
 * morning and tops up in the afternoon still gets one reminder if they forget.
 */
export const FLOAT_ALERT_WINDOW_MS = 12 * 60 * 60_000;

/** Where the notification and the email send the reader. */
export const FLOAT_ALERT_LINK = "/admin";

/**
 * The bell line, and deliberately the *same* line for both levels.
 *
 * It is the throttle key: if "empty" and "low" had their own titles, a float that
 * crossed the floor and then ran out inside one window would write two rows and
 * send two emails about one problem. The severity belongs in the message, which
 * is read; the title is the identity of the alert.
 */
export const FLOAT_ALERT_TITLE = "HarakaPay float is running out";

/** How bad the float is. `empty` is the state customers cannot pay in. */
export type FloatLevel = "ok" | "low" | "empty";

/**
 * The floor used when `HARAKAPAY_FLOAT_FLOOR_TZS` is unset, zero or unreadable.
 *
 * A starting point rather than a measurement: pre-launch there is no traffic to
 * derive it from, and the right number is "enough float to keep taking payments
 * until somebody can top it up". Ten thousand shillings is a few subscriptions
 * and a few top-ups — the operator tunes it once they know their own pace.
 */
export const DEFAULT_FLOAT_FLOOR_TZS = 10_000;

/**
 * The floor the operator considers too low, in TZS.
 *
 * There is no "off" value, on purpose. A floor of 0 would mean "say nothing
 * until the float is gone", which is the state this file exists to arrive at
 * early — an operator who wants exactly that sets 1, and one warning still
 * fires when the float is empty.
 */
export function floatFloorTzs(): number {
  const configured = config.harakaPay.floatFloorTzs;
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_FLOAT_FLOOR_TZS;
}

/** What the gateway said, in numbers, with the floor to judge it against. */
export interface FloatSnapshot {
  /** The prepaid balance the gateway delivers USSD prompts from, in TZS. */
  floatTzs: number;
  /** What the merchant account can pay creators out of, in TZS. */
  walletTzs: number;
  /** The number the operator considers too low. */
  floorTzs: number;
}

/**
 * Where the float sits relative to the floor.
 *
 * Pure, so the boundary is pinned by a test rather than discovered in
 * production: at the floor exactly it is fine (the floor is the last safe
 * number, not the first bad one), one TZS under it is a warning, and 0 is the
 * state that silently eats payments. A non-number reads as `empty` because the
 * only caller that can pass one has already refused to (see `readBalance`).
 */
export function assessFloat(floatTzs: number, floorTzs: number): FloatLevel {
  if (!(floatTzs > 0)) return "empty";
  return floatTzs < floorTzs ? "low" : "ok";
}

export interface FloatAlertCopy {
  /** The bell line — the throttle key, so it does not vary by level. */
  title: string;
  message: string;
  emailSubject: string;
  emailText: string;
  emailHtml: string;
}

/**
 * What the alert says.
 *
 * Pure. Two things it must always carry: the number the operator has to act on
 * (the float now, against the floor they set), and what to do about it — an alert
 * that names a problem without an action is a notification somebody reads and
 * closes. It cannot deep-link to the top-up itself: that happens on the
 * operator's HarakaPay account, not here, so the link goes to the screen they can
 * verify it from afterwards.
 */
export function floatAlertCopy(
  level: Exclude<FloatLevel, "ok">,
  snapshot: FloatSnapshot,
  appUrl: string
): FloatAlertCopy {
  const adminUrl = `${appUrl.replace(/\/$/, "")}${FLOAT_ALERT_LINK}`;
  const empty = level === "empty";

  const title = FLOAT_ALERT_TITLE;
  const message = empty
    ? `The gateway float is ${formatTZS(0)}. It still accepts a collect and answers ` +
      `"USSD push sent", but the prompt never reaches the customer's phone, so nothing ` +
      `settles. Top up the HarakaPay merchant float, then check ${adminUrl}.`
    : `The gateway float is ${formatTZS(snapshot.floatTzs)}, under the ` +
      `${formatTZS(snapshot.floorTzs)} floor you set. Payments work today; at 0 they ` +
      `stop arriving without ever being refused. Top up the HarakaPay merchant float, ` +
      `then check ${adminUrl}.`;

  const emailSubject = empty
    ? "[Genhub] HarakaPay float is EMPTY — customers cannot pay"
    : `[Genhub] HarakaPay float is down to ${formatTZS(snapshot.floatTzs)}`;

  const action =
    "Top up the float on the HarakaPay merchant account. Nothing in the app can do " +
    `this, and until it is done the gateway keeps taking orders it cannot deliver. ` +
    `Verify afterwards on ${adminUrl}.`;

  const emailText = [
    empty
      ? "The HarakaPay float is 0 TZS."
      : `The HarakaPay float is ${formatTZS(snapshot.floatTzs)}, under the ${formatTZS(
          snapshot.floorTzs
        )} floor you set.`,
    "",
    ...(empty
      ? [
          'At 0 the gateway does not refuse a payment: it accepts the collect, answers',
          '"USSD push sent", and never delivers the prompt. The customer is told it',
          "worked and the order never settles.",
          "",
        ]
      : []),
    `Float: ${formatTZS(snapshot.floatTzs)} · Floor: ${formatTZS(snapshot.floorTzs)} · ` +
      `Merchant wallet: ${formatTZS(snapshot.walletTzs)}`,
    "",
    action,
    "",
    `You will be reminded at most once every ${FLOAT_ALERT_WINDOW_MS / 3600_000} hours.`,
  ].join("\n");

  const emailHtml = `
  <div style="font-family:Arial,Helvetica,sans-serif;background:#0b0b14;padding:32px">
    <div style="max-width:520px;margin:auto;background:#15151f;border:1px solid #2a2a3d;border-radius:16px;padding:32px">
      <div style="font-size:20px;font-weight:bold;color:#f59e0b;margin-bottom:16px">${
        empty ? "Payments are not arriving" : "The gateway float is running low"
      }</div>
      <p style="color:#e5e7eb;font-size:15px;line-height:1.6">
        HarakaPay float: <strong>${formatTZS(snapshot.floatTzs)}</strong>
        (floor ${formatTZS(snapshot.floorTzs)}, wallet ${formatTZS(snapshot.walletTzs)})
      </p>
      <p style="color:#9ca3af;font-size:14px;line-height:1.6">
        ${
          empty
            ? 'At 0 the gateway does not refuse a payment — it accepts the collect, answers "USSD push sent", and never delivers the prompt. The customer is told it worked.'
            : "Payments work today. At 0 the gateway keeps accepting orders it cannot deliver, and nothing tells the customer."
        }
      </p>
      <p style="color:#e5e7eb;font-size:15px;line-height:1.6">${action}</p>
      <p style="color:#6b7280;font-size:12px;margin-top:24px">
        This reminder repeats at most once every ${FLOAT_ALERT_WINDOW_MS / 3600_000} hours.
      </p>
    </div>
  </div>`;

  return { title, message, emailSubject, emailText, emailHtml };
}

export interface FloatAlertOutcome {
  /** Somebody was told on this poke. */
  alerted: boolean;
  /** Correctly silent: somebody was told inside the window. Not a problem. */
  alreadyTold: boolean;
  /** The record or the mail host refused, so nobody was reached. */
  failed: boolean;
  /** True when there is no admin account, so nothing could be sent anywhere. */
  noAdmins: boolean;
  /** Admin notifications actually written (one per admin). */
  notifications: number;
  /** Emails handed to the mailer (best effort — delivery is not guaranteed). */
  emails: number;
}

const NOTHING_TO_DO: FloatAlertOutcome = {
  alerted: false,
  alreadyTold: false,
  failed: false,
  noAdmins: false,
  notifications: 0,
  emails: 0,
};

/**
 * Tell every admin the float is running out.
 *
 * Resolves with what it did and never throws — see the header. The throttle is
 * the notification row itself, so a poke that is one of fourteen in a day writes
 * one row and not fourteen.
 */
export async function alertFloat(
  level: Exclude<FloatLevel, "ok">,
  snapshot: FloatSnapshot,
  deps: { now?: () => number } = {}
): Promise<FloatAlertOutcome> {
  let admins: { id: string; email: string | null }[];
  try {
    admins = await prisma.user.findMany({
      where: { role: "ADMIN" },
      select: { id: true, email: true },
    });
  } catch (error) {
    console.error("[Float Alert] could not read the admin list:", message(error));
    return NOTHING_TO_DO;
  }

  if (admins.length === 0) {
    // Loud on purpose: a float nobody can be told about keeps taking orders it
    // cannot deliver, and the only visible symptom is a customer complaint.
    console.error(
      `[Float Alert] the HarakaPay float is ${snapshot.floatTzs} and no ADMIN ` +
        "account exists, so nobody can be told. Create one with `npm run admin:create`."
    );
    return { ...NOTHING_TO_DO, noAdmins: true };
  }

  const now = deps.now ?? (() => Date.now());
  const copy = floatAlertCopy(level, snapshot, config.appUrl);
  const since = new Date(now() - FLOAT_ALERT_WINDOW_MS);
  const outcome: FloatAlertOutcome = { ...NOTHING_TO_DO };
  let writeRefused = false;

  for (const admin of admins) {
    try {
      const recent = await prisma.notification.findFirst({
        where: { userId: admin.id, title: copy.title, createdAt: { gt: since } },
        select: { id: true },
      });
      if (recent) continue;

      await prisma.notification.create({
        data: {
          userId: admin.id,
          title: copy.title,
          message: copy.message,
          // `warning` even when empty: the customer-visible failure is today's
          // problem, and the recovery is a top-up somebody has to make — the same
          // shape as an overdue worker, not a crash.
          type: "warning",
          link: FLOAT_ALERT_LINK,
        },
      });
      outcome.alerted = true;
      outcome.notifications += 1;

      if (admin.email) {
        // Best effort by contract: sendMail resolves whether or not the mail host
        // accepted it, and the notification above is already the record.
        await sendMail({
          to: admin.email,
          subject: copy.emailSubject,
          text: copy.emailText,
          html: copy.emailHtml,
        });
        outcome.emails += 1;
      }
    } catch (error) {
      writeRefused = true;
      console.error(`[Float Alert] failed for ${admin.id}:`, message(error));
    }
  }

  if (outcome.alerted) {
    console.error(
      `[Float Alert] told ${outcome.notifications} admin(s) the HarakaPay float is ` +
        `${level} (${snapshot.floatTzs} TZS, floor ${snapshot.floorTzs})`
    );
  } else if (writeRefused) {
    outcome.failed = true;
    console.error(
      `[Float Alert] NOBODY was told the HarakaPay float is ${snapshot.floatTzs} TZS — ` +
        "customers will keep being told their payment was sent"
    );
  } else {
    outcome.alreadyTold = true;
  }

  return outcome;
}

/** What one look at the float came to. */
export interface FloatWatch {
  /**
   * False when the balance could not be read at all.
   *
   * The distinction the whole file turns on: an unreadable balance is not a
   * healthy one, and a report that cannot tell them apart is worse than no report.
   */
  read: boolean;
  level: FloatLevel | null;
  snapshot: FloatSnapshot | null;
  /** Why it could not be read, when `read` is false. */
  note?: string;
  outcome: FloatAlertOutcome | null;
}

/**
 * Read the gateway balance and alert if the float is under the floor.
 *
 * Called from the supervisor's poke, so this is the one place that has to know
 * about both the reading and the telling. A missing or non-numeric `float_balance`
 * is *unreadable*, not zero: reading a field the gateway did not send as "0
 * TZS" would page somebody about a float that is fine, which is how an alarm
 * gets ignored the one time it is right.
 */
export async function watchFloat(
  deps: { read?: () => Promise<HarakaBalanceResponse>; now?: () => number } = {}
): Promise<FloatWatch> {
  const floorTzs = floatFloorTzs();
  let body: HarakaBalanceResponse;

  try {
    const read = deps.read ?? harakaBalance;
    body = await read();
  } catch (error) {
    const note = message(error);
    console.error("[Float Watch] could not read the gateway balance:", note);
    return { read: false, level: null, snapshot: null, note, outcome: null };
  }

  const floatTzs = asAmount(body?.float_balance);
  if (floatTzs === null) {
    console.error(
      "[Float Watch] the gateway answered without a float balance, so the float is unknown"
    );
    return {
      read: false,
      level: null,
      snapshot: null,
      note: "the gateway answered without a float balance",
      outcome: null,
    };
  }

  const snapshot: FloatSnapshot = {
    floatTzs,
    walletTzs: asAmount(body?.wallet_balance) ?? 0,
    floorTzs,
  };
  const level = assessFloat(floatTzs, floorTzs);

  // `ok` costs nothing: no admin read, no row, no mail. The common case must not
  // depend on the database being reachable.
  if (level === "ok") {
    return { read: true, level, snapshot, outcome: null };
  }

  return { read: true, level, snapshot, outcome: await alertFloat(level, snapshot, deps) };
}

function asAmount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function message(error: unknown): string {
  return String((error as Error)?.message || error).slice(0, 200);
}
