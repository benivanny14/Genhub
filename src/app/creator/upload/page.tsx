"use client";

import { useState, useEffect, useCallback } from "react";
import { fetchCurrentUser } from "@/lib/current-user";
import Header from "@/components/Header";
import Image from "next/image";
import ImageCropper from "@/components/ImageCropper";
import { canOptimizeImage } from "@/lib/media";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import { uploadFileWithTus, TusUploadError } from "@/lib/tus-upload";
import { CATEGORIES } from "@/lib/categories";
import type { BunnyUploadCredentials } from "@/lib/bunny";
import {
  CREATOR_GUIDELINES,
  CREATOR_GUIDELINES_VERSION,
  GUIDELINE_ACK_LABEL_EN,
  GUIDELINE_ACK_LABEL_SW,
  GUIDELINE_ACK_STORAGE_KEY,
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
  ShieldAlert,
  ScrollText,
} from "lucide-react";

interface User {
  id: string;
  role: string;
  kycStatus: string;
  displayName: string | null;
}

export default function UploadPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [success, setSuccess] = useState(false);
  const [awaitingProcessing, setAwaitingProcessing] = useState(false);

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

  // The creator guidelines gate. `null` = not read yet for this account; a
  // number = the version this account accepted. Anything below the current
  // version sends them back through the rules, so an edited rule is re-read.
  const [ackVersion, setAckVersion] = useState<number | null>(null);
  const [guidelineChecks, setGuidelineChecks] = useState<Record<string, boolean>>({});
  const allGuidelinesChecked = CREATOR_GUIDELINES.every((g) => guidelineChecks[g.id]);

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
      setUser(data.data);
    } catch {
      router.push("/login");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    checkAccess();
  }, [checkAccess]);

  /** Read what this account already accepted, keyed by user id. */
  useEffect(() => {
    if (!user) return;
    try {
      const raw = localStorage.getItem(GUIDELINE_ACK_STORAGE_KEY);
      const map = raw ? (JSON.parse(raw) as Record<string, number>) : {};
      setAckVersion(typeof map[user.id] === "number" ? map[user.id] : null);
    } catch {
      setAckVersion(null);
    }
  }, [user]);

  /** Persist the acknowledgement so the gate is a one-time read, per version. */
  function acceptGuidelines() {
    if (!user || !allGuidelinesChecked) return;
    try {
      const raw = localStorage.getItem(GUIDELINE_ACK_STORAGE_KEY);
      const map = raw ? (JSON.parse(raw) as Record<string, number>) : {};
      map[user.id] = CREATOR_GUIDELINES_VERSION;
      localStorage.setItem(GUIDELINE_ACK_STORAGE_KEY, JSON.stringify(map));
    } catch {
      // A browser that refuses storage should not block the upload; the gate
      // still ran this session.
    }
    setAckVersion(CREATOR_GUIDELINES_VERSION);
  }

  /** Reserve the slot and get the short-lived credentials to fill it. */
  async function initiateUpload(): Promise<BunnyUploadCredentials | null> {
    try {
      const res = await fetch("/api/videos/upload-signature", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const data = await res.json();
      if (data.success) {
        setBunnyVideoId(data.data.videoId);
        return data.data as BunnyUploadCredentials;
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
   */
  async function uploadToBunny(
    file: File,
    credentials: BunnyUploadCredentials,
    onProgress: (percent: number) => void
  ): Promise<boolean> {
    try {
      await uploadFileWithTus(file, credentials, {
        onProgress: (uploaded, total) =>
          onProgress(Math.round((uploaded / total) * 100)),
      });
      return true;
    } catch (error) {
      toast(
        "error",
        error instanceof TusUploadError
          ? error.message
          : "Upload failed. Please try again."
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!bunnyVideoId || !title) return;

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
          complianceAttested,
        }),
      });

      const data = await res.json();
      if (data.success) {
        // Bunny has not finished transcoding yet, so this is not "it is live" —
        // it is "we have it, and it will publish itself when it can play".
        // Carrying the flag through avoids telling the creator something untrue.
        setAwaitingProcessing(data.data?.encodingStatus !== null);
        setSuccess(true);
      } else {
        toast("error", data.error || "An error occurred");
      }
    } catch {
      toast("error", "Network error");
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

  // ---- Creator guidelines gate --------------------------------------------
  // Shown before the form and only once per guidelines version. Every rule is
  // individually ticked, because a single "I agree" at the bottom of a wall of
  // text is how people accept rules they never read — and rule #2 here costs a
  // creator their account.
  if (ackVersion !== CREATOR_GUIDELINES_VERSION) {
    return (
      <div className="min-h-screen">
        <Header />
        <main className="max-w-2xl mx-auto px-4 py-8 space-y-6">
          <div className="flex items-center gap-3">
            <Link href="/creator" className="p-2 rounded-xl hover:bg-white/10 transition">
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <div>
              <h1 className="text-2xl font-display font-bold flex items-center gap-2">
                <ScrollText className="w-6 h-6 text-brand-400" />
                Masharti ya Creators
              </h1>
              <p className="text-white/50 text-sm">
                Soma masharti yote kabla ya ku-upload video yako
              </p>
            </div>
          </div>

          <div className="glass-card p-6 space-y-3">
            {CREATOR_GUIDELINES.map((g, i) => (
              <label
                key={g.id}
                className={`flex items-start gap-3 rounded-xl border p-4 cursor-pointer transition ${
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
                  className="mt-1 w-4 h-4 accent-emerald-500 shrink-0"
                />
                <div className="space-y-1">
                  <p className="text-sm font-medium flex items-center gap-2">
                    <span className="text-white/40">
                      {i + 1}.
                    </span>
                    {g.severe && <ShieldAlert className="w-4 h-4 text-red-400 shrink-0" />}
                    <span>{g.sw}</span>
                  </p>
                  <p className="text-xs text-white/50">{g.en}</p>
                </div>
              </label>
            ))}
          </div>

          <div className="glass-card p-4 space-y-3">
            <p className="text-xs text-white/50">
              {GUIDELINE_ACK_LABEL_SW}
              <br />
              {GUIDELINE_ACK_LABEL_EN}
            </p>
            <button
              onClick={acceptGuidelines}
              disabled={!allGuidelinesChecked}
              className="btn-brand w-full disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              <CheckCircle className="w-4 h-4" />
              Endelea ku-upload
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
        <div className="flex items-center justify-center h-[60vh]">
          <div className="text-center">
            <CheckCircle className="w-16 h-16 text-emerald-400 mx-auto mb-4" />
            <h2 className="text-2xl font-display font-bold mb-2">
              {awaitingProcessing ? "Upload complete — now processing" : "Video Uploaded!"}
            </h2>
            {awaitingProcessing ? (
              <>
                <p className="text-white/60 mb-2 max-w-md">
                  Bunny Stream is transcoding your video into the playback
                  qualities viewers need. It publishes itself the moment it is
                  ready, and you will get a notification when it goes live.
                </p>
                <p className="text-white/40 text-sm mb-6">
                  You do not need to keep this page open — processing happens on
                  our servers. You can also publish it early from your dashboard
                  if you would rather not wait.
                </p>
              </>
            ) : (
              <p className="text-white/60 mb-6">
                Your video has been created and is live.
              </p>
            )}
            <div className="flex gap-3 justify-center">
              <Link href="/creator" className="btn-ghost">
                Back to Dashboard
              </Link>
              <button onClick={() => { setSuccess(false); setTitle(""); setBunnyVideoId(""); }} className="btn-brand">
                Upload Another Video
              </button>
            </div>
          </div>
        </div>
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
          {!bunnyVideoId ? (
            <div>
              <label className="text-sm text-white/60 mb-2 block">Select Video</label>
              <label className="border-2 border-dashed border-white/20 rounded-2xl p-8 text-center cursor-pointer hover:border-brand-500/50 transition">
                <Upload className="w-10 h-10 text-white/30 mx-auto mb-3" />
                <p className="text-sm text-white/60 mb-1">
                  Click here to upload your video
                </p>
                <p className="text-xs text-white/40">MP4, MOV, AVI — Max 2GB</p>
                <input
                  type="file"
                  accept="video/*"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const credentials = await initiateUpload();
                    if (!credentials) return;
                    const uploaded = await uploadToBunny(
                      file,
                      credentials,
                      setUploadProgress
                    );
                    if (!uploaded) {
                      // The slot is empty, so let the creator pick a file again
                      // instead of leaving them stuck on a reserved video id.
                      setBunnyVideoId("");
                      setUploadProgress(0);
                    }
                  }}
                />
              </label>
              {uploadProgress > 0 && uploadProgress < 100 && (
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
                onChange={(e) => setPrice(parseInt(e.target.value) || 100)}
                min={100}
                max={1000000}
                className="input-field"
              />
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
              JPEG, PNG or WebP, up to 5 MB. You can move and zoom the picture
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
                    if (!file) return;
                    setUploadingTeaser(true);
                    setTeaserProgress(0);
                    try {
                      // Same flow as the main video: reserve a slot, then TUS.
                      const res = await fetch("/api/videos/upload-signature", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ title: `${title || "teaser"} (teaser)` }),
                      });
                      const data = await res.json();
                      if (!data.success) {
                        toast("error", data.error || "Could not start the teaser upload");
                        return;
                      }

                      const credentials = data.data as BunnyUploadCredentials;
                      await uploadFileWithTus(file, credentials, {
                        onProgress: (uploaded, total) =>
                          setTeaserProgress(Math.round((uploaded / total) * 100)),
                      });

                      setTeaserBunnyVideoId(credentials.videoId);
                      toast("success", "Teaser clip uploaded");
                    } catch (error) {
                      toast(
                        "error",
                        error instanceof TusUploadError
                          ? error.message
                          : "Network error while uploading the teaser"
                      );
                    } finally {
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
            disabled={uploading || !bunnyVideoId || !title || !complianceAttested}
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
