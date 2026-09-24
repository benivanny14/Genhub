// =============================================================================
// GENHUB - Tell a person when a worker is overdue and the app will not run it
//
// The supervisor (§4.0.4) runs every worker whose schedule has not — except
// `renew-subscriptions`, which can send a USSD charge request to a fan's phone
// and is therefore never started automatically. That refusal is correct, and it
// is also the one case where doing nothing is not an option: a worker nobody is
// told about is indistinguishable from a worker that never ran.
//
// Until now the refusal existed only in a response body, which a human reads
// only if they happen to open the workflow log. So two channels:
//
//   * an admin **notification** — the durable record, in the bell, with the
//     unread count that makes somebody look;
//   * an **email** — the one that reaches a person who is not on the site.
//
// Three rules:
//
//   * Say it ONCE PER WINDOW. The supervisor runs on every poke (about 14 times
//     a day) and a warning that arrives fourteen times is one somebody mutes.
//     The window lives in the notification row rather than in process memory:
//     on serverless hosting each instance would otherwise keep its own cooldown
//     and the same worker would be mailed once per instance.
//   * Never throw. This runs inside a poke that keeps renewals, releases and
//     publishing alive; a mail host that is down must not take that down with it.
//   * Report what it did — including "there was nobody to tell". Silence that
//     looks like success is the failure this whole feature is about.
// =============================================================================

import prisma from "@/lib/db";
import config from "@/lib/config";
import { sendMail } from "@/lib/email";
import type { SupervisorDecision } from "./cron-supervisor.service";

/**
 * How long before the same worker may be reported to the same admin again.
 *
 * Twelve hours: long enough that a worker can stay overdue for a working day
 * without filling the bell, short enough that a night shift notices. The
 * heartbeat's own budget (6 h) is the alarm; this is the pace of the reminder.
 */
export const HOLD_ALERT_WINDOW_MS = 12 * 60 * 60_000;

/** Where the notification and the email send the reader. */
export const HOLD_ALERT_LINK = "/admin";

/**
 * Which held workers are a person's job *right now*.
 *
 * Only `late` — nothing has finished inside the scheduler's budget, and this
 * worker may not be started automatically, so it will not run again until
 * somebody starts it.
 *
 * The other states are deliberately excluded: `never` is a schedule nobody has
 * configured yet (setup work, said loudly on the card), and `stalled` / `failing`
 * mean the worker *is* being triggered and dies when it runs — a job to fix, not
 * a button to press. Alerting on those would put the same words in the bell every
 * poke while changing nothing.
 */
export function workersNeedingAPerson(
  held: readonly SupervisorDecision[]
): SupervisorDecision[] {
  return held.filter((w) => w.state === "late");
}

export interface HoldAlertCopy {
  /** The bell line. Names the worker, so it is readable without the body. */
  title: string;
  message: string;
  emailSubject: string;
  emailText: string;
  emailHtml: string;
}

/**
 * What the alert says.
 *
 * Pure, so the words are pinned by tests rather than discovered in an inbox. Two
 * things they must always carry: *which* worker, and *what to do about it* — an
 * alert that names a problem without an action is a notification somebody reads
 * and closes.
 */
export function holdAlertCopy(worker: SupervisorDecision, appUrl: string): HoldAlertCopy {
  const adminUrl = `${appUrl.replace(/\/$/, "")}${HOLD_ALERT_LINK}`;
  const action =
    `Open ${adminUrl} → Overview → Background jobs and press "Run now" on ` +
    `${worker.name}.`;

  const title = `${worker.name} is overdue — it needs a person to start it`;
  const message = `Nothing has finished inside its budget. ${worker.reason}. ${action}`;

  const emailSubject = `[Genhub] ${worker.name} is overdue — start it by hand`;
  const emailText = [
    `${worker.name} has not finished inside its budget.`,
    "",
    `${worker.reason}.`,
    "",
    action,
    "",
    "The app will not start this worker on its own, and it will keep being",
    `overdue until somebody does. You will be reminded at most once every ${
      HOLD_ALERT_WINDOW_MS / 3600_000
    } hours.`,
  ].join("\n");

  const emailHtml = `
  <div style="font-family:Arial,Helvetica,sans-serif;background:#0b0b14;padding:32px">
    <div style="max-width:520px;margin:auto;background:#15151f;border:1px solid #2a2a3d;border-radius:16px;padding:32px">
      <div style="font-size:20px;font-weight:bold;color:#f59e0b;margin-bottom:16px">A background job needs you</div>
      <p style="color:#e5e7eb;font-size:15px;line-height:1.6">
        <strong>${worker.name}</strong> has not finished inside its budget.
      </p>
      <p style="color:#9ca3af;font-size:14px;line-height:1.6">${worker.reason}.</p>
      <p style="color:#e5e7eb;font-size:15px;line-height:1.6">
        Open <a href="${adminUrl}" style="color:#a78bfa">${adminUrl}</a>, go to
        <strong>Overview → Background jobs</strong> and press <strong>Run now</strong>.
      </p>
      <p style="color:#6b7280;font-size:12px;margin-top:24px">
        The app never starts this worker on its own, so it stays overdue until a
        person starts it. This reminder repeats at most once every ${
          HOLD_ALERT_WINDOW_MS / 3600_000
        } hours.
      </p>
    </div>
  </div>`;

  return { title, message, emailSubject, emailText, emailHtml };
}

export interface HoldAlertOutcome {
  /** Worker ids a person was told about on this poke. */
  alerted: string[];
  /**
   * Held and overdue, and correctly silent: somebody was told inside the window.
   *
   * Distinct from `failed` — this is the throttle working, which is not a problem.
   */
  alreadyTold: string[];
  /**
   * Held and overdue, and nobody was reached: the record or the mail host
   * refused. Not the same fact as `alreadyTold`, and it must never be counted as
   * one — "we chose not to repeat ourselves" and "we could not say it at all"
   * look identical from a log line that lumps them together.
   */
  failed: string[];
  /** True when there is no admin account, so nothing could be sent anywhere. */
  noAdmins: boolean;
  /** Admin notifications actually written (one per admin per worker). */
  notifications: number;
  /** Emails handed to the mailer (best effort — delivery is not guaranteed). */
  emails: number;
}

const NOTHING_TO_DO: HoldAlertOutcome = {
  alerted: [],
  alreadyTold: [],
  failed: [],
  noAdmins: false,
  notifications: 0,
  emails: 0,
};

/**
 * Tell every admin about the workers that are overdue and will not be started.
 *
 * Resolves with what it did, never throws — see the header. Called from the
 * supervisor's poke, so its failure mode has to be "a line in the log", not "the
 * poke that moves money did not happen".
 */
export async function alertHeldWorkers(
  held: readonly SupervisorDecision[],
  deps: { now?: () => number } = {}
): Promise<HoldAlertOutcome> {
  const worth = workersNeedingAPerson(held);
  if (worth.length === 0) return NOTHING_TO_DO;

  let admins: { id: string; email: string | null }[];
  try {
    admins = await prisma.user.findMany({
      where: { role: "ADMIN" },
      select: { id: true, email: true },
    });
  } catch (error) {
    console.error("[Cron Hold Alert] could not read the admin list:", message(error));
    return NOTHING_TO_DO;
  }

  if (admins.length === 0) {
    // Loud on purpose: an overdue worker that cannot be started automatically AND
    // has nobody to tell is the one state this feature exists to make impossible.
    console.error(
      "[Cron Hold Alert] no ADMIN account exists, so nobody can be told that " +
        worth.map((w) => w.id).join(", ") +
        " are overdue. Create one with `npm run admin:create`."
    );
    return { ...NOTHING_TO_DO, noAdmins: true };
  }

  const now = deps.now ?? (() => Date.now());
  const outcome: HoldAlertOutcome = { ...NOTHING_TO_DO, alerted: [], alreadyTold: [], failed: [] };

  for (const worker of worth) {
    const copy = holdAlertCopy(worker, config.appUrl);
    const since = new Date(now() - HOLD_ALERT_WINDOW_MS);
    let toldAnyone = false;
    let writeRefused = false;

    for (const admin of admins) {
      try {
        // The record is the throttle: the same admin already has this worker's
        // alert inside the window, so this poke says nothing.
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
            type: "warning",
            link: HOLD_ALERT_LINK,
          },
        });
        toldAnyone = true;
        outcome.notifications += 1;

        if (admin.email) {
          // Best effort by contract: sendMail resolves whether or not the mail
          // host accepted it, and the notification above is already the record.
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
        console.error(
          `[Cron Hold Alert] failed for ${worker.id} / ${admin.id}:`,
          message(error)
        );
      }
    }

    if (toldAnyone) outcome.alerted.push(worker.id);
    else if (writeRefused) outcome.failed.push(worker.id);
    else outcome.alreadyTold.push(worker.id);
  }

  if (outcome.alerted.length > 0) {
    console.error(
      `[Cron Hold Alert] told ${outcome.notifications} admin(s) that ` +
        `${outcome.alerted.join(", ")} are overdue and must be started by hand`
    );
  }

  if (outcome.failed.length > 0) {
    console.error(
      `[Cron Hold Alert] NOBODY was told about ${outcome.failed.join(", ")} — ` +
        "they are overdue and will not be started automatically"
    );
  }

  return outcome;
}

function message(error: unknown): string {
  return String((error as Error)?.message || error).slice(0, 200);
}
