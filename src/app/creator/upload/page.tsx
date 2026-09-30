"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Camera,
  Check,
  CheckCircle,
  Clock,
  Coins,
  Eye,
  FileVideo,
  Film,
  FolderOpen,
  Image as ImageIcon,
  Images,
  Info,
  ListChecks,
  Loader2,
  Rocket,
  ShieldAlert,
  Sparkles,
  Type,
  Upload,
  X,
} from "lucide-react";
import Header from "@/components/Header";
import ImageCropper from "@/components/ImageCropper";
import { fetchCurrentUser } from "@/lib/current-user";
import { useToast } from "@/components/Toast";
import { uploadImage } from "@/lib/upload-client";
import { ANY_FILE_ACCEPT, IMAGE_ACCEPT, VIDEO_ACCEPT, classifyFile, isLikelyCloudCopy } from "@/lib/media";
import { CATEGORIES } from "@/lib/categories";
import {
  CREATOR_GUIDELINES,
  CREATOR_GUIDELINES_VERSION,
  GUIDELINE_ACK_LABEL_EN,
  GUIDELINE_ACK_LABEL_SW,
  needsGuidelineAcceptance,
} from "@/lib/creator-guidelines";
import {
  abortVideoUpload,
  assertFileReadable,
  completeVideoUpload,
  openVideoUpload,
  uploadVideoFile,
  videoFileSizeError,
  VideoUploadError,
  type OpenedVideoUpload,
  type VideoUploadProgress,
  type VideoUploadSession,
} from "@/lib/video-upload";
import { reportUploadFailure } from "@/lib/upload-failure-report";
import { cn } from "@/lib/utils";

type UploadKind = "main" | "teaser";

/** Which picker a refused file came from, so the retry can reopen the right one. */
type PickerTarget = "main" | "teaser" | "cover";

/**
 * Said before an upload whose file name gives it away, not after it fails.
 *
 * A ten-digit name with an ordinary extension is the shape Google Photos and
 * Drive downloads take on Android, and those are the files a phone most often
 * cannot hand over — the live case this was written from was a 192 MB video with
 * exactly that name, unreadable on two different networks. It is a warning and
 * never a refusal: a file that really is a local copy uploads normally, and
 * nothing is lost by mentioning it.
 */
const CLOUD_COPY_WARNING =
  "Faili hii inaweza kuwa ya cloud. Ikishindwa, ihamishe kwenye Downloads.";

/**
 * What a creator is told when a PICTURE cannot be read.
 *
 * The transport's own sentence is written for a video ("could not read the video
 * file"), and a creator standing on the cover picker being told about a video
 * file would be reading about the wrong thing. The admin record keeps the
 * transport's words — only the sentence on screen changes.
 */
const COVER_UNREADABLE =
  "This device could not read that picture, so nothing was sent. Move it into the " +
  "phone's own storage (Downloads) and choose it again.";

interface UserData {
  role: string;
  kycStatus: string;
  guidelinesAcceptedVersion?: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function percent(progress: VideoUploadProgress | null): number {
  return progress?.percent ?? 0;
}

/**
 * What to put in the toast when a transfer dies.
 *
 * The transport's messages already name the fault and how far the file got, so
 * they are passed through unchanged. This exists for the rest: an error thrown
 * before the transport was reached must not borrow the transport's words.
 */
function failureMessageFor(error: unknown): string {
  return error instanceof VideoUploadError ? error.message : "The video upload failed. Try again.";
}

export default function UploadPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<UserData | null>(null);
  const [acceptingGuidelines, setAcceptingGuidelines] = useState(false);
  const [checks, setChecks] = useState<Record<string, boolean>>({});

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState(1000);
  const [teaserDuration, setTeaserDuration] = useState(15);
  const [category, setCategory] = useState("");
  const [tags, setTags] = useState("");
  const [complianceAttested, setComplianceAttested] = useState(false);

  const [mainFile, setMainFile] = useState<File | null>(null);
  const [mainSession, setMainSession] = useState<OpenedVideoUpload | null>(null);
  const [mainProgress, setMainProgress] = useState<VideoUploadProgress | null>(null);
  const [mainUploading, setMainUploading] = useState(false);
  const [mainReady, setMainReady] = useState(false);
  const [bunnyVideoId, setBunnyVideoId] = useState("");

  const [teaserFile, setTeaserFile] = useState<File | null>(null);
  const [teaserSession, setTeaserSession] = useState<OpenedVideoUpload | null>(null);
  const [teaserProgress, setTeaserProgress] = useState<VideoUploadProgress | null>(null);
  const [teaserUploading, setTeaserUploading] = useState(false);
  const [teaserVideoId, setTeaserVideoId] = useState("");

  const [thumbnailUrl, setThumbnailUrl] = useState("");
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [thumbnailUploading, setThumbnailUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<{ slug: string; processing: boolean } | null>(null);

  /**
   * The pictures the creator picked for the cover, before one of them is used.
   *
   * Candidates, not uploads: only the picture that becomes the cover is sent to
   * storage, so choosing ten photos from the gallery leaves one object in the
   * zone rather than ten. Their object URLs are held so the strip can show what
   * was chosen.
   */
  const [coverCandidates, setCoverCandidates] = useState<{ file: File; url: string }[]>([]);
  /**
   * The file that was refused because the device could not read it.
   *
   * Shown with a button that reopens the untitled picker, because "move it into
   * Downloads and choose it again" is advice the creator can only act on if the
   * picker that sees Downloads is one tap away.
   */
  const [blocked, setBlocked] = useState<{ target: PickerTarget; message: string } | null>(null);

  /** The three unfiltered pickers, so a refusal can reopen the right one. */
  const mainFilesRef = useRef<HTMLInputElement>(null);
  const teaserFilesRef = useRef<HTMLInputElement>(null);
  const coverFilesRef = useRef<HTMLInputElement>(null);

  const allGuidelinesChecked = CREATOR_GUIDELINES.every((item) => checks[item.id]);

  /**
   * Revoke the previews when the page goes away.
   *
   * Read through a ref rather than from the state the effect closed over: an
   * effect that only cleans up on unmount would capture the empty array it was
   * created with and revoke nothing, and an object URL that outlives its element
   * holds the WHOLE file in memory for the life of the page — which on a 192 MB
   * video cover is not a small leak.
   */
  const coverCandidatesRef = useRef(coverCandidates);
  useEffect(() => {
    coverCandidatesRef.current = coverCandidates;
  }, [coverCandidates]);
  useEffect(
    () => () => {
      for (const candidate of coverCandidatesRef.current) URL.revokeObjectURL(candidate.url);
    },
    []
  );

  const checkAccess = useCallback(async () => {
    try {
      const response = await fetchCurrentUser();
      const body = await response.json();
      const data = body.data as UserData | undefined;
      if (!body.success || !data || data.role !== "CREATOR") {
        router.replace("/");
        return;
      }
      if (data.kycStatus !== "APPROVED") {
        router.replace("/creator/kyc");
        return;
      }
      setUser(data);
    } catch {
      router.replace("/login");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void checkAccess();
  }, [checkAccess]);

  async function acceptGuidelines() {
    setAcceptingGuidelines(true);
    try {
      const response = await fetch("/api/creator/guidelines/accept", { method: "POST" });
      const body = await response.json();
      if (!body.success) {
        toast("error", body.error || "Could not save your acceptance");
        return;
      }
      setUser((current) =>
        current ? { ...current, guidelinesAcceptedVersion: CREATOR_GUIDELINES_VERSION } : current
      );
    } catch {
      toast("error", "Network error while saving your acceptance");
    } finally {
      setAcceptingGuidelines(false);
    }
  }

  /**
   * Reserve a slot, then open the upload from HERE.
   *
   * The second half is not optional. Bunny serves a TUS resource only to the
   * network that opened it, so a URL opened by the application server is a 404
   * to every later request this browser makes — the fault that stalled real
   * uploads at a few percent while the server that opened them saw a healthy
   * resource. See `openVideoUpload`.
   */
  async function createSession(file: File, kind: UploadKind): Promise<OpenedVideoUpload | null> {
    try {
      const response = await fetch("/api/videos/upload-signature", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `${title.trim() || file.name.replace(/\.[^.]+$/, "") || "Video"}${kind === "teaser" ? " (teaser)" : ""}`,
          size: file.size,
          mimeType: file.type || "video/mp4",
        }),
      });
      const body = await response.json();
      if (!response.ok || !body.success) {
        toast("error", body.error || "Could not start the video upload");
        return null;
      }
      return await openVideoUpload(body.data as VideoUploadSession);
    } catch (error) {
      toast(
        "error",
        error instanceof VideoUploadError ? error.message : "Could not reach Genhub to start the upload"
      );
      return null;
    }
  }

  async function uploadOne(
    file: File,
    kind: UploadKind,
    existing: OpenedVideoUpload | null
  ): Promise<{
    session: OpenedVideoUpload | null;
    videoId: string;
    /**
     * True when the session this upload was using no longer exists at the host.
     *
     * Kept on the result rather than acted on in here, because the caller sets
     * the state and would otherwise write the dead session straight back over
     * the clearing. It matters because "Resume upload" re-uses exactly this
     * session: a dead one left in state turns every later press into the same
     * 404, which is the loop the admin panel recorded four times in fifteen
     * minutes.
     */
    discardSession: boolean;
  } | null> {
    const setProgress = kind === "main" ? setMainProgress : setTeaserProgress;
    let session = existing ?? (await createSession(file, kind));
    if (!session) return null;

    /**
     * Send the file, asking for an offset only when there is one to ask about.
     *
     * A session created a moment ago holds nothing, so its first request is the
     * upload itself; a session already in hand is the one whose position can have
     * moved, and that is the only case worth a round trip.
     */
    async function send(target: OpenedVideoUpload, from?: number) {
      setProgress({ uploadedBytes: from ?? 0, totalBytes: file.size, percent: 0 });
      await uploadVideoFile(file, target, {
        onProgress: setProgress,
        ...(from === undefined ? {} : { offset: from }),
      });
    }

    /**
     * One restart is allowed, and only one.
     *
     * The video host closes an upload the moment it decides the transfer is
     * over, and the admin panel has now recorded a live case of it: a 192 MB
     * video whose session was gone by the time the page asked where it had got
     * to. There is no offset worth keeping in that state — the resource no
     * longer exists — so the only move is a fresh session and the bytes again
     * from zero. Doing it here rather than telling the creator to do it is the
     * difference between a recovery and a dead end: "choose the video again"
     * re-picks the SAME file, which reuses the SAME dead session, and nothing
     * about that changes until the page stops asking the question.
     *
     * The guard is on the flag, not on where the session came from: a session
     * the page created a moment ago dies the same way and deserves the same one
     * attempt. It cannot loop, because the retry is outside this try.
     */
    let restarted = false;

    try {
      try {
        await send(session, existing ? undefined : 0);
      } catch (error) {
        if (!(error instanceof VideoUploadError) || error.code !== "EXPIRED" || restarted) {
          throw error;
        }
        restarted = true;
        // Said out loud, because the progress bar is about to go back to zero
        // and a bar that resets with no explanation reads as data lost.
        toast(
          "warning",
          "The video host closed that upload, so it is being sent again from the start."
        );
        session = await createSession(file, kind);
        if (!session) return null;
        await send(session, 0);
      }
      const videoId = await completeVideoUpload(session.sessionToken);
      setProgress({ uploadedBytes: file.size, totalBytes: file.size, percent: 100 });
      return { session, videoId, discardSession: false };
    } catch (error) {
      // This is the only record a failed upload will ever have. The bytes went
      // straight to Bunny and no video row exists yet, so without this the
      // failure lives and dies in the creator's toast — which is exactly how a
      // library accumulated orphaned slots that nobody could explain.
      reportUploadFailure(error, { session, file, kind });
      const message = failureMessageFor(error);
      toast("error", message);
      // A session the host has closed holds no bytes worth resuming, and keeping
      // it is what makes the next attempt fail the same way. Any other failure
      // keeps it, because that is the whole point of a resumable upload: the
      // bytes already at Bunny are still there and the retry continues from them.
      const dead = error instanceof VideoUploadError && error.code === "EXPIRED";
      // A file this device cannot read fails identically on every attempt, and
      // the slot it reserved holds nothing, so the session is CLOSED rather than
      // kept. Closing it deletes the empty Bunny object (see
      // abortVideoUploadSession) and leaves the creator one instruction on
      // screen instead of a Resume button that cannot work — which is how this
      // creator came to hold a slot per attempt.
      const unreadable = error instanceof VideoUploadError && error.reason === "unreadable";
      if (unreadable) await cancelSession(session);
      return { session, videoId: "", discardSession: dead || unreadable };
    }
  }

  /**
   * The device's own answer about a file, asked on the file itself.
   *
   * A file the phone cannot read fails at the first PATCH with the same
   * `TypeError: Failed to fetch` a dropped connection produces, so without this
   * the creator learns the truth only after typing a title and reserving a slot
   * — and every attempt at a cloud-backed file leaves another orphan behind.
   * Asked here, the answer arrives while they are still looking at the picker.
   */
  async function readableOrBlock(
    file: File,
    target: PickerTarget,
    reportKind?: UploadKind
  ): Promise<boolean> {
    try {
      await assertFileReadable(file);
      return true;
    } catch (error) {
      // A picture is not a video and the transport's sentence says it is.
      const message =
        target === "cover"
          ? COVER_UNREADABLE
          : error instanceof Error
            ? error.message
            : "That file could not be read";
      setBlocked({ target, message });
      toast("error", message);
      // Reported for the two video doors only: the admin failure feed is about
      // video uploads, and a cover picture never reserves a slot.
      if (reportKind) reportUploadFailure(error, { file, kind: reportKind });
      return false;
    }
  }

  /** Reopen one of the three pickers — the retry a refusal offers. */
  function openPicker(target: PickerTarget) {
    const ref =
      target === "main" ? mainFilesRef : target === "teaser" ? teaserFilesRef : coverFilesRef;
    ref.current?.click();
  }

  /** Drop one candidate, and its preview with it. */
  function removeCoverCandidate(index: number) {
    setCoverCandidates((current) => {
      const removed = current[index];
      if (removed) URL.revokeObjectURL(removed.url);
      return current.filter((_, position) => position !== index);
    });
  }

  /**
   * Cover pictures, however many the creator chose at once.
   *
   * Every one is classified — a video picked here is refused out loud rather
   * than sent to be cropped — and probed with `assertFileReadable` before
   * anything else, because the picker that can see the whole device can also see
   * the cloud. Only the first is opened in the cropper straight away, since the
   * first picture is nearly always the intended cover; the rest wait as
   * thumbnails and tapping one makes it the cover instead.
   */
  async function handleCoverFiles(files: File[]) {
    if (!files.length) return;
    const accepted: { file: File; url: string }[] = [];

    for (const file of files) {
      if (classifyFile(file) !== "image") {
        toast("error", `"${file.name}" is not a picture. Chagua picha ya aina yoyote.`);
        continue;
      }
      if (isLikelyCloudCopy(file.name)) toast("warning", CLOUD_COPY_WARNING);
      if (!(await readableOrBlock(file, "cover"))) continue;
      accepted.push({ file, url: URL.createObjectURL(file) });
    }

    if (!accepted.length) return;
    setBlocked(null);
    setCoverCandidates((current) => [...current, ...accepted]);
    setCropFile(accepted[0].file);
  }

  async function handleMainFile(file: File, resumeExisting = false) {
    // Everything the picker handed over, in the order that fails cheapest: what
    // the file IS, whether this device can read it, and only then whether it is
    // the right size. A RESUMED upload skips all three — its bytes are already
    // at Bunny, and a re-read refusing a file whose first half is stored would
    // be the worst outcome available here.
    if (!resumeExisting) {
      const kind = classifyFile(file);
      if (kind !== "video") {
        toast(
          "error",
          kind === "image"
            ? "That is a picture, not a video. Use the cover picker for pictures."
            : `"${file.name}" is not a video. Choose an MP4, MOV, MKV or WebM file.`
        );
        return;
      }
      if (isLikelyCloudCopy(file.name)) toast("warning", CLOUD_COPY_WARNING);
      if (!(await readableOrBlock(file, "main", "main"))) return;
      setBlocked(null);
    }

    const sizeError = videoFileSizeError(file);
    if (sizeError) {
      toast("error", sizeError);
      return;
    }

    // Choosing a file is always a new upload. Reusing a session is reserved for
    // the explicit Resume button: a file picker retry must never accidentally
    // send a HEAD to a dead Bunny resource and turn a fresh attempt into HTTP
    // 404. `reuse` is captured before any state is reset because setState is
    // asynchronous: the old `mainSession` is still the one in this closure.
    const reuse =
      resumeExisting &&
      mainSession &&
      mainFile?.name === file.name &&
      mainFile?.size === file.size
        ? mainSession
        : null;
    if (mainSession && !reuse) {
      await cancelSession(mainSession);
      setMainSession(null);
    }
    setMainFile(file);
    setMainReady(false);
    setBunnyVideoId("");
    setMainUploading(true);
    try {
      // No length gate. Every scene used to be measured here and refused under
      // eight minutes, which decided for a creator what was worth uploading and
      // cost them the upload they had already started. Eight minutes or more is
      // still what the guidelines RECOMMEND (see lib/creator-guidelines), and a
      // recommendation belongs on the guidelines screen — not as a wall in front
      // of the file they just chose on a phone.
      const result = await uploadOne(file, "main", reuse);
      if (!result) {
        // Do not leave a dead session behind when the replacement reservation
        // itself fails; Resume would otherwise repeat the same Bunny 404.
        if (reuse) setMainSession(null);
        return;
      }
      setMainSession(result.discardSession ? null : result.session);
      if (!result.videoId) return;
      setBunnyVideoId(result.videoId);
      setMainReady(true);
      toast("success", "Video uploaded successfully");
    } finally {
      setMainUploading(false);
    }
  }

  async function handleTeaserFile(file: File, resumeExisting = false) {
    if (!mainReady) {
      toast("error", "Upload the main video first");
      return;
    }
    if (!resumeExisting) {
      const kind = classifyFile(file);
      if (kind !== "video") {
        toast(
          "error",
          kind === "image"
            ? "That is a picture, not a clip. Choose a short video for the trailer."
            : `"${file.name}" is not a video. Choose an MP4, MOV, MKV or WebM file.`
        );
        return;
      }
      if (isLikelyCloudCopy(file.name)) toast("warning", CLOUD_COPY_WARNING);
      if (!(await readableOrBlock(file, "teaser", "teaser"))) return;
      setBlocked(null);
    }

    const sizeError = videoFileSizeError(file);
    if (sizeError) {
      toast("error", sizeError);
      return;
    }
    const reuse =
      resumeExisting &&
      teaserSession &&
      teaserFile?.name === file.name &&
      teaserFile?.size === file.size
        ? teaserSession
        : null;
    if (teaserSession && !reuse) {
      await cancelSession(teaserSession);
      setTeaserSession(null);
    }
    setTeaserFile(file);
    setTeaserVideoId("");
    setTeaserUploading(true);
    try {
      const result = await uploadOne(file, "teaser", reuse);
      if (!result) {
        if (reuse) setTeaserSession(null);
        return;
      }
      setTeaserSession(result.discardSession ? null : result.session);
      if (!result.videoId) return;
      setTeaserVideoId(result.videoId);
      toast("success", "Teaser uploaded successfully");
    } finally {
      setTeaserUploading(false);
    }
  }

  async function cancelSession(session: VideoUploadSession | null) {
    if (session) await abortVideoUpload(session.sessionToken);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!mainReady || !mainSession || !bunnyVideoId) {
      toast("error", "Upload the main video completely first");
      return;
    }
    if (!complianceAttested) {
      toast("error", "Confirm the 18+ records statement before publishing");
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch("/api/videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          description,
          price,
          teaserDuration,
          category: category || undefined,
          tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
          bunnyVideoId,
          teaserBunnyVideoId: teaserVideoId || undefined,
          thumbnailUrl: thumbnailUrl || undefined,
          fileSize: mainFile?.size,
          uploadSessionToken: mainSession.sessionToken,
          teaserUploadSessionToken: teaserVideoId ? teaserSession?.sessionToken : undefined,
          complianceAttested,
        }),
      });
      const body = await response.json();
      if (!response.ok || !body.success) {
        toast("error", body.error || "The video uploaded but could not be published");
        return;
      }
      setSuccess({ slug: body.data.slug || body.data.id, processing: body.data.status === "PROCESSING" });
    } catch {
      toast("error", "The video uploaded, but publishing could not be confirmed. Press publish again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleThumbnail(file: File) {
    setThumbnailUploading(true);
    try {
      setThumbnailUrl(await uploadImage(file, { kind: "public" }));
      toast("success", "Cover image uploaded");
    } catch (error) {
      toast("error", error instanceof Error ? error.message : "Cover image upload failed");
    } finally {
      setThumbnailUploading(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen">
        <Header />
        <div className="flex justify-center py-32"><Loader2 className="animate-spin" /></div>
      </div>
    );
  }

  if (!user) return null;

  if (needsGuidelineAcceptance(user.guidelinesAcceptedVersion)) {
    return (
      <div className="min-h-screen">
        <Header />
        <main className="max-w-3xl mx-auto px-4 py-8">
          <Link href="/creator" className="inline-flex items-center gap-2 text-white/60 mb-6"><ArrowLeft className="w-4 h-4" /> Back</Link>
          <div className="glass-card p-6 space-y-6">
            <div><h1 className="text-2xl font-bold">Creator guidelines</h1><p className="text-white/60 mt-2">Soma na ukubali masharti haya kabla ya ku-upload.</p></div>
            <div className="space-y-3">
              {CREATOR_GUIDELINES.map((item) => (
                <label key={item.id} className="flex gap-3 rounded-xl border border-white/10 p-4 cursor-pointer">
                  <input type="checkbox" checked={Boolean(checks[item.id])} onChange={(e) => setChecks((current) => ({ ...current, [item.id]: e.target.checked }))} className="mt-1" />
                  <span><span className="block text-white/90">{item.sw}</span><span className="block text-sm text-white/50 mt-1">{item.en}</span></span>
                </label>
              ))}
            </div>
            <button type="button" disabled={!allGuidelinesChecked || acceptingGuidelines} onClick={() => void acceptGuidelines()} className="btn-brand w-full disabled:opacity-50">
              {acceptingGuidelines ? "Saving…" : `${GUIDELINE_ACK_LABEL_SW} / ${GUIDELINE_ACK_LABEL_EN}`}
            </button>
          </div>
        </main>
      </div>
    );
  }

  if (success) {
    return (
      <div className="min-h-screen">
        <Header />
        <main className="max-w-xl mx-auto px-4 py-20 text-center">
          <div className="glass-card p-10">
            <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/15 ring-1 ring-emerald-400/30">
              <CheckCircle className="w-9 h-9 text-emerald-400" />
            </div>
            <h1 className="text-2xl font-display font-bold text-gradient">Video published</h1>
            <p className="text-white/60 mt-3">
              {success.processing
                ? "It is processing now and will become playable automatically."
                : "Your video is live on your storefront."}
            </p>
            <div className="flex flex-wrap justify-center gap-3 mt-8">
              <Link href={`/video/${success.slug}`} className="btn-brand inline-flex items-center gap-2">
                <Eye className="w-4 h-4" /> View video
              </Link>
              <Link href="/creator" className="btn-ghost border border-white/10 inline-flex items-center gap-2">
                Back to dashboard
              </Link>
            </div>
          </div>
        </main>
      </div>
    );
  }

  const mainPercent = percent(mainProgress);
  const teaserPercent = percent(teaserProgress);

  /**
   * Which studio step the creator is standing on. Derived from the form
   * itself rather than from a click, so the rail never lies: it advances the
   * moment the fact behind a step becomes true and never moves backwards.
   */
  const currentStep = !mainReady ? 1 : title.trim().length < 3 ? 2 : !complianceAttested ? 3 : 4;
  const canPublish = Boolean(mainReady && title.trim() && complianceAttested);

  return (
    <div className="min-h-screen">
      <Header />
      <main className="max-w-6xl mx-auto px-4 py-8">
        <Link href="/creator" className="inline-flex items-center gap-2 text-white/60 hover:text-white mb-6 transition">
          <ArrowLeft className="w-4 h-4" /> Back to dashboard
        </Link>

        {/* Title block — the studio header a creator lands on. */}
        <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-3xl font-display font-bold text-gradient">Studio</h1>
            <p className="text-white/50 mt-1">
              Publish a scene to your storefront. The transfer goes straight to the video host and
              resumes from the last saved chunk if the connection drops.
            </p>
          </div>
          <span className="badge-info inline-flex items-center gap-1.5 shrink-0 py-1.5 px-3">
            <Clock className="w-3.5 h-3.5" /> Hakuna kikomo cha urefu · No length limit
          </span>
        </div>

        <UploadStepper current={currentStep} />

        <form
          onSubmit={(e) => void submit(e)}
          className="mt-6 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-6 items-start"
        >
          {/* ---- Left column: the work itself, in the order it happens ---- */}
          <div className="space-y-6 min-w-0">
            {/* The refusal, where the creator is already looking. The sentence is
                the transport's own; the button is the part that makes it
                actionable, because "move it to Downloads" needs the picker that
                can see Downloads to be one tap away. */}
            {blocked && (
              <div className="rounded-2xl border border-amber-400/30 bg-amber-400/5 p-4 space-y-3">
                <p className="text-sm text-amber-100">{blocked.message}</p>
                <button type="button" className="btn-ghost text-sm inline-flex items-center gap-2 border border-white/10" onClick={() => openPicker(blocked.target)}>
                  <FolderOpen className="w-4 h-4" /> Open the Files picker / Fungua Files picker
                </button>
              </div>
            )}

            {/* ---- Step 1: the main video ---- */}
            <section className="glass-card overflow-hidden">
              <SectionHeader
                icon={<Film className="w-5 h-5" />}
                step={1}
                title="Main video"
                subtitle="The full scene your viewers unlock. Any length, any format we can play."
              />
              <div className="p-5 space-y-4">
                <label className="group block cursor-pointer rounded-2xl border-2 border-dashed border-white/15 bg-white/[0.02] p-8 text-center transition hover:border-brand-400/60 hover:bg-brand-500/5">
                  <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-500/15 ring-1 ring-brand-400/20 transition group-hover:scale-105">
                    <Upload className="w-7 h-7 text-brand-400" />
                  </div>
                  <span className="block text-lg font-semibold">Choose your video</span>
                  <span className="block text-sm text-white/50 mt-1">MP4 · MOV · MKV · WebM — up to 2 GB</span>
                  <span className="mt-3 inline-flex items-center gap-1.5 text-xs text-amber-200/80">
                    <Info className="w-3.5 h-3.5" /> Chagua kutoka Downloads au Internal storage — usichague Google Photos au Drive.
                  </span>
                  {/* Untyped on purpose, and it is the FIRST door rather than the
                      last resort: a type filter is applied by the phone's own file
                      index, so the picker that shows Photos can hide a video that
                      is sitting in Downloads — and the creator has no way to tell
                      that from the file not being there. */}
                  <input ref={mainFilesRef} type="file" accept={ANY_FILE_ACCEPT} className="hidden" disabled={mainUploading} onChange={(e) => { const file = e.target.files?.[0]; if (file) void handleMainFile(file); e.currentTarget.value = ""; }} />
                </label>

                <div className="flex flex-wrap items-center gap-2">
                  {/* The typed door, for the creators who keep their videos in the
                      gallery — where a MIME filter is a help and not a hiding place. */}
                  <label className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-white/60 cursor-pointer transition hover:border-brand-400/40 hover:text-white">
                    <Images className="w-4 h-4" /> Choose from Gallery / Photos
                    <input type="file" accept={VIDEO_ACCEPT} className="hidden" disabled={mainUploading} onChange={(e) => { const file = e.target.files?.[0]; if (file) void handleMainFile(file); e.currentTarget.value = ""; }} />
                  </label>
                  <label className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-white/60 cursor-pointer transition hover:border-brand-400/40 hover:text-white">
                    <Camera className="w-4 h-4" /> Record now
                    {/* `capture` hands the camera straight to the creator, and a
                        recording is the one file that is local by construction. */}
                    <input type="file" accept="video/*" capture="environment" className="hidden" disabled={mainUploading} onChange={(e) => { const file = e.target.files?.[0]; if (file) void handleMainFile(file); e.currentTarget.value = ""; }} />
                  </label>
                </div>

                {mainFile && (
                  <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm">
                    <span className="flex items-center gap-2 min-w-0">
                      <FileVideo className="w-4 h-4 text-brand-400 shrink-0" />
                      <span className="truncate">{mainFile.name}</span>
                      <span className="text-white/40 shrink-0">{formatBytes(mainFile.size)}</span>
                    </span>
                    {mainReady ? (
                      <span className="text-emerald-400 flex items-center gap-1 shrink-0 font-medium">
                        <Check className="w-4 h-4" /> Ready
                      </span>
                    ) : null}
                  </div>
                )}

                {(mainUploading || mainProgress) && !mainReady && (
                  <ProgressBar percent={mainPercent} label={mainUploading ? "Uploading" : "Upload incomplete — press Resume to continue"} />
                )}
                {mainSession && !mainReady && !mainUploading && (
                  <button type="button" className="btn-ghost text-sm border border-white/10 inline-flex items-center gap-2" onClick={() => mainFile && void handleMainFile(mainFile, true)}>
                    <Upload className="w-4 h-4" /> Resume upload
                  </button>
                )}
                {mainSession && !mainReady && (
                  <button type="button" className="block text-xs text-red-300 hover:text-red-200 transition" onClick={() => { void cancelSession(mainSession); setMainSession(null); setMainFile(null); setMainProgress(null); }}>
                    Cancel this upload
                  </button>
                )}
              </div>
            </section>

            {/* ---- Step 2: the details ---- */}
            <section className="glass-card overflow-hidden">
              <SectionHeader
                icon={<Type className="w-5 h-5" />}
                step={2}
                title="Video details"
                subtitle="How the scene is listed, searched and priced."
              />
              <div className="p-5 space-y-4">
                <label className="block">
                  <span className="flex items-center justify-between text-sm text-white/60 mb-1.5">
                    <span>Title</span>
                    <span className="text-xs text-white/35">{title.length}/200</span>
                  </span>
                  <input className="input-field" placeholder="Give the scene a name that sells it" value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} maxLength={200} />
                </label>
                <label className="block">
                  <span className="flex items-center justify-between text-sm text-white/60 mb-1.5">
                    <span>Description</span>
                    <span className="text-xs text-white/35">{description.length}/5000</span>
                  </span>
                  <textarea className="input-field min-h-28 resize-y" placeholder="What happens in the scene, who is in it, and why a viewer should buy it." value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} />
                </label>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <label className="block sm:col-span-2">
                    <span className="flex items-center gap-2 text-sm text-white/60 mb-1.5"><Coins className="w-4 h-4 text-brand-400" /> Price (TZS)</span>
                    <input className="input-field" type="number" min={500} max={1000000} value={price} onChange={(e) => setPrice(Number(e.target.value))} />
                    <span className="mt-2 flex flex-wrap gap-2">
                      {[1000, 2000, 5000, 10000].map((preset) => (
                        <button key={preset} type="button" onClick={() => setPrice(preset)}
                          className={cn("rounded-full border px-3 py-1 text-xs transition",
                            price === preset ? "border-brand-400/60 bg-brand-500/20 text-brand-200" : "border-white/10 text-white/50 hover:text-white")}>
                          {preset.toLocaleString()}
                        </button>
                      ))}
                    </span>
                  </label>
                  <label className="block">
                    <span className="flex items-center gap-2 text-sm text-white/60 mb-1.5"><Eye className="w-4 h-4 text-brand-400" /> Preview seconds</span>
                    <input className="input-field" type="number" min={15} max={30} value={teaserDuration} onChange={(e) => setTeaserDuration(Number(e.target.value))} />
                  </label>
                  <label className="block">
                    <span className="flex items-center gap-2 text-sm text-white/60 mb-1.5"><Sparkles className="w-4 h-4 text-brand-400" /> Category</span>
                    <select className="input-field" value={category} onChange={(e) => setCategory(e.target.value)}>
                      <option value="">Choose</option>
                      {CATEGORIES.filter((item) => item.id !== "all").map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                    </select>
                  </label>
                </div>

                <label className="block">
                  <span className="flex items-center gap-2 text-sm text-white/60 mb-1.5"><Info className="w-4 h-4 text-brand-400" /> Tags</span>
                  <input className="input-field" placeholder="tall, outdoor, couple — separated by commas" value={tags} onChange={(e) => setTags(e.target.value)} />
                  <span className="block text-xs text-white/35 mt-1.5">Tags power search and related videos. Comma-separated.</span>
                </label>
              </div>
            </section>

            {/* ---- Step 3: cover and teaser ---- */}
            <section className="glass-card overflow-hidden">
              <SectionHeader
                icon={<ImageIcon className="w-5 h-5" />}
                step={3}
                title="Cover & teaser"
                subtitle="Optional, and the difference between a scroll-past and a click."
              />
              <div className="p-5 space-y-5">
                <div className="space-y-3">
                  {/* The same three doors the video has, in the same order, for
                      the same reason: this is where a creator's cover photo
                      actually lives, and until now the cover had no door that
                      named internal storage and none that opened the camera at
                      all — so a cover could not be taken on the spot, and the
                      folder the file was sitting in was not offered by name.

                      The first door is deliberately untyped and carries the
                      retry ref: a type filter is applied by the phone's own file
                      index, so the picker that shows Photos can hide a picture
                      sitting in Downloads, and a creator has no way to tell that
                      from the picture not being there. */}
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-white/60 cursor-pointer transition hover:border-brand-400/40 hover:text-white">
                      <FolderOpen className="w-4 h-4" /> From Internal storage / Downloads
                      <input ref={coverFilesRef} type="file" accept={ANY_FILE_ACCEPT} multiple className="hidden" disabled={thumbnailUploading} onChange={(e) => { void handleCoverFiles([...(e.target.files || [])]); e.currentTarget.value = ""; }} />
                    </label>
                    <label className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-white/60 cursor-pointer transition hover:border-brand-400/40 hover:text-white">
                      <Images className="w-4 h-4" /> From Gallery / Photos
                      <input type="file" accept={IMAGE_ACCEPT} multiple className="hidden" disabled={thumbnailUploading} onChange={(e) => { void handleCoverFiles([...(e.target.files || [])]); e.currentTarget.value = ""; }} />
                    </label>
                    <label className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-white/60 cursor-pointer transition hover:border-brand-400/40 hover:text-white">
                      <Camera className="w-4 h-4" /> Take a photo
                      {/* `capture` hands the camera straight over, and a photo
                          taken here is local by construction — the one kind of
                          file a phone can always read back. */}
                      <input type="file" accept="image/*" capture="environment" className="hidden" disabled={thumbnailUploading} onChange={(e) => { const file = e.target.files?.[0]; if (file) void handleCoverFiles([file]); e.currentTarget.value = ""; }} />
                    </label>
                  </div>
                  <p className="text-xs text-amber-200/70 inline-flex items-center gap-1.5">
                    <Info className="w-3.5 h-3.5" /> Chagua kutoka Internal storage au Downloads — usichague Google Photos au Drive.
                  </p>

                  {/* What was chosen, before one of them is used. Tap a picture to crop
                      and upload THAT one as the cover; the rest are candidates and are
                      never sent anywhere. */}
                  {coverCandidates.length > 0 && (
                    <div className="flex flex-wrap gap-3 pt-1">
                      {coverCandidates.map((candidate, index) => (
                        <div key={candidate.url} className="relative group">
                          <button type="button" onClick={() => setCropFile(candidate.file)} title="Use this picture as the cover">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={candidate.url} alt="" className="h-20 w-20 rounded-xl object-cover border border-white/10 transition group-hover:border-brand-400/50" />
                          </button>
                          <button type="button" aria-label="Remove this picture" onClick={() => removeCoverCandidate(index)} className="absolute -top-1.5 -right-1.5 rounded-full bg-black/85 p-0.5 border border-white/20 hover:border-red-400/60">
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {thumbnailUploading && <ProgressBar percent={100} label="Uploading cover" />}
                  {thumbnailUrl && (
                    <p className="text-xs text-emerald-400 inline-flex items-center gap-1">
                      <Check className="w-4 h-4" /> Cover ready
                    </p>
                  )}
                </div>

                <div className="border-t border-white/10 pt-5 space-y-3">
                  <h3 className="text-sm font-semibold flex items-center gap-2"><FileVideo className="w-4 h-4 text-brand-400" /> Teaser clip</h3>
                  <label className="block">
                    <input ref={teaserFilesRef} type="file" accept={ANY_FILE_ACCEPT} className="input-field file:mr-3 file:rounded-lg file:border-0 file:bg-brand-500/20 file:px-3 file:py-1.5 file:text-brand-200" disabled={teaserUploading || !mainReady} onChange={(e) => { const file = e.target.files?.[0]; if (file) void handleTeaserFile(file); e.currentTarget.value = ""; }} />
                  </label>
                  {!mainReady && <p className="text-xs text-white/35">Upload the main video first.</p>}
                  <label className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-white/60 cursor-pointer transition hover:border-brand-400/40 hover:text-white">
                    <Images className="w-4 h-4" /> From Gallery / Photos
                    <input type="file" accept={VIDEO_ACCEPT} className="hidden" disabled={teaserUploading || !mainReady} onChange={(e) => { const file = e.target.files?.[0]; if (file) void handleTeaserFile(file); e.currentTarget.value = ""; }} />
                  </label>
                  {teaserFile && <p className="text-xs text-white/60">{teaserFile.name} · {formatBytes(teaserFile.size)}</p>}
                  {(teaserUploading || teaserProgress) && !teaserVideoId && <ProgressBar percent={teaserPercent} label="Teaser" />}
                  {teaserSession && !teaserVideoId && !teaserUploading && (
                    <button type="button" className="btn-ghost text-sm border border-white/10" onClick={() => teaserFile && void handleTeaserFile(teaserFile, true)}>Resume teaser upload</button>
                  )}
                </div>
              </div>
            </section>
          </div>

          {/* ---- Right column: the publish rail, sticky on desktop ---- */}
          <aside className="lg:sticky lg:top-24 space-y-4">
            <div className="glass-card p-5 space-y-4">
              <h2 className="font-semibold flex items-center gap-2">
                <ListChecks className="w-4 h-4 text-brand-400" /> Publish checklist
              </h2>
              <ul className="space-y-2.5 text-sm">
                <ReadinessRow done={mainReady} label="Main video uploaded" />
                <ReadinessRow done={title.trim().length >= 3} label="Title (3+ characters)" />
                <ReadinessRow done={Boolean(category)} label="Category" optional />
                <ReadinessRow done={Boolean(thumbnailUrl)} label="Cover image" optional />
                <ReadinessRow done={Boolean(teaserVideoId)} label="Teaser clip" optional />
                <ReadinessRow done={complianceAttested} label="18+ records confirmed" />
              </ul>

              <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-3 text-sm">
                <span className="text-white/50">Price</span>
                <span className="font-semibold">TZS {price.toLocaleString()}</span>
              </div>

              <label className="flex items-start gap-3 rounded-xl border border-amber-400/20 bg-amber-400/5 p-3.5 text-xs cursor-pointer">
                <input type="checkbox" checked={complianceAttested} onChange={(e) => setComplianceAttested(e.target.checked)} className="mt-0.5" />
                <span>
                  <ShieldAlert className="inline w-4 h-4 text-amber-300 mr-1" />
                  I confirm all performers are 18+ and required age/consent records are kept.
                </span>
              </label>

              <button type="submit" disabled={submitting || !canPublish} className="btn-brand w-full inline-flex items-center justify-center gap-2 disabled:opacity-50">
                {submitting ? (<><Loader2 className="w-4 h-4 animate-spin" /> Publishing…</>) : (<><Rocket className="w-4 h-4" /> Publish video</>)}
              </button>
              <p className="text-[11px] text-white/35 text-center">You can edit the details after publishing.</p>
            </div>

            <div className="glass-card p-4 text-xs text-white/45 space-y-2">
              <p className="flex items-center gap-2 text-white/70 font-medium"><Sparkles className="w-3.5 h-3.5 text-brand-400" /> Creator tips</p>
              <p>• Urefu: dakika 8 au zaidi unashauriwa — lakini hakuna kikomo. Video ya urefu wowote inakubaliwa.</p>
              <p>• Cover inayovutia ndiyo tofauti kati ya kupita na kubofya.</p>
              <p>• Teaser fupi (sekunde 15–30) huongeza uwezekano wa mnunuzi.</p>
            </div>
          </aside>
        </form>
      </main>

      {cropFile && <ImageCropper file={cropFile} shape="wide" confirmLabel="Use cover" busy={thumbnailUploading} onCancel={() => setCropFile(null)} onConfirm={(file) => { setCropFile(null); void handleThumbnail(file); }} />}
    </div>
  );
}

function ProgressBar({ percent: value, label }: { percent: number; label: string }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-xs text-white/60">
        <span>{label}</span>
        <span className="tabular-nums">{clamped}%</span>
      </div>
      <div className="h-2 rounded-full bg-white/10 overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-brand-400 to-brand-600 transition-all duration-300"
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}

/**
 * The studio rail: four steps, greyed until reached, ticked once passed.
 *
 * It reads the form's own state rather than tracking clicks, so it can never
 * claim a step is done while the thing it describes is missing.
 */
function UploadStepper({ current }: { current: number }) {
  const steps = [
    { n: 1, label: "Media", icon: <Film className="w-3.5 h-3.5" /> },
    { n: 2, label: "Details", icon: <Type className="w-3.5 h-3.5" /> },
    { n: 3, label: "Cover & teaser", icon: <ImageIcon className="w-3.5 h-3.5" /> },
    { n: 4, label: "Publish", icon: <Rocket className="w-3.5 h-3.5" /> },
  ];

  return (
    <ol className="flex items-center gap-2 overflow-x-auto pb-1">
      {steps.map((step, index) => {
        const done = step.n < current;
        const active = step.n === current;
        return (
          <li key={step.n} className="flex items-center gap-2 shrink-0">
            <span
              className={cn(
                "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition",
                active
                  ? "border-brand-400/50 bg-brand-500/15 text-brand-200"
                  : done
                    ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-300"
                    : "border-white/10 bg-white/[0.02] text-white/40"
              )}
            >
              {done ? <Check className="w-3.5 h-3.5" /> : step.icon}
              {step.label}
            </span>
            {index < steps.length - 1 && <span className="h-px w-6 bg-white/10" />}
          </li>
        );
      })}
    </ol>
  );
}

/** A titled band at the top of a studio card, with its step number. */
function SectionHeader({
  icon,
  step,
  title,
  subtitle,
}: {
  icon: React.ReactNode;
  step: number;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-white/10 px-5 py-4">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-500/15 text-brand-300 ring-1 ring-brand-400/20">
        {icon}
      </span>
      <div className="min-w-0">
        <h2 className="font-semibold flex items-center gap-2">
          {title}
          <span className="text-[10px] font-normal uppercase tracking-wider text-white/35">Step {step}</span>
        </h2>
        {subtitle && <p className="text-xs text-white/45 mt-0.5">{subtitle}</p>}
      </div>
    </div>
  );
}

/** One line of the publish checklist. */
function ReadinessRow({
  done,
  label,
  optional,
}: {
  done: boolean;
  label: string;
  optional?: boolean;
}) {
  return (
    <li className="flex items-center gap-2.5">
      <span
        className={cn(
          "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border",
          done
            ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-400"
            : "border-white/15 text-white/30"
        )}
      >
        {done ? <Check className="w-3 h-3" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      </span>
      <span className={done ? "text-white/85" : "text-white/50"}>{label}</span>
      {optional && !done && (
        <span className="ml-auto text-[10px] uppercase tracking-wide text-white/25">Optional</span>
      )}
    </li>
  );
}
