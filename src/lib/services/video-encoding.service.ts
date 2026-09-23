// =============================================================================
// GENHUB - Video encoding lifecycle (Bunny Stream)
//
// The problem this solves: Bunny accepts an upload within seconds of the first
// byte, and reports success. Transcoding then takes minutes. Anything that
// publishes on "upload succeeded" puts a player with no manifest in front of
// paying viewers, and the creator has no way to know their scene is not actually
// live yet.
//
// So a Bunny-hosted video is held back until Bunny says it can play, and the
// creator is told once — not once per poll — when it is ready.
//
// Observed against the live API while this was written:
//   a fresh slot                 -> status 0
//   after a complete upload      -> status 2, encodeProgress 0
// "Finished" is therefore detected from EITHER signal (status 4 or progress
// 100) rather than trusting one number, because a single wrong constant here
// would hold every video back forever.
// =============================================================================

import prisma from "@/lib/db";
import {
  BUNNY_TUS_ENDPOINT,
  createVideoUpload,
  deleteBunnyVideo,
  getBunnyVideoDetails,
  isBunnyConfigured,
} from "@/lib/bunny";

export type EncodingState = "pending" | "processing" | "ready" | "failed" | "untracked";

/** Bunny's own status codes, for the raw number shown to admins. */
export const BUNNY_STATUS_LABELS: Record<number, string> = {
  0: "Queued",
  1: "Uploaded",
  2: "Processing",
  3: "Transcoding",
  4: "Finished",
  5: "Error",
};

/** Bunny sends 1 (queued-ish) either side of an upload; both are "not playable yet". */
const BUNNY_STATUS_ERROR = 5;
const BUNNY_STATUS_FINISHED = 4;

export interface EncodingSnapshot {
  state: EncodingState;
  /** Bunny's raw code, or null when this row is not tracked. */
  status: number | null;
  progress: number;
  label: string;
  error: string | null;
}

/**
 * Map Bunny's raw numbers to something the product can act on.
 *
 * `ready` when Bunny says finished OR when it reports 100% — the two are checked
 * together so a shifted code cannot silently strand every future upload.
 */
export function describeEncoding(
  status: number | null | undefined,
  progress: number | null | undefined
): EncodingSnapshot {
  const percent = Math.max(0, Math.min(100, Number(progress) || 0));

  if (status === null || status === undefined) {
    return { state: "untracked", status: null, progress: 0, label: "Not tracked", error: null };
  }

  if (status === BUNNY_STATUS_ERROR) {
    return {
      state: "failed",
      status,
      progress: percent,
      label: BUNNY_STATUS_LABELS[status] ?? "Error",
      error: null,
    };
  }

  if (status === BUNNY_STATUS_FINISHED || percent >= 100) {
    return {
      state: "ready",
      status,
      progress: percent,
      label: BUNNY_STATUS_LABELS[status] ?? "Ready",
      error: null,
    };
  }

  return {
    state: status <= 1 ? "pending" : "processing",
    status,
    progress: percent,
    label: BUNNY_STATUS_LABELS[status] ?? "Processing",
    error: null,
  };
}

/**
 * Bunny's own failure text, if it left any. `transcodingMessages` is the only
 * place the real reason appears (bad codec, corrupt file), and a creator cannot
 * fix a problem they cannot read.
 */
function readBunnyError(details: Record<string, unknown>): string | null {
  const messages = details.transcodingMessages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const last = messages[messages.length - 1] as Record<string, unknown>;
  const text = typeof last?.message === "string" ? last.message : null;
  return text ? text.slice(0, 500) : null;
}

export interface BunnyEncodingResult {
  snapshot: EncodingSnapshot;
  /** Real duration in seconds, when Bunny knows it. */
  lengthSeconds: number | null;
}

/**
 * Ask Bunny about one video. Never throws: a video parked at "processing" while
 * the API is unreachable must not turn a dashboard request into a 500.
 */
export async function fetchEncodingFromBunny(
  bunnyVideoId: string
): Promise<BunnyEncodingResult | null> {
  if (!isBunnyConfigured()) return null;

  try {
    const details = (await getBunnyVideoDetails(bunnyVideoId)) as Record<string, unknown>;
    const snapshot = describeEncoding(
      typeof details.status === "number" ? details.status : null,
      typeof details.encodeProgress === "number" ? details.encodeProgress : 0
    );
    const length =
      typeof details.length === "number" && details.length > 0
        ? Math.round(details.length / 1000)
        : null;

    return {
      snapshot:
        snapshot.state === "failed"
          ? { ...snapshot, error: readBunnyError(details) }
          : snapshot,
      lengthSeconds: length,
    };
  } catch (error) {
    console.error("[Encoding] Bunny lookup failed:", bunnyVideoId, error);
    return null;
  }
}

/** Notify the creator that their video finished — used only once per video. */
async function notifyReady(video: {
  id: string;
  creatorId: string;
  title: string;
  slug: string | null;
}): Promise<void> {
  await prisma.notification.create({
    data: {
      userId: video.creatorId,
      title: "Your video is ready",
      message: `“${video.title}” finished processing and is now live on Genhub.`,
      type: "success",
      link: video.slug ? `/video/${video.slug}` : `/video/${video.id}`,
    },
  });
}

async function notifyFailed(video: {
  id: string;
  creatorId: string;
  title: string;
  slug: string | null;
}, reason: string | null): Promise<void> {
  await prisma.notification.create({
    data: {
      userId: video.creatorId,
      title: "Your video could not be processed",
      message:
        `“${video.title}” failed processing at Bunny Stream` +
        (reason ? `: ${reason}` : ".") +
        " Re-upload the file to try again.",
      type: "error",
      link: "/creator",
    },
  });
}

// =============================================================================
// End-to-end pipeline self-test
//
// "The API key is valid" is not the same as "uploads work". This was written
// after a live library answered 200 to every management call, accepted a 5.5 MB
// upload with both `PUT` and TUS (200 and 204), and then stored nothing:
// storageSize stayed 0, length stayed 0, no thumbnail, status never advanced.
// A key check would have reported that account as healthy while every creator
// upload vanished silently.
//
// So this drives the REAL path — create object, sign, reserve, upload, read
// back — and judges it on what Bunny kept, not on the status codes it returned.
// The probe object is always deleted, including on failure.
// =============================================================================

const SELF_TEST_TITLE = "genhub-pipeline-selftest";
/** Small on purpose: this checks whether bytes survive, not throughput. */
const SELF_TEST_BYTES = 4096;

export interface SelfTestStep {
  label: string;
  ok: boolean;
  detail: string;
}

export interface BunnyPipelineSelfTest {
  verdict: "ok" | "accepted-not-stored" | "failed";
  headline: string;
  detail: string;
  steps: SelfTestStep[];
  bytesSent: number;
}

/** How long to wait for Bunny's own bookkeeping to catch up before judging it. */
const READBACK_DELAYS_MS = [1_500, 3_000, 5_000];

async function readBackVideo(videoId: string): Promise<Record<string, unknown> | null> {
  for (const delay of READBACK_DELAYS_MS) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const details = (await getBunnyVideoDetails(videoId)) as Record<string, unknown>;
      const stored = Number(details.storageSize) || 0;
      const length = Number(details.length) || 0;
      // Only report once Bunny has had a chance to register the bytes.
      if (stored > 0 || length > 0) return details;
      // Otherwise keep the last answer and let the caller judge it.
      if (delay === READBACK_DELAYS_MS[READBACK_DELAYS_MS.length - 1]) {
        return details;
      }
    } catch (error) {
      console.error("[SelfTest] read-back failed:", error);
      return null;
    }
  }
  return null;
}

export async function runBunnyPipelineSelfTest(): Promise<BunnyPipelineSelfTest> {
  const steps: SelfTestStep[] = [];
  const bytes = new Uint8Array(SELF_TEST_BYTES).fill(0x20);
  let videoId: string | null = null;

  const state = (): BunnyPipelineSelfTest => ({
    verdict: "failed",
    headline: "",
    detail: "",
    steps,
    bytesSent: bytes.length,
  });

  if (!isBunnyConfigured()) {
    steps.push({
      label: "Credentials present",
      ok: false,
      detail: "BUNNY_STREAM_LIBRARY_ID / BUNNY_STREAM_API_KEY are not set",
    });
    return {
      ...state(),
      headline: "Not configured",
      detail: "Add the Bunny Stream credentials before testing the pipeline.",
    };
  }

  try {
    // 1. Reserve a slot AND sign it, through the exact function a real creator
    //    upload calls — a self-test that reimplements the path tests nothing.
    let credentials: Awaited<ReturnType<typeof createVideoUpload>>;
    try {
      credentials = await createVideoUpload(SELF_TEST_TITLE);
    } catch (error) {
      steps.push({
        label: "Create video object",
        ok: false,
        detail: String((error as Error)?.message || error).slice(0, 160),
      });
      return {
        ...state(),
        headline: "Bunny refused the request",
        detail:
          "The library did not accept a new video object, so no creator upload could start.",
      };
    }

    videoId = credentials.videoId;
    steps.push({
      label: "Create video object",
      ok: Boolean(videoId),
      detail: `slot ${videoId.slice(0, 8)}…`,
    });
    const authHeaders = {
      AuthorizationSignature: credentials.signature,
      AuthorizationExpire: String(credentials.expirationTime),
      LibraryId: credentials.libraryId,
      VideoId: videoId,
    };

    // 3. Reserve the upload.
    const reserve = await fetch(BUNNY_TUS_ENDPOINT, {
      method: "POST",
      headers: {
        "Tus-Resumable": "1.0.0",
        "Upload-Length": String(bytes.length),
        "Upload-Metadata": `filetype ${Buffer.from("video/mp4").toString("base64")},title ${Buffer.from(SELF_TEST_TITLE).toString("base64")}`,
        ...authHeaders,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!reserve.ok) {
      steps.push({
        label: "Authorize upload",
        ok: false,
        detail: `HTTP ${reserve.status} — the presigned TUS signature was refused`,
      });
      return {
        ...state(),
        headline: "Upload authorization refused",
        detail: "Bunny rejected the presigned signature, so no creator could upload either.",
      };
    }

    const location = new URL(
      reserve.headers.get("location") ?? "",
      BUNNY_TUS_ENDPOINT
    ).toString();
    steps.push({ label: "Authorize upload", ok: true, detail: "presigned TUS accepted" });

    // 4. Send the bytes.
    const patch = await fetch(location, {
      method: "PATCH",
      headers: {
        "Tus-Resumable": "1.0.0",
        "Upload-Offset": "0",
        "Content-Type": "application/offset+octet-stream",
        ...authHeaders,
      },
      body: bytes,
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    const offset = Number(patch.headers.get("upload-offset"));
    const accepted = patch.ok && offset === bytes.length;
    steps.push({
      label: "Upload bytes",
      ok: accepted,
      detail: accepted
        ? `${bytes.length} bytes acknowledged`
        : `HTTP ${patch.status}${Number.isFinite(offset) ? ` at offset ${offset}` : ""}`,
    });
    if (!accepted) {
      return {
        ...state(),
        headline: "Upload was not accepted",
        detail: "The bytes never made it to Bunny, so creator uploads would fail the same way.",
      };
    }

    // 5. The part that matters: did Bunny KEEP them?
    const details = await readBackVideo(videoId);
    if (!details) {
      steps.push({
        label: "Read the file back",
        ok: false,
        detail: "could not read the video object back from Bunny",
      });
      return {
        ...state(),
        headline: "Could not verify",
        detail: "Bunny accepted the bytes but did not answer the read-back, so storage is unknown.",
      };
    }

    const stored = Number(details.storageSize) || 0;
    const status = Number(details.status) || 0;
    const kept = stored > 0;

    steps.push({
      label: "Bunny keeps the file",
      ok: kept,
      detail: `storageSize ${stored} bytes · status ${status} (${BUNNY_STATUS_LABELS[status] ?? "unknown"})`,
    });

    if (!kept) {
      return {
        ...state(),
        // Its own verdict: not a code failure (every call succeeded) and not a
        // pass either. The UI colours this one differently for that reason.
        verdict: "accepted-not-stored",
        headline: "Bunny accepts uploads but stores nothing",
        detail:
          "Every call returns success — the object is created, the signature is accepted and the " +
          `${bytes.length} bytes are acknowledged — yet Bunny reports 0 bytes stored and the video ` +
          "never advances past its initial status. Creator uploads will appear to work and then " +
          "vanish. This is an account/library problem, not code: check for a missing payment method " +
          "or an unactivated Stream subscription on bunny.net (Billing), and whether a video " +
          "uploaded through Bunny's own dashboard stays stuck as well.",
      };
    }

    return {
      ...state(),
      verdict: "ok",
      headline: "Upload pipeline works",
      detail:
        "Bunny created the object, accepted the presigned signature, kept the bytes and started " +
        `processing (status ${status} · ${BUNNY_STATUS_LABELS[status] ?? "unknown"}). ` +
        "Encoding continues in the background for real videos.",
    };
  } catch (error) {
    steps.push({
      label: "Self-test",
      ok: false,
      detail: String((error as Error)?.message || error).slice(0, 160),
    });
    return {
      ...state(),
      headline: "Self-test could not finish",
      detail: "The network or Bunny was unreachable partway through the test.",
    };
  } finally {
    // Never leave the probe behind in a real library.
    if (videoId) {
      try {
        await deleteBunnyVideo(videoId);
        steps.push({
          label: "Clean up",
          ok: true,
          detail: "probe video deleted — the library is unchanged",
        });
      } catch {
        steps.push({
          label: "Clean up",
          ok: false,
          detail: `could not delete probe ${videoId} — remove it by hand`,
        });
      }
    }
  }
}

export interface RefreshResult {
  id: string;
  title: string;
  snapshot: EncodingSnapshot;
  /** True when this poll is what made the video publicly visible. */
  published: boolean;
}

/**
 * Poll one video and act on the answer.
 *
 * Rows with `encodingStatus === null` are never touched: those are side-loaded
 * or demo videos Bunny does not transcode, and their publication state belongs
 * to whoever created them.
 */
export async function refreshVideoEncoding(videoId: string): Promise<RefreshResult | null> {
  const video = await prisma.video.findUnique({
    where: { id: videoId },
    select: {
      id: true,
      creatorId: true,
      title: true,
      slug: true,
      bunnyVideoId: true,
      isPublished: true,
      isDeleted: true,
      encodingStatus: true,
      encodingNotifiedAt: true,
    },
  });

  if (!video || video.isDeleted || video.encodingStatus === null) return null;

  const result = await fetchEncodingFromBunny(video.bunnyVideoId);
  if (!result) return null;

  const { snapshot } = result;

  // Publish when it becomes playable. Only ever flips false -> true, so a
  // creator who unpublishes is never overridden by the next poll.
  const shouldPublish = snapshot.state === "ready" && !video.isPublished;
  const shouldNotify = snapshot.state === "ready" && !video.encodingNotifiedAt;

  await prisma.video.update({
    where: { id: video.id },
    data: {
      encodingStatus: snapshot.status,
      encodeProgress: snapshot.progress,
      encodingError: snapshot.error,
      encodingCheckedAt: new Date(),
      ...(result.lengthSeconds ? { duration: result.lengthSeconds } : {}),
      ...(shouldPublish ? { isPublished: true } : {}),
      ...(shouldNotify ? { encodingNotifiedAt: new Date() } : {}),
    },
  });

  if (shouldNotify) {
    await notifyReady(video);
  } else if (snapshot.state === "failed" && !video.encodingNotifiedAt) {
    // One notification for a failure too, so the creator is not left waiting.
    await prisma.video.update({
      where: { id: video.id },
      data: { encodingNotifiedAt: new Date() },
    });
    await notifyFailed(video, snapshot.error);
  }

  return { id: video.id, title: video.title, snapshot, published: shouldPublish };
}

/** Videos that have not reached a terminal state yet. */
function pendingWhere() {
  return {
    encodingStatus: { not: null },
    encodingNotifiedAt: null,
    isDeleted: false,
  };
}

/**
 * Poll one creator's unfinished videos. The creator dashboard calls this, so a
 * creator watching the page advances their own video even when no scheduler is
 * configured — the cron is for when nobody is looking.
 */
export async function refreshCreatorPendingEncodings(
  creatorId: string,
  limit: number = 5,
  minAgeMs: number = 10_000
): Promise<RefreshResult[]> {
  if (!isBunnyConfigured()) return [];

  const pending = await prisma.video.findMany({
    where: {
      ...pendingWhere(),
      creatorId,
      // A dashboard that polls every few seconds must not become a Bunny API
      // flood. Bunny reports progress in percentages, so re-asking within
      // seconds cannot tell the creator anything new. Cron passes 0.
      ...(minAgeMs > 0
        ? {
            OR: [
              { encodingCheckedAt: null },
              { encodingCheckedAt: { lt: new Date(Date.now() - minAgeMs) } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true },
  });

  const results: RefreshResult[] = [];
  for (const { id } of pending) {
    const result = await refreshVideoEncoding(id);
    if (result) results.push(result);
  }
  return results;
}

/** Cron entry point: every creator, oldest first so nothing is starved. */
export async function refreshPendingEncodings(limit: number = 25): Promise<{
  checked: number;
  published: number;
  ready: number;
  failed: number;
}> {
  const pending = await prisma.video.findMany({
    // The cron runs on its own schedule, so it bypasses the re-check floor and
    // takes whatever has been waiting longest first — nothing gets starved by a
    // burst of new uploads.
    where: pendingWhere(),
    orderBy: { encodingCheckedAt: "asc" },
    take: limit,
    select: { id: true },
  });

  let published = 0;
  let ready = 0;
  let failed = 0;

  for (const { id } of pending) {
    const result = await refreshVideoEncoding(id);
    if (!result) continue;
    if (result.published) published++;
    if (result.snapshot.state === "ready") ready++;
    if (result.snapshot.state === "failed") failed++;
  }

  return { checked: pending.length, published, ready, failed };
}
