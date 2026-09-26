// =============================================================================
// GENHUB - Admin audit log
//
// One function, called by every admin route that changes somebody else's
// account, money or content. What it records and why is in the AdminAuditLog
// comment in prisma/schema.prisma; the short version is that the CONSEQUENCE of
// an admin action is not a record of it. `isBanned: true` does not say who
// banned, and `banReason` is overwritten by the next decision, so "who did this
// and why" had no answer anywhere in the system.
//
// -----------------------------------------------------------------------------
// THE ONE RULE: recording must never fail the action.
//
// recordAudit swallows every error. A ban that succeeded must not become a 500
// because the log table was missing or the connection dropped mid-write — the
// admin would retry, and the retry would apply the action twice. The failure is
// printed instead, with the action name, because a silent audit gap is the
// failure this whole file exists to prevent: an operator who cannot see that
// logging is broken will trust a list with holes in it.
//
// Failure to write is therefore loud in the logs and never fatal to the caller.
// =============================================================================

import type { Prisma } from "@prisma/client";
import prisma from "../db";

/** Action codes. Dotted so a filter can ask for `user.` or one exact code. */
export const AUDIT_ACTIONS = {
  userVerify: "user.verify",
  userUnverify: "user.unverify",
  userBan: "user.ban",
  userUnban: "user.unban",
  userWarn: "user.warn",
  userDelete: "user.delete",
  payoutFreeze: "payout.freeze",
  payoutUnfreeze: "payout.unfreeze",
  videoDelete: "video.delete",
  videoHide: "video.hide",
  videoRestore: "video.restore",
  commentDelete: "comment.delete",
  couponCreate: "coupon.create",
  couponToggle: "coupon.toggle",
  payoutApprove: "payout.approve",
  payoutPaid: "payout.paid",
  payoutReject: "payout.reject",
  kycApprove: "kyc.approve",
  kycReject: "kyc.reject",
  reportResolve: "report.resolve",
  reportDismiss: "report.dismiss",
  paymentExpire: "payment.expire",
  paymentGrant: "payment.grant",
  paymentMarkUnpaid: "payment.mark_unpaid",
  paymentRefund: "payment.refund",
  blueTickApprove: "bluetick.approve",
  blueTickReject: "bluetick.reject",
  setupStep: "setup.step",
  jobRun: "job.run",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export interface AuditEntry {
  /** The admin who acted. Taken from requireRole(), never from the request body. */
  actorId: string;
  action: AuditAction | string;
  /** One human sentence. Read during an incident, so it must stand alone. */
  summary: string;
  targetType?: string | null;
  targetId?: string | null;
  detail?: Prisma.InputJsonValue | null;
}

/** A summary is a log line, not an essay — and not a place to smuggle a blob. */
const MAX_SUMMARY = 500;

function normalize(entry: AuditEntry) {
  return {
    actorId: entry.actorId,
    action: entry.action,
    summary: entry.summary.slice(0, MAX_SUMMARY),
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    detail: entry.detail ?? undefined,
  };
}

/**
 * Record an admin action. Never throws — see the header.
 *
 * Rows written OUTSIDE the action's own transaction, on purpose. Joining the
 * transaction would make the log entry roll back with a failed action, which
 * sounds tidy and is not what a log is for: an attempted ban that failed halfway
 * is exactly the thing an operator needs to see.
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await prisma.adminAuditLog.create({ data: normalize(entry) });
  } catch (error) {
    console.error(
      `[Audit] FAILED to record ${entry.action} by ${entry.actorId}:`,
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * The same record, inside the caller's transaction.
 *
 * Provided for the places where the audit row and the change it describes must
 * be one commit — a refund that writes money and its explanation together. It
 * still swallows its error, for the same reason: the caller is mid-transaction,
 * and turning an audit failure into a rollback of a money move helps nobody.
 */
export async function recordAuditIn(
  tx: Prisma.TransactionClient,
  entry: AuditEntry
): Promise<void> {
  try {
    await tx.adminAuditLog.create({ data: normalize(entry) });
  } catch (error) {
    console.error(
      `[Audit] FAILED to record ${entry.action} by ${entry.actorId} (in transaction):`,
      error instanceof Error ? error.message : error
    );
  }
}

export interface AuditListItem {
  id: string;
  action: string;
  summary: string;
  targetType: string | null;
  targetId: string | null;
  detail: unknown;
  createdAt: Date;
  actorId: string;
  /** Resolved by hand: actorId is deliberately not a foreign key. */
  actorName: string | null;
  actorEmail: string | null;
}

/**
 * The newest entries, with the actors' names attached.
 *
 * Two queries rather than a relation, because actorId is not a foreign key —
 * deleting an admin account must not delete the record of what they did. The
 * second query is one `IN` over the distinct ids, so a page of 100 entries costs
 * two round trips, not 101.
 */
export async function listAuditLog(options: {
  action?: string;
  actorId?: string;
  targetId?: string;
  take?: number;
} = {}): Promise<AuditListItem[]> {
  const take = Math.min(Math.max(options.take ?? 100, 1), 500);

  const logs = await prisma.adminAuditLog.findMany({
    where: {
      ...(options.action ? { action: { startsWith: options.action } } : {}),
      ...(options.actorId ? { actorId: options.actorId } : {}),
      ...(options.targetId ? { targetId: options.targetId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take,
  });

  const actorIds = Array.from(new Set(logs.map((l) => l.actorId).filter(Boolean)));
  const actors = actorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, displayName: true, email: true },
      })
    : [];
  const byId = new Map(actors.map((a) => [a.id, a]));

  return logs.map((log) => ({
    id: log.id,
    action: log.action,
    summary: log.summary,
    targetType: log.targetType,
    targetId: log.targetId,
    detail: log.detail ?? null,
    createdAt: log.createdAt,
    actorId: log.actorId,
    actorName: byId.get(log.actorId)?.displayName ?? null,
    actorEmail: byId.get(log.actorId)?.email ?? null,
  }));
}
