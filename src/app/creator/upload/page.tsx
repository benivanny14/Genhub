"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { fetchCurrentUser } from "@/lib/current-user";
import Header from "@/components/Header";
import Image from "next/image";
import ImageCropper from "@/components/ImageCropper";
import { canOptimizeImage } from "@/lib/media";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import {
  uploadFileWithTus,
  describeRetry,
  TusUploadError,
  videoSizeError,
  UPLOAD_STALL_WARNING_MS,
  type TusUploadRetryInfo,
} from "@/lib/tus-upload";
import { uploadFileWithPut } from "@/lib/upload-put";
import { ScreenWakeLock } from "@/lib/screen-wake-lock";
import { describeUploadFailure, reportUploadFailure } from "@/lib/upload-client";
import { probeVideoDuration, shortVideoError } from "@/lib/video-duration";
import { CATEGORIES } from "@/lib/categories";
import type { UploadTarget } from "@/lib/upload-proxy";
import {
  CREATOR_GUIDELINES,
  GUIDELINE_ACK_LABEL_EN,
  GUIDELINE_ACK_LABEL_SW,
  MIN_VIDEO_DURATION_SECONDS,
  needsGuidelineAcceptance,
} from "@/lib/creator-guidelines";
import Link from "next/link";
import {
  Upload,
  Film,
  DollarSign,
  Tag,
  FileText,
  ArrowLeft,
  CheckCircle,
  ScrollText,
  ShieldAlert,
} from "lucide-react";

export default function UploadPage() {
  const router = useRouter();
  const { toast, update: updateToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  // This is separate from progress: the first PATCH can be in flight before
  // the browser emits its first progress event. Wake Lock and the stall warning
  // must already be active during that window.
  const [mainUploadActive, setMainUploadActive] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  // True when no byte has moved for a while. Reported, never acted on: on a
  // phone this is usually the screen locking or the browser being sent to the
  // background (see the wake lock below), and the creator is the only one who
  // can undo that.
  const [uploadStalled, setUploadStalled] = useState(false);
  // When progress last moved, in ms. A ref because it changes on every chunk
  // and must not re-render the form.
  const lastProgressAt = useRef<number | null>(null);
  // The screen wake lock held for the duration of a transfer. One instance per
  // page, created on first use — see lib/screen-wake-lock.ts for the rules it
  // owns (requested before the reserve call, retaken when the tab returns,
  // released on every ending, silent on browsers without the API).
  const wakeLockRef = useRef<ScreenWakeLock | null>(null);
  const screenWakeLock = () => (wakeLockRef.current ??= new ScreenWakeLock());
  // Aborting on unmount prevents an invisible XHR from continuing after the
  // creator leaves the page and makes the reserved slot eligible for cleanup.
  const uploadAbortRef = useRef<AbortController | null>(null);
  // True only once the bytes are actually stored at Bunny. `bunnyVideoId` is set
  // earlier — when the slot is reserved — so it cannot be what the UI trusts to
  // know the upload finished, or a failed transfer would look like a success.
  const [uploadReady, setUploadReady] = useState(false);
  // How many bytes were handed to Bunny, kept until the video row is created.
  // The dashboard compares it against what the host reports holding, which is
  // the only way to see that a transfer stopped arriving — see lib/host-bytes.ts.
  const [uploadedBytes, setUploadedBytes] = useState<number | null>(null);
  // A failed transfer keeps its file AND credentials, so Retry re-sends into the
  // SAME reserved slot instead of reserving a new one and orphaning this one.
  const [failedUpload, setFailedUpload] = useState<{
    file: File;
    credentials: UploadTarget;
  } | null>(null);
  const [success, setSuccess] = useState(false);
  const [awaitingProcessing, setAwaitingProcessing] = useState(false);
  // The slug of the post that was just created, so the confirmation screen can
  // offer "View post" — the point of instant publication is that there is
  // something to look at straight away.
  const [createdSlug, setCreatedSlug] = useState("");
  // The rules changed since this account last accepted them, so the upload
  // form stays closed until they are read and ticked again. Read from the
  // account, not from this browser, so the gate is the same on every device.
  const [reAcceptGuidelines, setReAcceptGuidelines] = useState(false);
  const [acceptingGuidelines, setAcceptingGuidelines] = useState(false);
  const [guidelineChecks, setGuidelineChecks] = useState<Record<string, boolean>>({});
  const allGuidelinesChecked = CREATOR_GUIDELINES.every((g) => guidelineChecks[g.id]);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState(1000);
  const [teaserDuration, setTeaserDuration] = useState(15);
  const [category, setCategory] = useState("");
  const [tags, setTags] = useState("");
  const [bunnyVideoId, setBunnyVideoId] = useState("");
  const [thumbnailUrl, setThumbnailUrl] = useState("");
  const [uploadingThumb, setUploadingThumb] = useState(false);
  // The picture the creator just chose, held while they frame it. The cover is
  // shown as a 16:9 shape everywhere (feed, profile, watch page), so the same
  // shape is what they position here — what they see is what every viewer gets.
  const [thumbCropFile, setThumbCropFile] = useState<File | null>(null);
  // Separate short clip shown to non-buyers. Without it a paid scene shows only
  // a poster, because signing the main video for non-buyers would unlock the
  // whole scene (a Bunny token authorises a path, not a duration).
  const [teaserBunnyVideoId, setTeaserBunnyVideoId] = useState("");
  const [teaserProgress, setTeaserProgress] = useState(0);
  const [uploadingTeaser, setUploadingTeaser] = useState(false);
  // 18 U.S.C. § 2257 — the creator must affirm this before the video is created.
  const [complianceAttested, setComplianceAttested] = useState(false);

  const checkAccess = useCallback(async () => {
    try {
      const res = await fetchCurrentUser();
      const data = await res.json();
      if (!data.success || data.data.role !== "CREATOR") {
        router.push("/");
        return;
      }
      if (data.data.kycStatus !== "APPROVED") {
        router.push("/creator/kyc");
        return;
      }
      // Read-side re-check: a version bump invalidates the old receipt, so a
      // creator who accepted the previous wording is shown the new one here.
      setReAcceptGuidelines(
        needsGuidelineAcceptance(data.data.guidelinesAcceptedVersion)
      );
    } catch {
      router.push("/login");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    checkAccess();
  }, [checkAccess]);

  // ===========================================================================
  // Why a phone upload dies halfway (the thing that was hurting worst)
  // ===========================================================================
  // On a phone, the upload does not fail on the network — it fails because the
  // PAGE goes away. Locking the screen or switching apps suspends the tab, and
  // a suspended tab stops sending: the XHR freezes mid-chunk with no error, so
  // the browser reports neither success nor failure and the bar simply stops.
  // On the old 32 MiB chunks a creator would come back to a bar that had not
  // moved, wait out the stall timeout, and often give up on a file that was
  // one chunk from done.
  //
  // Two things make that survivable, and neither is a trick:
  //   1. the screen is held awake for the length of the transfer (Wake Lock),
  //      which is the commonest cause removed outright;
  //   2. the creator is TOLD what will break their upload, in the language they
  //      are using the site in, while it is running.
  // Chunk sizing is the third half — see lib/tus-upload.ts — and the reserved
  // slot means a dropped transfer resumes where it stopped instead of starting
  // again from byte zero.

  /** Give the lock back and stop watching. Every ending lands here. */
  const releaseScreenWake = useCallback(() => {
    screenWakeLock().stop();
  }, []);
  /**
   * Take the lock now. Never throws and is never awaited for its own sake: the
   * API is an optimisation, so a browser without it simply continues.
   */
  const holdScreenAwake = useCallback(async () => {
    await screenWakeLock().acquire();
  }, []);
  /**
   * The same, plus the rule that matters on a phone: a hidden tab has its lock
   * dropped BY THE BROWSER, so coming back to the page has to take it again.
   */
  const watchScreenWake = useCallback(async () => {
    await screenWakeLock().watch();
  }, []);

  useEffect(() => {
    return () => {
      uploadAbortRef.current?.abort();
      uploadAbortRef.current = null;
      releaseScreenWake();
    };
  }, [releaseScreenWake]);

  /** A transfer is in flight from before the first byte until it settles. */
  const transferring = mainUploadActive || uploadingTeaser;

  useEffect(() => {
    if (!transferring) {
      setUploadStalled(false);
      lastProgressAt.current = null;
      releaseScreenWake();
      return;
    }

    lastProgressAt.current = lastProgressAt.current ?? Date.now();
    // Takes the lock AND registers the re-acquire-on-return rule — which is why
    // this is not the same call the reserve path makes. The timer below is
    // reporting only; the module owns every decision about the lock itself.
    void watchScreenWake();

    const timer = setInterval(() => {
      const last = lastProgressAt.current ?? Date.now();
      setUploadStalled(Date.now() - last > UPLOAD_STALL_WARNING_MS);
    }, 5_000);

    return () => {
      clearInterval(timer);
    };
  }, [transferring, watchScreenWake, releaseScreenWake]);

  /** Reserve the slot and get the short-lived credentials to fill it. */
  async function initiateUpload(): Promise<UploadTarget | null> {
    try {
      const res = await fetch("/api/videos/upload-signature", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const data = await res.json();
      if (data.success) {
        setBunnyVideoId(data.data.videoId);
        return data.data as UploadTarget;
      }
      toast("error", data.error || "Could not start the upload");
      return null;
    } catch {
      toast("error", "Network error");
      return null;
    }
  }

  /**
   * Send the file with TUS so a dropped mobile connection resumes instead of
   * restarting. `onProgress` is 0..100.
   *
   * The transfer also drives one small toast that lives exactly as long as the
   * upload does: created sticky so it cannot time out mid-transfer, rewritten
   * with the percentage on every chunk, finished off as a success with a real
   * duration once the last byte lands. A creator who scrolls away from the
   * progress bar inside the form still sees how far the upload got — a whole
   * file can take minutes on a phone, and "it is still going" was previously
   * only visible in one place on the page.
   */
  async function uploadToBunny(
    file: File,
    credentials: UploadTarget,
    onProgress: (percent: number) => void,
    signal?: AbortSignal
  ): Promise<boolean> {
    const label = file.name.length > 28 ? `${file.name.slice(0, 27)}…` : file.name;
    const toastId = toast("info", `Uploading ${label} — 0%`, 0);
    // Kept so a retry message can carry the percentage the bar is already
    // showing: a toast rewritten without one drops the bar back to nothing and
    // reads as "it started again".
    let lastPercent = 0;
    const report = (percent: number) => {
      // Every callback is proof the connection is alive — the stall warning is
      // built from these timestamps, so it clears itself the moment bytes move
      // again (a phone coming back from the background resumes here).
      lastPercent = percent;
      lastProgressAt.current = Date.now();
      setUploadStalled(false);
      onProgress(percent);
      updateToast(toastId, {
        message: `Uploading ${label} — ${percent}%`,
        progress: percent,
      });
    };
    /**
     * Between one failed attempt and the next, say so. The backoff is seconds
     * long, and a bar that sits still for that long with no explanation is
     * indistinguishable from the hang this whole file keeps running into — so
     * the retry names the fault (offline, dropped, stalled) instead of waiting
     * silently.
     */
    const onRetry = (info: Pick<TusUploadRetryInfo, "attempt" | "totalAttempts" | "reason">) => {
      lastProgressAt.current = Date.now();
      setUploadStalled(false);
      updateToast(toastId, {
        message: `${describeRetry(info)} · ${label} at ${lastPercent}%`,
        progress: lastPercent,
      });
    };

    const sendProgress = (uploaded: number, total: number) =>
      report(Math.round((uploaded / total) * 100));

    try {
      // ONE PUT, WHEN THE FILE FITS. The proxy hands the whole file to Bunny in
      // a single request, which is the simplest thing the browser can be asked
      // to do — and the only path that works at all where the resumable endpoint
      // is unreachable. Anything larger than the proxy accepts keeps the chunked
      // path: a whole-file PUT that dies has no offset to resume from, so the
      // file size decides which risk is worth taking. See lib/upload-put.ts.
      const proxy = credentials.proxy;
      if (proxy && file.size <= proxy.maxBytes) {
        await uploadFileWithPut(file, proxy, { onProgress: sendProgress, onRetry, signal });
      } else {
        await uploadFileWithTus(file, credentials, {
          onProgress: sendProgress,
          onRetry,
          signal,
        });
      }
      // Done: say so on the same toast, give it a real duration, and let it
      // clear itself. `progress: 100` first so the bar finishes visibly rather
      // than snapping away at 99%.
      updateToast(toastId, {
        type: "success",
        message: `${label} uploaded — 100%`,
        progress: 100,
        duration: 5000,
      });
      return true;
    } catch (error) {
      updateToast(toastId, {
        type: "error",
        message:
          error instanceof TusUploadError
            ? error.message
            : "Upload failed. Please try again.",
        progress: undefined,
        duration: 8000,
      });
      // The bytes went straight to Bunny, so nothing on our side saw this — and
      // the reserved slot is now an orphan in the library. Report it, with
      // Bunny's own status and body, before the tab takes it away.
      void reportUploadFailure(
        describeUploadFailure(error, {
          bunnyVideoId: credentials.videoId,
          fileName: file.name,
          fileSize: file.size,
        })
      );
      return false;
    }
  }

  /**
   * Upload a framed cover and remember its URL on the draft.
   *
   * Called with the cropped file the ImageCropper produced, so the picture we
   * store is exactly the 16:9 frame the creator positioned — no re-cropping by
   * the feed or the profile can move it afterwards.
   */
  async function uploadThumb(file: File) {
    setUploadingThumb(true);
    try {
      const { uploadImage } = await import("@/lib/upload-client");
      // Public: a thumbnail is shown to every visitor on the feed.
      setThumbnailUrl(await uploadImage(file, { kind: "public" }));
    } catch (err) {
      toast("error", err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploadingThumb(false);
    }
  }

  /** Reproduce the upload once a file is final — full or already cut. */
  async function startVideoUpload(file: File) {
    // Refuse an over-limit file BEFORE reserving a Bunny slot: an empty slot
    // that can never be filled still counts against the creator's library.
    const sizeError = videoSizeError(file);
    if (sizeError) {
      toast("error", sizeError);
      return;
    }

    // The length floor, checked here too — and here is where it matters.
    //
    // The rule is on this form and always has been, but nothing enforced it
    // until Bunny reported the real duration, minutes after the creator had
    // spent their data pushing the file. Now that a post is published the
    // moment it is uploaded, an unchecked too-short file would go live and then
    // be taken down — a public post appearing and disappearing over something
    // this line can say in the file picker.
    //
    // Reading the file's own metadata is local: no upload, no request. A
    // container the browser cannot parse answers null, and a null proceeds —
    // refusing a good file is the worse failure, and the server still holds the
    // backstop (refreshVideoEncoding).
    const durationError = shortVideoError(
      await probeVideoDuration(file),
      MIN_VIDEO_DURATION_SECONDS
    );
    if (durationError) {
      toast("error", durationError);
      return;
    }

    setFailedUpload(null);

    // The wake lock is requested HERE, before the reserve POST — not after it,
    // and not when progress starts. Reserve and the first PATCH are one
    // transfer, and the first PATCH can be in flight before the browser emits a
    // single progress event; a screen that locks in that window produces a
    // frozen bar with no error at all, which is the fault this is here to
    // prevent. `mainUploadActive` goes up first so the form reflects it and the
    // file picker locks. (Both guards above have already run, so a file that is
    // refused never wakes the screen for nothing.)
    setMainUploadActive(true);
    await holdScreenAwake();
    try {
      const credentials = await initiateUpload();
      if (!credentials) return;
      await runVideoUpload(file, credentials);
    } finally {
      // A reserve that never produced credentials has no path through
      // runVideoUpload, so the flag would otherwise stay up with nothing behind
      // it — and along with it the wake lock. runVideoUpload clears it on the
      // paths that reach it; clearing twice is harmless.
      setMainUploadActive(false);
    }
  }

  /**
   * Send one file into one already-reserved slot, and remember the pair if it
   * fails.
   *
   * The old flow cleared the reserved id on any failure, which forced a full
   * re-pick AND reserved a second slot while the first sat empty in the library
   * — the "it removes itself, upload it again" the creator saw. Keeping the
   * pair means Retry continues into the same slot.
   */
  async function runVideoUpload(file: File, credentials: UploadTarget) {
    setFailedUpload(null);
    setMainUploadActive(true);
    setUploadStalled(false);
    lastProgressAt.current = Date.now();
    const controller = new AbortController();
    uploadAbortRef.current = controller;

    // The same request as the first path, and not a duplicate of it: this is
    // where the RETRY button lands, with the slot already reserved, so it never
    // passes through startVideoUpload. Both are awaited before a byte is sent.
    await holdScreenAwake();
    try {
      const uploaded = await uploadToBunny(file, credentials, setUploadProgress, controller.signal);
      if (uploaded) {
        setUploadProgress(100);
        setUploadedBytes(file.size);
        setUploadReady(true);
      } else {
        setUploadProgress(0);
        setFailedUpload({ file, credentials });
      }
    } finally {
      if (uploadAbortRef.current === controller) uploadAbortRef.current = null;
      setMainUploadActive(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!uploadReady || !bunnyVideoId || !title) return;

    setUploading(true);
    try {
      const res = await fetch("/api/videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          description,
          price,
          teaserDuration,
          category: category || undefined,
          tags: tags ? tags.split(",").map((t) => t.trim()) : [],
          bunnyVideoId,
          teaserBunnyVideoId: teaserBunnyVideoId || undefined,
          thumbnailUrl: thumbnailUrl || undefined,
          // What the browser just sent, sent again as a fact about the file.
          fileSize: uploadedBytes ?? undefined,
          complianceAttested,
        }),
      });

      const data = await res.json();
      if (data.success) {
        // The post is published the moment this row is written (see
        // /api/videos POST), so this is not "it is live" OR "it is waiting" —
        // it is both at once: visible now with an "Inachakatwa..." badge, and
        // playable the moment Bunny finishes. Carrying the flag through is what
        // lets the confirmation screen say exactly that instead of guessing.
        setAwaitingProcessing(data.data?.encodingStatus !== null);
        setCreatedSlug(data.data?.slug || data.data?.id || "");
        setSuccess(true);
      } else {
        toast(
          "error",
          data.error || "The video reached the host, but the post could not be finalized. Submit again to retry."
        );
      }
    } catch {
      // The POST response may have been lost after the database committed. The
      // server finalizer is idempotent by Bunny video id, so submitting again is
      // safe and does not upload the large file a second time.
      toast("error", "Post finalization was interrupted. Submit again; the video upload is still safe.");
    } finally {
      setUploading(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen">
        <Header />
        <div className="flex items-center justify-center h-[60vh]">
          <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className="min-h-screen">
        <Header />
        <div className="flex items-center justify-center h-[60vh]">
          <div className="text-center">
            <CheckCircle className="w-16 h-16 text-emerald-400 mx-auto mb-4" />
            <h2 className="text-2xl font-display font-bold mb-2">
              {awaitingProcessing ? "Posted — now processing" : "Video Uploaded!"}
            </h2>
            {awaitingProcessing ? (
              <>
                <p className="text-white/60 mb-2 max-w-md">
                  Your post is already live on your profile and in your
                  subscribers&apos; feed, marked{" "}
                  <span className="font-medium text-amber-200">
                    &ldquo;Inachakatwa...&rdquo;
                  </span>
                  . It turns into a playable video on its own — nobody has to
                  reload anything — and you will get a notification when it is
                  ready.
                </p>
                <p className="text-white/40 text-sm mb-6">
                  You can close this page: processing happens on the video host,
                  and your post stays exactly where it is while it finishes.
                </p>
              </>
            ) : (
              <p className="text-white/60 mb-6">
                Your video has been created and is live.
              </p>
            )}
            <div className="flex flex-wrap gap-3 justify-center">
              {createdSlug && (
                <Link href={`/video/${createdSlug}`} className="btn-brand">
                  View post
                </Link>
              )}
              <Link href="/creator" className="btn-ghost">
                Back to Dashboard
              </Link>
              <button
                onClick={() => {
                  setSuccess(false);
                  setTitle("");
                  setBunnyVideoId("");
                  setUploadReady(false);
                  setUploadProgress(0);
                  setUploadedBytes(null);
                  setFailedUpload(null);
                  setCreatedSlug("");
                }}
                className="btn-ghost"
              >
                Upload Another Video
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // The wording of the rules changed after this creator accepted them. Nothing
  // else on the page is reachable until the new version is ticked — the form is
  // simply not rendered, which is stronger than a disabled button.
  if (reAcceptGuidelines) {
    return (
      <div className="min-h-screen">
        <Header />

        <main className="max-w-2xl mx-auto px-4 py-8 space-y-6">
          <div className="flex items-center gap-3">
            <Link href="/creator" className="p-2 rounded-xl hover:bg-white/10 transition">
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <div>
              <h1 className="text-2xl font-display font-bold">Masharti ya Creators</h1>
              <p className="text-white/50 text-sm">
                Tumebadilisha masharti ya creators. Soma na ukubali kila sharti
                kabla ya kuendelea ku-upload.
              </p>
            </div>
          </div>

          <div className="glass-card p-6 space-y-4">
            <div className="flex items-start gap-2">
              <ScrollText className="mt-0.5 h-5 w-5 shrink-0 text-brand-400" />
              <p className="text-sm text-white/60">
                Sheria zilizosasishwa zinaanza kutumika mara moja. Bonyeza kila
                sharti kuonyesha kuwa umelisoma.
              </p>
            </div>

            <div className="space-y-2">
              {CREATOR_GUIDELINES.map((g, i) => (
                <label
                  key={g.id}
                  className={`flex items-start gap-3 rounded-xl border p-3 cursor-pointer transition ${
                    guidelineChecks[g.id]
                      ? "border-emerald-500/40 bg-emerald-500/5"
                      : g.severe
                        ? "border-red-500/30 bg-red-500/5"
                        : "border-white/10 hover:border-white/20"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={!!guidelineChecks[g.id]}
                    onChange={(e) =>
                      setGuidelineChecks((prev) => ({ ...prev, [g.id]: e.target.checked }))
                    }
                    className="mt-1 h-4 w-4 shrink-0 accent-emerald-500"
                  />
                  <div className="space-y-1">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      <span className="text-white/40">{i + 1}.</span>
                      {g.severe && <ShieldAlert className="h-4 w-4 shrink-0 text-red-400" />}
                      <span>{g.sw}</span>
                    </p>
                    <p className="text-xs text-white/50">{g.en}</p>
                  </div>
                </label>
              ))}
            </div>

            <p className="text-xs text-white/50">
              {GUIDELINE_ACK_LABEL_SW}
              <br />
              {GUIDELINE_ACK_LABEL_EN}
            </p>

            <button
              type="button"
              disabled={!allGuidelinesChecked || acceptingGuidelines}
              onClick={async () => {
                setAcceptingGuidelines(true);
                try {
                  const res = await fetch("/api/creator/guidelines/accept", {
                    method: "POST",
                  });
                  const data = await res.json();
                  if (!data.success) {
                    toast("error", data.error || "Could not save your acceptance");
                    return;
                  }
                  setReAcceptGuidelines(false);
                } catch {
                  toast("error", "Network error");
                } finally {
                  setAcceptingGuidelines(false);
                }
              }}
              className="btn-brand w-full"
            >
              {acceptingGuidelines
                ? "Inatuma..."
                : allGuidelinesChecked
                  ? "Nimekubali — endelea"
                  : "Tiki masharti yote ili kuendelea"}
            </button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <Header />

      <main className="max-w-2xl mx-auto px-4 py-8 space-y-6">
        <div className="flex items-center gap-3">
          <Link href="/creator" className="p-2 rounded-xl hover:bg-white/10 transition">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <h1 className="text-2xl font-display font-bold">Upload Video</h1>
            <p className="text-white/50 text-sm">Select a video and fill in the details</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="glass-card p-6 space-y-5">
          {/* Video File */}
          {!uploadReady ? (
            <div>
              <label className="text-sm text-white/60 mb-2 block">Select Video</label>
              <label className="border-2 border-dashed border-white/20 rounded-2xl p-8 text-center cursor-pointer hover:border-brand-500/50 transition">
                <Upload className="w-10 h-10 text-white/30 mx-auto mb-3" />
                <p className="text-sm text-white/60 mb-1">
                  Click here to upload your video
                </p>
                <p className="text-xs text-white/40">
                  MP4, MOV, AVI — Max 2GB
                </p>
                {/* The 8-minute floor is not a price rule, and saying it only
                    above a price hid it from exactly the creators it holds
                    back: a free scene shorter than the floor is never
                    published either (see refreshVideoEncoding). Stated here,
                    before the file is picked, because it cannot be fixed
                    after the upload. */}
                <p className="text-xs text-amber-200/80 mt-2">
                  Every scene must be at least {MIN_VIDEO_DURATION_SECONDS / 60} minutes
                  long — a shorter video never goes live, paid or free.
                </p>
                <input
                  type="file"
                  accept="video/*"
                  className="hidden"
                  // Locked while a transfer is running so a second pick cannot
                  // start a second upload into the same slot.
                  disabled={mainUploadActive || uploadingTeaser}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    // Reset so choosing the same file again still fires.
                    e.target.value = "";
                    if (!file) return;
                    // Straight to the upload: the file is sent exactly as chosen.
                    void startVideoUpload(file);
                  }}
                />
              </label>
              {mainUploadActive && (
                <div className="mt-3">
                  <div className="bg-surface-300/40 rounded-full h-2 overflow-hidden">
                    <div
                      className="bg-brand-500 h-full transition-all duration-300"
                      style={{ width: `${uploadProgress}%` }}
                    />
                  </div>
                  <p className="text-xs text-white/50 mt-1 text-center">
                    Uploading... {uploadProgress}%
                  </p>
                </div>
              )}

              {/* The phone-specific truth, said while it can still help. */}
              {transferring && (
                <div className="mt-3 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3 space-y-1">
                  <p className="text-xs font-medium text-amber-200/90">
                    Keep this page open — do not lock the phone or switch apps.
                  </p>
                  <p className="text-xs leading-relaxed text-amber-200/70">
                    Kwenye simu, video inapanda vizuri ukiacha ukurasa huu mbele,
                    skrini ikiwa imewaka na simu kwenye chaja. Ukifunga skrini au
                    kutoka kwenye ukurasa, browser inasimamisha kupandisha —
                    ukirudi, inaendelea pale ilipoishia.
                  </p>
                  {uploadStalled && (
                    <p className="text-xs font-medium text-amber-100">
                      No bytes have moved for a while. Keep this page in front —
                      if the connection dropped, the upload resumes on its own
                      from where it stopped, and &ldquo;Retry upload&rdquo; continues
                      into the same reserved slot if it does not.
                    </p>
                  )}
                </div>
              )}
              {failedUpload && (
                <div className="mt-3 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <p className="text-xs text-amber-200/80">
                    The upload was interrupted before it finished. Your video is still
                    reserved — try again, or pick a different file.
                  </p>
                  <button
                    type="button"
                    onClick={() => void runVideoUpload(failedUpload.file, failedUpload.credentials)}
                    className="btn-ghost text-xs shrink-0"
                  >
                    Retry upload
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4 flex items-center gap-3">
              <CheckCircle className="w-5 h-5 text-emerald-400" />
              <span className="text-sm text-emerald-400">Video uploaded successfully!</span>
            </div>
          )}

          {/* Title */}
          <div>
            <label className="text-sm text-white/60 mb-2 block flex items-center gap-2">
              <Film className="w-4 h-4" /> Video Title
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Enter video title..."
              className="input-field"
              required
              minLength={3}
            />
          </div>

          {/* Description */}
          <div>
            <label className="text-sm text-white/60 mb-2 block flex items-center gap-2">
              <FileText className="w-4 h-4" /> Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe your video..."
              className="input-field min-h-[100px] resize-y"
              rows={3}
            />
          </div>

          {/* Price & Teaser Duration */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm text-white/60 mb-2 block flex items-center gap-2">
                <DollarSign className="w-4 h-4" /> Price (TZS)
              </label>
              <input
                type="number"
                value={price}
                // The fallback and the floor are the same 500 as the schema's — a
                // form that lets a creator type 100 and then refuses it at submit
                // is a validation error they cannot act on.
                onChange={(e) => setPrice(parseInt(e.target.value) || 500)}
                min={500}
                max={1000000}
                className="input-field"
              />
              <p className="text-xs text-white/40 mt-1">Minimum TZS 500</p>
            </div>
            <div>
              <label className="text-sm text-white/60 mb-2 block">Preview (seconds)</label>
              <input
                type="number"
                value={teaserDuration}
                onChange={(e) => setTeaserDuration(parseInt(e.target.value) || 15)}
                min={15}
                max={30}
                className="input-field"
              />
              <p className="text-xs text-white/40 mt-1">15-30 seconds</p>
            </div>
          </div>

          {/* Category */}
          <div>
            <label className="text-sm text-white/60 mb-2 block">Category</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="input-field"
            >
              <option value="">Select category...</option>
              {CATEGORIES.filter((c) => c.id !== "all").map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>

          {/* Tags */}
          <div>
            <label className="text-sm text-white/60 mb-2 block flex items-center gap-2">
              <Tag className="w-4 h-4" /> Tags (comma separated)
            </label>
            <input
              type="text"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="music, tanzania, africa..."
              className="input-field"
            />
          </div>

          {/* Thumbnail — chosen from the creator's own files and framed before
              it is saved. There is deliberately no URL field here: the cover is
              a picture we host, and a pasted link to somebody else's host could
              break, change or disappear under the viewer. */}
          <div>
            <label className="text-sm text-white/60 mb-2 block">Thumbnail</label>
            <label className="flex items-center gap-3 cursor-pointer border-2 border-dashed border-white/20 rounded-xl p-4 hover:border-brand-500/50 transition">
              <span className="text-lg" aria-hidden>
                🖼️
              </span>
              <span className="text-sm text-white/70">
                {uploadingThumb
                  ? "Uploading..."
                  : thumbnailUrl
                  ? "Replace thumbnail"
                  : "Choose an image"}
              </span>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                disabled={uploadingThumb}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  // Reset so choosing the same file again still fires.
                  e.target.value = "";
                  if (!file) return;
                  if (!file.type.startsWith("image/")) {
                    toast("error", "Please choose an image file");
                    return;
                  }
                  // Frame it as the 16:9 cover every viewer will see.
                  setThumbCropFile(file);
                }}
              />
            </label>
            <p className="text-xs text-white/40 mt-2">
              JPEG, PNG or WebP, up to 10 MB — a big photo is shrunk to fit
              automatically. You can move and zoom the picture
              before it is saved, so it looks exactly as you want it on the feed.
            </p>
            {thumbnailUrl && (
              // The cover is shown as a 16:9 shape wherever a viewer meets it, so
              // the preview uses the same shape — what the creator framed is what
              // they see here and what the profile shows.
              <Image
                src={thumbnailUrl}
                alt="Thumbnail preview"
                width={320}
                height={180}
                unoptimized={!canOptimizeImage(thumbnailUrl)}
                className="mt-2 aspect-video w-full max-w-xs object-cover rounded-lg"
              />
            )}
          </div>

          {/* Teaser / trailer clip — what non-buyers get to watch */}
          <div>
            <label className="label-field" htmlFor="teaser-upload">
              Teaser clip {price === 0 ? "(optional — free videos preview in full)" : "(recommended)"}
            </label>
            <p className="text-xs text-white/45 mb-3 leading-relaxed">
              A short clip (10–30s) that people who have not paid can watch. Upload your video
              without one and it shows only a poster, because we cannot show part of the main
              video without giving the whole thing away.
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <label
                htmlFor="teaser-upload"
                className="btn-ghost cursor-pointer inline-flex items-center gap-2 text-sm"
              >
                <span aria-hidden>🎬</span>
                <span>
                  {uploadingTeaser
                    ? `Uploading… ${teaserProgress}%`
                    : teaserBunnyVideoId
                      ? "Replace teaser clip"
                      : "Choose a teaser clip"}
                </span>
                <input
                  id="teaser-upload"
                  type="file"
                  accept="video/*"
                  className="hidden"
                  disabled={uploadingTeaser}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    // Reset so choosing the same file again still fires.
                    e.target.value = "";
                    if (!file) return;
                    const sizeError = videoSizeError(file);
                    if (sizeError) {
                      toast("error", sizeError);
                      return;
                    }
                    setUploadingTeaser(true);
                    setTeaserProgress(0);
                    const controller = new AbortController();
                    uploadAbortRef.current = controller;
                    // Named out here so the catch below can report the slot that
                    // was reserved and then abandoned.
                    let teaserSlot: UploadTarget | null = null;
                    try {
                      // Same flow as the main video — reserve a slot, then send
                      // it the way the file size allows. The trailer used to be
                      // TUS-only, which meant the one transfer that works where
                      // the resumable endpoint does not was not offered for it.
                      const res = await fetch("/api/videos/upload-signature", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ title: `${title || "teaser"} (teaser)` }),
                        signal: controller.signal,
                      });
                      const data = await res.json();
                      if (!data.success) {
                        toast("error", data.error || "Could not start the teaser upload");
                        return;
                      }

                      teaserSlot = data.data as UploadTarget;
                      const teaserProgress = (uploaded: number, total: number) =>
                        setTeaserProgress(Math.round((uploaded / total) * 100));
                      const proxy = teaserSlot.proxy;

                      if (proxy && file.size <= proxy.maxBytes) {
                        await uploadFileWithPut(file, proxy, {
                          onProgress: teaserProgress,
                          signal: controller.signal,
                        });
                      } else {
                        await uploadFileWithTus(file, teaserSlot, {
                          onProgress: teaserProgress,
                          signal: controller.signal,
                        });
                      }

                      setTeaserBunnyVideoId(teaserSlot.videoId);
                      toast("success", "Teaser clip uploaded");
                    } catch (error) {
                      toast(
                        "error",
                        error instanceof TusUploadError
                          ? error.message
                          : "Network error while uploading the teaser"
                      );
                      // Same reason as the main upload: this transfer also went
                      // straight to Bunny, and a failed one is invisible here.
                      void reportUploadFailure(
                        describeUploadFailure(error, {
                          bunnyVideoId: teaserSlot?.videoId ?? null,
                          fileName: file.name,
                          fileSize: file.size,
                        })
                      );
                    } finally {
                      if (uploadAbortRef.current === controller) uploadAbortRef.current = null;
                      setUploadingTeaser(false);
                    }
                  }}
                />
              </label>

              {teaserBunnyVideoId && (
                <button
                  type="button"
                  className="text-xs text-white/50 hover:text-white transition"
                  onClick={() => {
                    setTeaserBunnyVideoId("");
                    setTeaserProgress(0);
                  }}
                >
                  Remove teaser
                </button>
              )}
            </div>

            {teaserBunnyVideoId && (
              <p className="text-xs text-emerald-400/80 mt-2">
                Teaser clip attached — non-buyers will see this instead of the full video.
              </p>
            )}
          </div>

          {/* 18 U.S.C. § 2257 attestation — the server rejects the upload without it */}
          <label className="flex items-start gap-3 p-3 rounded-xl border border-white/10 cursor-pointer">
            <input
              type="checkbox"
              checked={complianceAttested}
              onChange={(e) => setComplianceAttested(e.target.checked)}
              className="mt-0.5 w-4 h-4 accent-brand-500 shrink-0"
            />
            <span className="text-xs text-white/60 leading-relaxed">
              I confirm that every person appearing in this video was 18 years or older at the time
              of filming, that I hold signed consent and government-issued photo ID for each of
              them, and that I can produce those records on request (18 U.S.C. § 2257).
            </span>
          </label>

          <button
            type="submit"
            disabled={uploading || !uploadReady || !title || !complianceAttested}
            className="btn-brand w-full"
          >
            {uploading ? "Creating..." : "Create Video"}
          </button>
        </form>

        {thumbCropFile && (
          <ImageCropper
            file={thumbCropFile}
            shape="wide"
            confirmLabel="Save thumbnail"
            busy={uploadingThumb}
            onCancel={() => setThumbCropFile(null)}
            onConfirm={(cropped) => {
              setThumbCropFile(null);
              void uploadThumb(cropped);
            }}
          />
        )}

      </main>
    </div>
  );
}
