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
// STATUS CODES. Bunny numbers them 0..10 and uses ONE list for both the webhook
// body and the `status` field of a video object returned by the API:
//
//   0 Queued · 1 Processing · 2 Encoding · 3 Finished · 4 Resolution finished
//   · 5 Failed · 6-8 presigned-upload events · 9 captions · 10 title/description
//
// 3 is the code that matters: "the video encoding has finished and the video is
// FULLY AVAILABLE". This map used to shift every code after 2 by one — 3 was
// read as "Transcoding" and only 4 counted as finished — so a video Bunny had
// already finished sat on the creator's dashboard as a spinning "Transcoding X%"
// and was never published, however long it was watched. That is what a creator
// reports as "it says transcoding and the video never goes up".
//
// Three signals mean "can play", and any one is enough: status 3 (finished),
// status 4 (one resolution finished — Bunny: the first of these means the video
// is playable) or encodeProgress 100. Checking all three means one wrong number
// cannot hold every upload back forever.
// =============================================================================

import prisma from "@/lib/db";
import config from "@/lib/config";
import { MIN_VIDEO_DURATION_SECONDS } from "@/lib/creator-guidelines";
import {
  createVideoUpload,
  deleteBunnyVideo,
  getBunnyVideoDetails,
  isBunnyConfigured,
} from "@/lib/bunny";
import {
  createTusUpload,
  patchTusChunk,
  tusAuthHeaders,
  TUS_AUTH_TTL_SECONDS,
} from "@/lib/bunny-tus";
import type { BunnyWebhookIntent } from "@/lib/bunny-webhook";
import {
  BUNNY_FINISHED,
  BUNNY_RESOLUTION_FINISHED,
  videoStatus,
  type VideoStatus,
} from "@/lib/video-status";

export type EncodingState = "pending" | "processing" | "ready" | "failed" | "untracked";

/**
 * Re-exported so the API routes and the client can name the publication state
 * from the same module the encoder lifecycle judges it in.
 */
export { videoStatus };
export type { VideoStatus };

/**
 * Bunny's own status codes, for the raw number shown to admins.
 *
 * Must stay identical to BUNNY_WEBHOOK_STATUS_LABELS in lib/bunny-webhook.ts.
 * Bunny uses one list for the webhook body and for the video object's `status`,
 * and two copies that disagree are exactly how status 3 came to mean "Finished"
 * in one file and "Transcoding" in the other.
 */
export const BUNNY_STATUS_LABELS: Record<number, string> = {
  0: "Queued",
  1: "Processing",
  2: "Encoding",
  3: "Finished",
  4: "Resolution finished",
  5: "Failed",
  6: "Upload started",
  7: "Upload finished",
  8: "Upload failed",
  9: "Captions generated",
  10: "Title/description generated",
};

const BUNNY_STATUS_ERROR = 5;
/**
 * The three codes that decide readiness live in lib/video-status.ts, which is
 * the rule every screen reads; these aliases keep the older call sites here
 * readable. They are the SAME numbers on purpose — two copies of "3 means
 * finished" is how status 3 came to mean "Transcoding" in one file once
 * already.
 */
const BUNNY_STATUS_FINISHED = BUNNY_FINISHED;
const BUNNY_STATUS_PLAYABLE = BUNNY_RESOLUTION_FINISHED;

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
 * `ready` when Bunny says finished (3), when a resolution is done (4), or when
 * it reports 100% — all three are checked so a shifted code cannot silently
 * strand every future upload.
 */
export function describeEncoding(
  status: number | null | undefined,
  progress: number | null | undefined
): EncodingSnapshot {
  const percent = Math.max(0, Math.min(100, Number(progress) || 0));

  // Which of the three publication states this is — decided by the one shared
  // rule (lib/video-status.ts), so the badge the feed shows and the state this
  // service acts on can never drift apart.
  const publication = videoStatus(status, percent);

  if (status === null || status === undefined) {
    return { state: "untracked", status: null, progress: 0, label: "Not tracked", error: null };
  }

  if (publication === "FAILED") {
    return {
      state: "failed",
      status,
      progress: percent,
      label: BUNNY_STATUS_LABELS[status] ?? "Error",
      error: null,
    };
  }

  if (publication === "READY") {
    return {
      state: "ready",
      status,
      progress: percent,
      label: BUNNY_STATUS_LABELS[status] ?? "Ready",
      error: null,
    };
  }

  return {
    // Only 0 (Queued) is "not started" now that 1 really is "Processing".
    state: status <= 0 ? "pending" : "processing",
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
  /**
   * How many bytes Bunny actually holds, or null when it did not say.
   *
   * Distinct from 0 on purpose: 0 is the answer that matters — the slot exists
   * and the file never arrived — while null means the API response did not carry
   * the field and nothing may be concluded from it.
   */
  storageBytes: number | null;
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
    // Bunny reports `length` in SECONDS, not milliseconds. Measured against the
    // live library: a 5-second clip comes back as `length: 5`.
    //
    // This used to divide by 1000, and because the field is already seconds the
    // result was 0 for every real upload — which quietly did two things. The
    // `duration` column was never written, because `...(0 ? : {})` is falsy, so
    // every video in the catalogue showed no length. And the creator-guidelines
    // floor below tests `lengthSeconds > 0`, so it could never fire: a 5-second
    // clip was published to a paid feed whose rules say eight minutes minimum.
    // One wrong unit disabled a rule and a column at the same time, silently.
    const length =
      typeof details.length === "number" && details.length > 0
        ? Math.round(details.length)
        : null;

    return {
      snapshot:
        snapshot.state === "failed"
          ? { ...snapshot, error: readBunnyError(details) }
          : snapshot,
      lengthSeconds: length,
      storageBytes:
        typeof details.storageSize === "number" ? details.storageSize : null,
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
  // "Ready" and "live" are no longer the same moment. The post went live the
  // instant it was uploaded (see /api/videos POST), so telling the creator it
  // "is now live" would describe something that happened minutes ago — and
  // send them looking for a change that already happened. What is new is that
  // it can be PLAYED.
  await prisma.notification.create({
    data: {
      userId: video.creatorId,
      title: "Your video is ready to play",
      message: `“${video.title}” finished processing, so the “Inachakatwa...” badge is gone and viewers can watch it.`,
      type: "success",
      link: video.slug ? `/video/${video.slug}` : `/video/${video.id}`,
    },
  });
}

/**
 * A byte count that fits the column it is written to.
 *
 * `storageSize` is a 32-bit integer in Postgres, and Bunny reports the WHOLE
 * encoded footprint — original plus every rendition — which for a 2 GB source
 * of multi-bitrate video can pass 2.1 GB. Storing the raw number would fail the
 * write and lose the rest of the row's update with it, so it is clamped to the
 * column's ceiling: a number that big is only ever read as "very large".
 */
const MAX_STORED_BYTES = 2_147_483_647;

function clampStoredBytes(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes < 0) return 0;
  return Math.min(Math.round(bytes), MAX_STORED_BYTES);
}

/**
 * A video that finished at Bunny but is shorter than the 8-minute floor. It is
 * NOT published, and the creator is told why in the same breath — a silent
 * unpublished video is the worst outcome, because they cannot tell it apart
 * from a bug.
 */
async function notifyTooShort(video: {
  id: string;
  creatorId: string;
  title: string;
  slug: string | null;
}, seconds: number): Promise<void> {
  const minutes = Math.max(1, Math.round(seconds / 60));
  await prisma.notification.create({
    data: {
      userId: video.creatorId,
      // "Stays unpublished" was true when a post was only created once the
      // encode finished. Now the post was live for the minutes it took to learn
      // the length, so the creator is told what actually happened to it.
      title: "Your video is too short to stay published",
      message:
        `“${video.title}” is about ${minutes} minute(s) long. Creator guidelines ` +
        `require at least ${MIN_VIDEO_DURATION_SECONDS / 60} minutes, so it has ` +
        `been taken down and cannot be watched. Upload a longer version to put it ` +
        `back up.`,
      type: "error",
      link: "/creator",
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
// back — and judges it on what Bunny DID with the bytes, not on the status codes
// its calls returned. The probe object is always deleted, including on failure.
//
// Careful with the evidence, though, and this is where this probe went wrong
// once already: `storageSize` is not a counter of bytes received. Measured
// against the live library, a healthy upload reports `storageSize 0` at 0, 3 and
// 8 seconds and only reports its footprint at 18 s (37 MB for a 2.8 MB source,
// because it counts every rendition). Judging "stored nothing" on that number
// after a few seconds accused a working account of losing every upload and sent
// its owner to check Bunny's billing for a fault that did not exist. What the
// probe tests now is whether the video left its initial Queued(0) state, which a
// complete file does within a second and an interrupted transfer never does.
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

/**
 * How long to wait for Bunny's own bookkeeping to catch up before judging it.
 *
 * Roughly a minute in total, and the length is the point. `storageSize` is NOT a
 * received-bytes counter: measured against the live library, it reads 0 for the
 * entire upload AND transcode and then reports the whole encoded footprint at
 * once — a real 2.8 MB clip answered `storageSize 0` at 0 s, 3 s and 8 s and
 * only reported 37 MB at 18 s. Judging on "is storageSize still 0?" after 9.5 s
 * therefore condemned a perfectly healthy library, which is exactly what this
 * probe did before it was given the time to see the truth.
 */
const READBACK_DELAYS_MS = [2_000, 5_000, 10_000, 15_000, 30_000];

/**
 * True when Bunny has taken the file.
 *
 * The status is the reliable half. A slot Bunny has received a complete file for
 * LEAVES its initial Queued(0) immediately — measured at 2 (Processing) within a
 * second of the last byte — and a slot whose transfer never finished arriving
 * stays at 0 forever, however long it is watched. That is the same fingerprint
 * every stranded creator upload wears (see UPLOAD_STRANDED_AFTER_MS), and it is
 * the thing worth testing, because it cannot be faked by a slow transcode.
 */
function bunnyTookTheFile(details: Record<string, unknown>): boolean {
  const stored = Number(details.storageSize) || 0;
  const status = Number(details.status) || 0;
  return stored > 0 || status !== 0;
}

async function readBackVideo(videoId: string): Promise<Record<string, unknown> | null> {
  let last: Record<string, unknown> | null = null;
  for (const delay of READBACK_DELAYS_MS) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const details = (await getBunnyVideoDetails(videoId)) as Record<string, unknown>;
      // Report as soon as Bunny has moved off its initial state; otherwise keep
      // the last answer and let the caller judge it once the time is up.
      if (bunnyTookTheFile(details)) return details;
      last = details;
    } catch (error) {
      console.error("[SelfTest] read-back failed:", error);
      return null;
    }
  }
  return last;
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
    // 3. Sign the upload — through the same function the upload route calls, so
    //    this checks the URL a real creator would be handed rather than an
    //    imitation of it.
    const expiresAt = Math.floor(Date.now() / 1000) + TUS_AUTH_TTL_SECONDS;
    const tus = await createTusUpload({
      libraryId: credentials.libraryId,
      apiKey: config.bunny.apiKey,
      videoId,
      total: bytes.length,
      expiresAt,
      timeoutMs: 20_000,
    });
    if (!tus.ok) {
      steps.push({
        label: "Open Bunny upload",
        ok: false,
        detail:
          `HTTP ${tus.status || "network"} ${tus.detail}`.slice(0, 160),
      });
      return {
        ...state(),
        headline: "Bunny refused the upload session",
        detail:
          "Bunny created the video object but did not open its resumable upload resource.",
      };
    }
    steps.push({
      label: "Open Bunny upload",
      ok: true,
      detail: "direct TUS resource opened",
    });

    // 4. PUT the bytes, exactly as the browser does — one request, no chunking
    //    and no Bunny credential anywhere near it.
    const headers = await tusAuthHeaders({
      libraryId: credentials.libraryId,
      apiKey: config.bunny.apiKey,
      videoId,
      expiresAt,
    });
    const patch = await patchTusChunk({
      uploadUrl: tus.uploadUrl,
      headers,
      offset: 0,
      body: bytes,
      size: bytes.length,
      timeoutMs: 20_000,
    });
    const acceptedByBunny = patch.ok && patch.offset === bytes.length;
    steps.push({
      label: "Upload bytes",
      ok: acceptedByBunny,
      detail: acceptedByBunny
        ? `${bytes.length} bytes acknowledged by Bunny`
        : patch.ok
        ? `Bunny acknowledged offset ${patch.offset} of ${bytes.length}`
        : `HTTP ${patch.status || "network"} ${patch.detail}`.slice(0, 160),
    });
    if (!acceptedByBunny) {
      return {
        ...state(),
        headline: "Bunny did not accept the file",
        detail:
          "The presigned URL did not authorize this upload, so a creator's would not either — check that the R2 API token may write to the bucket it names.",
      };
    }

    // 5. Hand it to Bunny. This is the step that moved when the browser stopped
    //    talking to Bunny: the ingest is what puts the file in front of the
    //    encoder now, so a failure here is a failure of the whole pipeline.
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
    const kept = bunnyTookTheFile(details);

    steps.push({
      label: "Bunny takes the file",
      ok: kept,
      // Read by a person, so say which observation decided it: a Failed code on
      // THIS probe is expected (the payload is not a video) and is not the same
      // thing as the silent 0-bytes fault the probe exists to catch.
      detail: !kept
        ? `still Queued(0) with storageSize ${stored} after the read-back window — the bytes never completed arriving`
        : status === BUNNY_STATUS_ERROR
        ? `status 5 (Failed) · storageSize ${stored} bytes — Bunny read the bytes; a probe payload is not a video, so a Failed code on this file is expected`
        : `status ${status} (${BUNNY_STATUS_LABELS[status] ?? "unknown"}) · storageSize ${stored} bytes`,
    });

    if (!kept) {
      return {
        ...state(),
        // Its own verdict: not a code failure (every call succeeded) and not a
        // pass either. The UI colours this one differently for that reason.
        verdict: "accepted-not-stored",
        headline: "Bunny accepted the bytes but the transfer never completed",
        detail:
          "Every call succeeded — the object was created, the signature was accepted and the " +
          `${bytes.length} bytes were acknowledged — yet the video is still at Queued(0) after a ` +
          "minute, which is where Bunny keeps a file it never received in full. A real transfer " +
          "leaves that state within a second of the last byte, so this is not a slow transcode: the " +
          "bytes are not arriving. That is a connection or browser problem on the uploading side, " +
          "not an account problem — Bunny is reachable, the credentials work and the slot was " +
          "created, so do not go looking for a billing fault. If a creator hits this, have them " +
          "upload again on a stable connection.",
      };
    }

    return {
      ...state(),
      verdict: "ok",
      headline: "Upload pipeline works",
      detail:
        "Bunny created the object, accepted the presigned signature, acknowledged the bytes and " +
        `took the file (status ${status} · ${BUNNY_STATUS_LABELS[status] ?? "unknown"}). ` +
        "A probe payload is not a real video, so Bunny frequently rejects THIS file as " +
        "unreadable — that is the pipeline working, not failing: what matters is that the bytes " +
        "were kept and processing started, which is what a real upload needs. Encoding continues " +
        "in the background for real videos.",
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
 * How long a reserved slot may hold zero bytes before the upload is called off.
 *
 * A slot Bunny never received a byte for cannot encode, and nothing on our side
 * will ever change that: status stays at "Queued" and the creator waits for a
 * video that is not coming. The most common cause is an upload that was
 * abandoned (closed tab, lost signal) after the slot was reserved, which leaves
 * no trace at all — the row looks exactly like one that is about to start.
 *
 * Six hours is deliberately beyond any honest transfer: the limit is 2 GB, so
 * even a 1 Mbit/s connection finishes inside five. A file slower than that is a
 * connection that died, not a connection working.
 */
export const UPLOAD_STRANDED_AFTER_MS = 6 * 60 * 60 * 1000;

/** What the creator is told when a slot never received the file. */
export const STRANDED_UPLOAD_MESSAGE =
  "The file never reached the video host, so there is nothing to process. The " +
  "upload was interrupted or never started — please upload this video again.";

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
      createdAt: true,
      isPublished: true,
      isDeleted: true,
      encodingStatus: true,
      encodingNotifiedAt: true,
    },
  });

  if (!video || video.isDeleted || video.encodingStatus === null) return null;

  const result = await fetchEncodingFromBunny(video.bunnyVideoId);
  if (!result) return null;

  // A slot Bunny has received nothing for is reported as a failed upload once
  // enough time has passed to rule out a slow transfer — see
  // UPLOAD_STRANDED_AFTER_MS. Everything below works off `snapshot`, so the
  // strand is applied here, once, instead of being threaded through each rule:
  // publishing, the duration floor and the once-only notification then all
  // behave exactly as they do for a file Bunny itself rejected.
  const stranded =
    result.storageBytes === 0 &&
    (result.snapshot.state === "pending" || result.snapshot.state === "processing") &&
    Date.now() - video.createdAt.getTime() > UPLOAD_STRANDED_AFTER_MS;

  const snapshot: EncodingSnapshot = stranded
    ? { ...result.snapshot, state: "failed", error: STRANDED_UPLOAD_MESSAGE, progress: 0 }
    : result.snapshot;

  // The 8-minute floor, enforced where the real duration finally exists: Bunny
  // only reports `lengthSeconds` once it has encoded the file, so this is the
  // first moment the rule can be checked at all. A ready-but-too-short video is
  // held back instead of published (and taken down if it is already up — see
  // `shouldUnpublish` below).
  const tooShort =
    snapshot.state === "ready" &&
    typeof result.lengthSeconds === "number" &&
    result.lengthSeconds > 0 &&
    result.lengthSeconds < MIN_VIDEO_DURATION_SECONDS;

  // Publish when it becomes playable — and long enough.
  const shouldPublish = snapshot.state === "ready" && !video.isPublished && !tooShort;

  // ...and take down a video that turns out to break the length rule.
  //
  // This is the ONE case where the lifecycle moves a video the other way, and
  // it exists because publication is now instant: a post is live from the
  // moment it is uploaded, so the old behaviour — never publish it at all —
  // would leave a two-minute scene sitting in the public feed for the minutes
  // Bunny needs to report its length. The length rule is a platform rule, not
  // the creator's preference, so it is not the creator overruling themselves;
  // their own unpublish is still never reversed by a poll.
  //
  // Once only, by construction: this keeps `encodingNotifiedAt`, which takes
  // the video out of `pendingWhere()`, so the takedown and its notification
  // happen together exactly once — and a creator who then publishes it by hand
  // (the documented override) is not fought by the next sweep.
  const shouldUnpublish = tooShort && video.isPublished;
  const shouldNotify = snapshot.state === "ready" && !video.encodingNotifiedAt && !tooShort;

  await prisma.video.update({
    where: { id: video.id },
    data: {
      // 5 (Error) rather than Bunny's 0 when the upload never arrived: the column
      // answers "will this finish on its own?", and for an empty slot the answer
      // is no. The reason the creator reads comes from encodingError below.
      encodingStatus: stranded ? BUNNY_STATUS_ERROR : snapshot.status,
      encodeProgress: snapshot.progress,
      encodingError: snapshot.error,
      encodingCheckedAt: new Date(),
      // The host's own number, stored so the dashboard can show it beside the
      // progress bar without asking Bunny again on every poll. NULL is left
      // alone rather than written as 0, because the API answering without the
      // field says nothing, while an actual 0 is the answer that matters.
      ...(result.storageBytes !== null
        ? { bunnyStorageBytes: clampStoredBytes(result.storageBytes) }
        : {}),
      ...(result.lengthSeconds ? { duration: result.lengthSeconds } : {}),
      ...(shouldPublish ? { isPublished: true } : {}),
      ...(shouldUnpublish ? { isPublished: false } : {}),
      ...((shouldNotify || tooShort) ? { encodingNotifiedAt: new Date() } : {}),
    },
  });

  if (shouldNotify) {
    await notifyReady(video);
  } else if (tooShort && !video.encodingNotifiedAt && result.lengthSeconds) {
    await notifyTooShort(video, result.lengthSeconds);
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
 * The shortest gap between two Bunny polls of the same video.
 *
 * Every caller that advances the lifecycle from a page load — the creator
 * dashboard's 8-second poll, the creator's own video page — shares this floor.
 * Bunny reports progress in whole percents, so a poll inside ten seconds cannot
 * tell anyone anything new, and without a floor a page that polls would spend an
 * API call per render.
 */
export const ENCODING_RECHECK_FLOOR_MS = 10_000;

/**
 * Bunny lookups are network-bound. A creator with five pending uploads should
 * not wait five sequential provider timeouts before receiving the list, but a
 * fully unbounded Promise.all would turn a large account into an API burst.
 */
export const ENCODING_REFRESH_CONCURRENCY = 3;

export interface BunnyEventOutcome {
  /** False when the callback named a video we do not track. */
  matched: boolean;
  videoId: string | null;
  state: EncodingState | null;
  published: boolean;
}

/**
 * Apply a verified Bunny Stream webhook to the database.
 *
 * The callback carries only a guid and a status code, so the authoritative
 * details are read back through the SAME function the cron and the dashboard
 * use — refreshVideoEncoding — rather than a second publish path that could
 * drift from it. That is what makes the webhook a trigger and not a parallel
 * implementation: publish, the 8-minute floor and the once-only notification
 * stay in one place.
 *
 * The webhook is the fast path (Bunny calls us the instant a video finishes),
 * but it is not the only one: the creator dashboard polls on read and the cron
 * worker sweeps, so a webhook that never arrives (or arrives before the row is
 * written) still resolves.
 */
export async function applyBunnyEncodingEvent(params: {
  bunnyVideoId: string;
  intent: BunnyWebhookIntent;
}): Promise<BunnyEventOutcome> {
  const none: BunnyEventOutcome = { matched: false, videoId: null, state: null, published: false };

  // "ignore" is a callback for another library; nothing here owns it.
  if (params.intent === "ignore") return none;

  const video = await prisma.video.findFirst({
    where: { bunnyVideoId: params.bunnyVideoId, isDeleted: false },
    orderBy: { createdAt: "desc" },
    select: { id: true, encodingStatus: true },
  });

  // No row, or a row Bunny does not transcode (side-loaded/demo content): the
  // lifecycle must not touch it, exactly as in refreshVideoEncoding.
  if (!video || video.encodingStatus === null) return none;

  const result = await refreshVideoEncoding(video.id);
  if (!result) return { ...none, matched: true, videoId: video.id };

  return {
    matched: true,
    videoId: result.id,
    state: result.snapshot.state,
    published: result.published,
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
  minAgeMs: number = ENCODING_RECHECK_FLOOR_MS
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
  for (let start = 0; start < pending.length; start += ENCODING_REFRESH_CONCURRENCY) {
    const batch = pending.slice(start, start + ENCODING_REFRESH_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(({ id }) => refreshVideoEncoding(id))
    );

    settled.forEach((outcome, index) => {
      if (outcome.status === "fulfilled") {
        if (outcome.value) results.push(outcome.value);
        return;
      }

      // One Bunny timeout must not hide the creator's other videos. The stored
      // state remains intact and the next poll/cron can retry this one.
      console.warn(
        `[Video Encoding] Refresh failed for ${batch[index].id}:`,
        outcome.reason instanceof Error ? outcome.reason.message : outcome.reason
      );
    });
  }
  return results;
}

export interface PendingEncodingSweepResult {
  checked: number;
  refreshed: number;
  failed: number;
}

/**
 * Refresh pending videos without requiring a creator to have the dashboard
 * open. Bunny webhooks remain the fast path; this bounded sweep is the safety
 * net for a missed callback or a callback that arrived before finalization.
 */
export async function refreshPendingVideoEncodings(
  limit: number = 9
): Promise<PendingEncodingSweepResult> {
  if (!isBunnyConfigured()) return { checked: 0, refreshed: 0, failed: 0 };

  const pending = await prisma.video.findMany({
    where: pendingWhere(),
    orderBy: { createdAt: "asc" },
    take: Math.max(1, Math.min(limit, 25)),
    select: { id: true },
  });

  let refreshed = 0;
  let failed = 0;
  for (let start = 0; start < pending.length; start += ENCODING_REFRESH_CONCURRENCY) {
    const batch = pending.slice(start, start + ENCODING_REFRESH_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(({ id }) => refreshVideoEncoding(id))
    );

    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        if (outcome.value) refreshed += 1;
      } else {
        failed += 1;
        console.warn(
          "[Video Encoding Sweep] Refresh failed:",
          outcome.reason instanceof Error ? outcome.reason.message : outcome.reason
        );
      }
    }
  }

  return { checked: pending.length, refreshed, failed };
}

// The webhook and all pull paths converge on refreshVideoEncoding(), so the
// scheduled sweep is a safety net, not a second publication implementation.
// Keeping it bounded and idempotent lets a missed callback recover even when no
// creator is currently watching a dashboard.
