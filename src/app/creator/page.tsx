"use client";

import { useState, useEffect, useCallback } from "react";
import { fetchCurrentUser } from "@/lib/current-user";
import Header from "@/components/Header";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";
import Image from "next/image";
import ImageCropper from "@/components/ImageCropper";
import {
  Wallet,
  Eye,
  DollarSign,
  TrendingUp,
  Clock,
  Upload,
  AlertCircle,
  CheckCircle,
  ArrowUpRight,
  Film,
  BarChart3,
  Banknote,
  XCircle,
  Loader2,
  MoreVertical,
  Pencil,
  Trash2,
  EyeOff,
  ImageOff,
  Tag,
  Captions,
  MessageSquare,
  Clapperboard,
  BadgeCheck,
  Copy,
  Check,
  Share2,
} from "lucide-react";
import { canOptimizeImage } from "@/lib/media";
import { uploadFileWithTus, TusUploadError } from "@/lib/tus-upload";
import type { BunnyUploadCredentials } from "@/lib/bunny";
import {
  PAYOUT_METHODS,
  PAYOUT_METHOD_LABEL,
  describePayoutAccount,
  isBankPayout,
  lastPayoutAccount,
} from "@/lib/payout-account";
import { formatTZS, formatRelativeTime, formatCount, cn } from "@/lib/utils";
// The one list of categories — the same ids /browse/[category] serves, minus the
// "all" pseudo-category, which is a filter and not something a video can be.
import { CATEGORIES } from "@/lib/categories";

interface CreatorData {
  balance: {
    pendingBalance: number;
    availableBalance: number;
    totalEarned: number;
  };
  todayEarnings: number;
  totalViews: number;
  videoStats: {
    id: string;
    title: string;
    viewsCount: number;
    purchaseCount: number;
    price: number;
    totalEarned: number;
    createdAt: string;
  }[];
  recentTransactions: {
    id: string;
    amount: number;
    creatorCut: number | null;
    type: string;
    createdAt: string;
    /** `{ method: "pay_message" }` for a message; a plain tip has none. */
    metadata?: { method?: string } | null;
    video?: { title: string } | null;
  }[];
  /**
   * The creator's own withdrawal requests. Optional because the endpoint may
   * answer from a payload written before this field existed.
   */
  payouts?: {
    id: string;
    amount: number;
    paymentMethod: string;
    accountDetails: string;
    /** Half of where a bank transfer has to go; null for mobile money. */
    bankName?: string | null;
    status: string;
    /** The receipt the admin entered when this was marked paid. */
    paymentReference: string | null;
    adminNote: string | null;
    createdAt: string;
    processedAt: string | null;
  }[];
  /** Chat income: every message is paid, and it clears on the 14-day clock. */
  paidMessages: {
    messages: number;
    /** What fans paid, before the 30% platform share. */
    gross: number;
    earned: number;
    heldMessages: number;
    held: number;
    cleared: number;
    nextReleaseAt: string | null;
    recent: {
      id: string;
      amount: number;
      earned: number;
      createdAt: string;
      clearsAt: string;
      held: boolean;
      sender: { id: string; displayName: string | null; avatarUrl: string | null };
    }[];
  };
}

/** A day, year included, because a release date is a date and not a timestamp. */
function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * What to call a row in the money list.
 *
 * A TIP is two different things — a tip from /api/tips and a paid message from
 * /api/messages — and the transaction type alone cannot tell them apart. The
 * route that wrote the row says which in `metadata.method`, so "TIP" stops being
 * the label a creator scans past.
 */
// Method labels and the "where did the money last go" rule live in
// lib/payout-account.ts, so this screen, the history list and the admin queue
// cannot call the same method three different things.

/**
 * Where one withdrawal stands. The wording is deliberate: APPROVED is a promise
 * and says so, because "Approved" next to a missing payment reads as "we already
 * sent it" to the person waiting.
 */
function PayoutStatus({ status }: { status: string }) {
  const styles: Record<string, string> = {
    PENDING: "bg-amber-500/15 text-amber-400",
    APPROVED: "bg-blue-500/15 text-blue-400",
    PAID: "bg-emerald-500/15 text-emerald-400",
    REJECTED: "bg-red-500/15 text-red-400",
  };
  const labels: Record<string, string> = {
    PENDING: "Pending",
    APPROVED: "Approved — being sent",
    PAID: "Paid",
    REJECTED: "Rejected",
  };
  return (
    <span
      className={`text-[10px] px-2 py-0.5 rounded font-medium whitespace-nowrap ${
        styles[status] || "bg-white/10 text-white/60"
      }`}
    >
      {labels[status] || status}
    </span>
  );
}

function transactionLabel(tx: CreatorData["recentTransactions"][number]): string {
  if (tx.type === "PPV_PURCHASE") return `Sold: ${tx.video?.title || "Video"}`;
  if (tx.type === "SUBSCRIPTION") return "Subscription";
  if (tx.type === "TIP") {
    return tx.metadata?.method === "pay_message" ? "Paid message" : "Tip";
  }
  return tx.type;
}

interface UserData {
  id: string;
  kycStatus: string;
  role: string;
}

/** One past or pending blue-tick charge. */
interface BlueTickHistoryRow {
  id: string;
  status: string;
  amount: number;
  months: number;
  paymentMethod: string;
  paidAt: string;
  expiresAt: string | null;
  rejectionReason: string | null;
}

/**
 * The blue-tick card's data, straight from the service that charges for it —
 * price, expiry and both balance sources included, so the screen cannot offer a
 * price or a payment source the server will refuse.
 */
interface BlueTickView {
  live: boolean;
  expiresAt: string | null;
  price: number;
  monthDays: number;
  maxMonths: number;
  walletBalance: number;
  availableBalance: number;
  canAfford: boolean;
  pending: BlueTickHistoryRow | null;
  history: BlueTickHistoryRow[];
}

/** Bunny's processing state for one of the creator's videos. */
interface EncodingState {
  state: "pending" | "processing" | "ready" | "failed" | "untracked";
  status: number | null;
  progress: number;
  label: string;
  error: string | null;
}

interface CreatorVideo {
  id: string;
  title: string;
  description: string | null;
  slug: string | null;
  price: number;
  isPublished: boolean;
  viewsCount: number;
  purchaseCount: number;
  thumbnailUrl: string | null;
  duration: number | null;
  teaserDuration: number;
  category: string | null;
  tags: string[];
  captionsUrl: string | null;
  /** Whether a separate trailer clip (the intro) is attached. */
  hasTeaser: boolean;
  createdAt: string;
  encoding: EncodingState;
}

/**
 * Live processing badge. "Not tracked" renders as a dash rather than a badge: a
 * side-loaded video has no encoding lifecycle, and showing it a fake "Ready"
 * would devalue the real ones.
 */
function EncodingBadge({ encoding }: { encoding?: EncodingState }) {
  if (!encoding || encoding.state === "untracked") {
    return <span className="text-xs text-white/25">—</span>;
  }

  if (encoding.state === "failed") {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs font-medium text-red-400"
        title={encoding.error || "Bunny Stream could not process this file"}
      >
        <XCircle className="w-3.5 h-3.5" /> Failed
      </span>
    );
  }

  if (encoding.state === "ready") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-400">
        <CheckCircle className="w-3.5 h-3.5" /> Ready
      </span>
    );
  }

  return (
    <div className="min-w-[110px]">
      <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-400">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        {encoding.label} {encoding.progress}%
      </span>
      <div className="mt-1 bg-white/10 rounded-full h-1 overflow-hidden">
        <div
          className="bg-amber-400 h-full transition-all duration-500"
          style={{ width: `${Math.max(4, encoding.progress)}%` }}
        />
      </div>
    </div>
  );
}

export default function CreatorDashboard() {
  const router = useRouter();
  const { toast } = useToast();
  const confirmDialog = useConfirm();
  const [creatorData, setCreatorData] = useState<CreatorData | null>(null);
  const [user, setUser] = useState<UserData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showPayoutModal, setShowPayoutModal] = useState(false);
  const [payoutAmount, setPayoutAmount] = useState(0);
  const [payoutMethod, setPayoutMethod] = useState<string>("MPESA");
  const [payoutAccount, setPayoutAccount] = useState("");
  const [payoutBankName, setPayoutBankName] = useState("");
  const [requestingPayout, setRequestingPayout] = useState(false);
  const [videos, setVideos] = useState<CreatorVideo[]>([]);
  const [processingCount, setProcessingCount] = useState(0);
  const [awaitingPublish, setAwaitingPublish] = useState(0);
  const [publishingId, setPublishingId] = useState<string | null>(null);
  // "My videos" management: the creator's own list, with the actions they asked
  // for. The performance table below is money-driven and cannot show an
  // unpublished video at all (it has no sales), which is why "I cannot see the
  // video I just posted" had no answer on this page.
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [editing, setEditing] = useState<CreatorVideo | null>(null);
  const [editTitle, setEditTitle] = useState("");
  // A STRING, not a number. The price box used to be a number that an empty
  // field silently became 0 — and 0 means "free to everyone". See saveEdit.
  const [editPrice, setEditPrice] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [editTags, setEditTags] = useState("");
  const [editTeaserDuration, setEditTeaserDuration] = useState(15);
  // Whether a trailer clip is already attached, and the id of one uploaded in
  // this edit session (sent on save). Kept apart because the schema can set a
  // teaser but not clear one, so an untouched field must send nothing.
  const [editTeaserAttached, setEditTeaserAttached] = useState(false);
  const [newTeaserBunnyVideoId, setNewTeaserBunnyVideoId] = useState("");
  const [editTeaserProgress, setEditTeaserProgress] = useState(0);
  const [uploadingEditTeaser, setUploadingEditTeaser] = useState(false);
  const [editCoverUrl, setEditCoverUrl] = useState<string | null>(null);
  const [editCaptionsUrl, setEditCaptionsUrl] = useState("");
  const [uploadingCaptions, setUploadingCaptions] = useState(false);
  const [uploadingCover, setUploadingCover] = useState(false);
  // The cover waiting to be framed — a 16:9 crop of the picture just picked.
  const [coverCropFile, setCoverCropFile] = useState<File | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // The blue tick: bought by the month, approved by an admin, expiring on its
  // own. Kept as its own read because the price, the balances that may pay for
  // it and the expiry all come from one service (blue-tick.service.ts).
  const [blueTick, setBlueTick] = useState<BlueTickView | null>(null);
  const [showBlueTickModal, setShowBlueTickModal] = useState(false);
  const [blueTickMonths, setBlueTickMonths] = useState(1);
  const [buyingBlueTick, setBuyingBlueTick] = useState(false);

  // The public link to this profile. Resolved after mount so the shared link
  // carries the origin the creator is actually on; a build-time constant would
  // be wrong on every deployment that is not that one.
  const [profileUrl, setProfileUrl] = useState("");
  const [linkCopied, setLinkCopied] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [balanceRes, userRes, videosRes] = await Promise.all([
        fetch("/api/creator/balance"),
        fetchCurrentUser(),
        fetch("/api/creator/videos"),
      ]);

      const balanceData = await balanceRes.json();
      const userData = await userRes.json();
      const videosData = await videosRes.json();

      if (balanceData.success) setCreatorData(balanceData.data);
      if (userData.success) setUser(userData.data);
      if (videosData.success) {
        setVideos(videosData.data.videos || []);
        setProcessingCount(videosData.data.processing || 0);
        setAwaitingPublish(videosData.data.awaitingPublish || 0);
      }

      if (!userData.success) router.push("/login");

      // The blue tick, read separately: the dashboard must still render when
      // this one call fails, and its failure is not a reason to bounce the
      // creator to the login page.
      try {
        const tickRes = await fetch("/api/creator/blue-tick");
        const tickData = await tickRes.json();
        if (tickData.success) setBlueTick(tickData.data);
      } catch {}
    } catch {
      router.push("/login");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Where this creator's shareable profile link points. The profile page is
  // public, so a recipient lands on it as a viewer with no account needed —
  // which is the whole point of the link. Resolved after mount so the shared
  // link carries the origin the creator is actually on; a build-time constant
  // would be wrong on every deployment that is not that one.
  useEffect(() => {
    if (!user) return;
    setProfileUrl(`${window.location.origin}/creator/${user.id}`);
  }, [user]);

  // While anything is still transcoding, re-read so the progress the creator is
  // watching actually moves. Stops on its own once everything is settled, so an
  // idle dashboard makes no requests at all.
  //
  // And it stops while the tab is in the background. A creator leaves this page
  // open and goes to do something else — for minutes or for the night — and the
  // old timer kept asking every 8 seconds the whole time, four requests a minute
  // per open tab, on the phone's data. Coming back refreshes immediately, so the
  // number is current the instant it is looked at.
  useEffect(() => {
    if (processingCount === 0) return;

    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const start = () => {
      if (!timer) timer = setInterval(fetchData, 8000);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void fetchData();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [processingCount, fetchData]);

  /**
   * Publish by hand. The automatic path holds a video back until Bunny can
   * serve it; this is the way out when Bunny never says it finished.
   */
  async function togglePublished(video: CreatorVideo) {
    const next = !video.isPublished;

    if (next && video.encoding.state !== "ready") {
      const goAhead = await confirmDialog({
        title: "Publish before it is ready?",
        message:
          `This video is still ${video.encoding.label.toLowerCase()}. ` +
          "Publishing now may show viewers a video that will not play.",
        confirmLabel: "Publish anyway",
      });
      if (!goAhead) return;
    }

    setPublishingId(video.id);
    try {
      const res = await fetch(`/api/creator/videos/${video.id}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ published: next }),
      });
      const data = await res.json();
      if (!data.success) {
        toast("error", data.error || "Could not update the video");
        return;
      }
      if (data.data?.warning) toast("warning", data.data.warning);
      else toast("success", next ? "Video published" : "Video unpublished");
      await fetchData();
    } catch {
      toast("error", "Network error");
    } finally {
      setPublishingId(null);
    }
  }

  /** Open the edit form for one of the creator's own videos. */
  function openEditor(video: CreatorVideo) {
    setEditing(video);
    setEditTitle(video.title);
    setEditPrice(String(video.price));
    setEditDescription(video.description || "");
    setEditCategory(video.category || "");
    setEditTags((video.tags || []).join(", "));
    setEditTeaserDuration(video.teaserDuration || 15);
    setEditTeaserAttached(video.hasTeaser);
    setNewTeaserBunnyVideoId("");
    setEditTeaserProgress(0);
    setEditCoverUrl(video.thumbnailUrl);
    setEditCaptionsUrl(video.captionsUrl || "");
    setOpenMenuId(null);
  }

  /**
   * Replace the cover image without re-uploading the video.
   *
   * The file is framed first (see ImageCropper), then goes to the same
   * /api/upload endpoint a thumbnail uses on the upload page. The returned
   * in-app URL is what gets saved — nothing is written to the video row until
   * Save, so a cancelled edit changes nothing.
   */
  async function uploadCover(file: File) {
    setUploadingCover(true);
    try {
      const { uploadImage } = await import("@/lib/upload-client");
      const url = await uploadImage(file, { kind: "public" });
      setEditCoverUrl(url);
      toast("success", "New cover ready — press Save to keep it");
    } catch (error) {
      toast(
        "error",
        error instanceof Error ? error.message : "The image could not be uploaded"
      );
    } finally {
      setUploadingCover(false);
    }
  }

  /**
   * Attach or replace the trailer clip a non-buyer gets to watch.
   *
   * Same flow as the upload page: reserve a Bunny slot, then send the file over
   * TUS so a dropped connection resumes. The result is held in state and only
   * written to the video row on Save, so a cancelled edit changes nothing — and
   * this is the door that finally lets an existing scene grow an intro trailer.
   */
  async function uploadEditTeaser(file: File) {
    setUploadingEditTeaser(true);
    setEditTeaserProgress(0);
    try {
      const res = await fetch("/api/videos/upload-signature", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: `${editTitle || "trailer"} (teaser)` }),
      });
      const data = await res.json();
      if (!data.success) {
        toast("error", data.error || "Could not start the trailer upload");
        return;
      }

      const credentials = data.data as BunnyUploadCredentials;
      await uploadFileWithTus(file, credentials, {
        onProgress: (uploaded, total) =>
          setEditTeaserProgress(Math.round((uploaded / total) * 100)),
      });

      setNewTeaserBunnyVideoId(credentials.videoId);
      toast("success", "Trailer uploaded — press Save to attach it");
    } catch (error) {
      toast(
        "error",
        error instanceof TusUploadError
          ? error.message
          : "Network error while uploading the trailer"
      );
    } finally {
      setUploadingEditTeaser(false);
    }
  }

  /**
   * Attach a captions file to the video being edited.
   *
   * Uploaded immediately (it is a file, and there is nothing to crop), but like
   * the cover it is only written to the video row on Save — a cancelled edit
   * leaves the scene exactly as it was.
   */
  async function uploadCaptions(file: File) {
    setUploadingCaptions(true);
    try {
      const { uploadCaptions: upload } = await import("@/lib/upload-client");
      const url = await upload(file);
      setEditCaptionsUrl(url);
      toast("success", "Captions ready — press Save to attach them");
    } catch (error) {
      toast(
        "error",
        error instanceof Error ? error.message : "The captions file could not be uploaded"
      );
    } finally {
      setUploadingCaptions(false);
    }
  }

  async function saveEdit() {
    if (!editing) return;
    const title = editTitle.trim();
    if (title.length < 3) {
      toast("error", "The title must be at least 3 characters");
      return;
    }
    // The price is read from what the creator TYPED, never from a number an empty
    // field quietly turned into. `parseInt("") || 0` is how clearing this box
    // used to save the video as FREE: the paywall disappeared, anyone — signed in
    // or not — could watch the whole scene, and nothing on the way to the server
    // said so. An empty box is now refused instead of being guessed at.
    const editPriceNum = Number(editPrice.trim());
    if (editPrice.trim() === "" || !Number.isFinite(editPriceNum)) {
      toast("error", "Enter a price in TZS — use 0 only if you mean free to watch");
      return;
    }
    if (editPriceNum < 0 || editPriceNum > 1000000) {
      toast("error", "Enter a price between TZS 0 and TZS 1,000,000");
      return;
    }
    // Turning a paid video free is a one-way door for everybody who has not
    // bought it yet: from that moment on the whole scene is public. Asked once,
    // in the form where the decision is made, because the server cannot tell the
    // difference between this and a typo.
    if (editing.price > 0 && editPriceNum === 0) {
      const goAhead = await confirmDialog({
        title: "Make this video free?",
        message:
          `"${editing.title}" sells for ${formatTZS(editing.price)} right now. ` +
          "Setting the price to 0 takes the paywall off: anybody, including people " +
          "who are not signed in, will be able to watch the whole video. " +
          "You can put a price back at any time.",
        confirmLabel: "Make it free",
      });
      if (!goAhead) return;
    }

    if (editTeaserDuration < 15 || editTeaserDuration > 30) {
      toast("error", "The preview must be between 15 and 30 seconds");
      return;
    }
    // Checked here as well as in the schema so the creator gets an answer in the
    // form they are looking at, naming the file that will not work.
    const captionsUrl = editCaptionsUrl.trim();
    if (captionsUrl && !/\.vtt(\?.*)?$/i.test(captionsUrl)) {
      toast("error", "Captions must be a .vtt (WebVTT) file — .srt will not play");
      return;
    }

    const tags = editTags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 10);

    setSavingEdit(true);
    try {
      const res = await fetch(`/api/videos/${editing.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          price: editPriceNum,
          description: editDescription.trim(),
          category: editCategory,
          tags,
          teaserDuration: editTeaserDuration,
          // Only when a new clip was uploaded in this session. Sending the saved
          // value every time would be a no-op, and the schema has no way to clear
          // it, so "unchanged" must mean "not sent".
          ...(newTeaserBunnyVideoId ? { teaserBunnyVideoId: newTeaserBunnyVideoId } : {}),
          ...(editCoverUrl ? { thumbnailUrl: editCoverUrl } : {}),
          // Always sent, empty included: clearing the field is how a creator
          // removes captions, and an omitted field could not mean that.
          captionsUrl,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        toast("error", data.error || "Could not save the changes");
        return;
      }
      toast("success", "Video updated");
      setEditing(null);
      await fetchData();
    } catch {
      toast("error", "Network error");
    } finally {
      setSavingEdit(false);
    }
  }

  /**
   * Delete one of the creator's own videos.
   *
   * The confirmation names what actually happens — this is not an undoable hide:
   * the row is retired and the file is removed from Bunny, so a customer's
   * purchase link will never resolve again. Saying so once is the difference
   * between a deliberate delete and an accident.
   */
  async function removeVideo(video: CreatorVideo) {
    const goAhead = await confirmDialog({
      title: `Delete "${video.title}" permanently?`,
      message:
        "It disappears from your dashboard and from the feed, and the video file " +
        "is removed from the video host. This cannot be undone.",
      confirmLabel: "Delete permanently",
    });
    if (!goAhead) return;
    setDeletingId(video.id);
    setOpenMenuId(null);
    try {
      const res = await fetch(`/api/videos/${video.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!data.success) {
        toast("error", data.error || "Could not delete the video");
        return;
      }
      toast("success", "Video deleted");
      await fetchData();
    } catch {
      toast("error", "Network error");
    } finally {
      setDeletingId(null);
    }
  }

  /**
   * Open the withdrawal form, already filled in with where the last payout went.
   *
   * The account is registered once — it is the one thing every other platform
   * does and a form that asks for it again every time does not — but it is read
   * back from the payout history rather than stored twice, so "the account we
   * paid to" cannot drift away from "the account we have on file".
   */
  function openPayoutModal() {
    const last = lastPayoutAccount(creatorData?.payouts);
    if (last) {
      setPayoutMethod(last.paymentMethod);
      setPayoutAccount(last.accountDetails);
      setPayoutBankName(last.bankName || "");
    }
    setPayoutAmount(Math.max(0, balance?.availableBalance || 0));
    setShowPayoutModal(true);
  }

  async function handlePayout() {
    if (!payoutAmount || !payoutAccount) return;
    if (isBankPayout(payoutMethod) && !payoutBankName.trim()) {
      toast("error", "Which bank should it be sent to?");
      return;
    }
    setRequestingPayout(true);

    try {
      const res = await fetch("/api/creator/payouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: payoutAmount,
          paymentMethod: payoutMethod,
          accountDetails: payoutAccount,
          // Half of a bank transfer's destination. The API has always accepted
          // it; the form never sent it, so the admin paying it out had a number
          // and no bank.
          ...(isBankPayout(payoutMethod) ? { bankName: payoutBankName.trim() } : {}),
        }),
      });

      const data = await res.json();
      if (data.success) {
        setShowPayoutModal(false);
        toast("success", "Payout request submitted!");
        fetchData();
      } else {
        toast("error", data.error || "An error occurred");
      }
    } catch {
      toast("error", "Network error");
    } finally {
      setRequestingPayout(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen">
        <Header />
        <div className="max-w-7xl mx-auto px-4 py-8">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="skeleton h-32 rounded-2xl" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const balance = creatorData?.balance;
  // Null when the endpoint could not read the ledger, which is a different
  // statement from "nobody has messaged you": a failed read renders zeros that
  // look like the truth, so it renders an apology instead.
  const paidMessages = creatorData?.paidMessages ?? null;
  const canRequestPayout =
    (balance?.availableBalance || 0) >= 30000 && user?.kycStatus === "APPROVED";

  // Where the money goes: read from the payout history, so the form asks once.
  const savedPayoutAccount = lastPayoutAccount(creatorData?.payouts);
  const pendingPayout = (creatorData?.payouts || []).find(
    (p) => p.status === "PENDING" || p.status === "APPROVED"
  );
  //
  // Why a withdrawal cannot be requested yet, in the creator's own words.
  //
  // The minimum stays where it always was — TZS 30,000 available, with an
  // approved identity check — and the Withdraw button stays locked until both
  // hold. What is new is that the REASONS are written out: a greyed-out control
  // with a parenthesis in it ("(Min: TZS 30,000 + KYC required)") was the only
  // mention of payouts on the page, and to somebody holding a balance of zero
  // that reads as "this platform cannot pay me". Saying which condition is
  // missing, with a link to the page that fixes it, costs nothing and answers
  // the question the disabled button raises.
  const withdrawalBlockers: { text: string; href?: string; linkLabel?: string }[] = [];
  if (user?.kycStatus !== "APPROVED") {
    withdrawalBlockers.push({
      text: "Your identity check (KYC) must be approved before money can leave — it is what protects your payout account from being changed by somebody else.",
      href: "/creator/kyc",
      linkLabel: "Finish verification",
    });
  }
  if ((balance?.availableBalance || 0) < 30000) {
    withdrawalBlockers.push({
      text:
        `Minimum per withdrawal is TZS 30,000 and your available balance is ${formatTZS(balance?.availableBalance || 0)}.` +
        ((balance?.pendingBalance || 0) > 0
          ? ` ${formatTZS(balance?.pendingBalance || 0)} is still clearing — sales become available after 14 days (the window a buyer can dispute one in).`
          : " Earnings appear here as your videos sell."),
    });
  }
  if (pendingPayout) {
    withdrawalBlockers.push({
      text: `A withdrawal of ${formatTZS(pendingPayout.amount)} is ${
        pendingPayout.status === "PENDING" ? "waiting to be reviewed" : "approved and being sent"
      }. One request at a time — it is listed under Withdrawals below.`,
    });
  }

  async function refreshBlueTick() {
    try {
      const res = await fetch("/api/creator/blue-tick");
      const data = await res.json();
      if (data.success) setBlueTick(data.data);
    } catch {}
  }

  async function buyBlueTick() {
    setBuyingBlueTick(true);
    try {
      const res = await fetch("/api/creator/blue-tick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ months: blueTickMonths }),
      });
      const data = await res.json();
      if (!data.success) {
        toast("error", data.error || "Could not buy the blue tick");
        return;
      }
      setShowBlueTickModal(false);
      setBlueTickMonths(1);
      toast("success", "Payment received — an admin will approve your blue tick shortly.");
      await refreshBlueTick();
    } catch {
      toast("error", "An error occurred. Please try again.");
    } finally {
      setBuyingBlueTick(false);
    }
  }

  async function copyProfileLink() {
    try {
      await navigator.clipboard.writeText(profileUrl);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
      toast("success", "Link copied — send it to anyone.");
    } catch {
      toast("warning", "Could not copy it — select the link and copy it by hand.");
    }
  }

  async function shareProfileLink() {
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ title: "My Genhub profile", url: profileUrl });
        return;
      } catch {
        // Dismissed, or sharing is not actually available — neither is an error.
        // Fall through to the copy, which always works.
      }
    }
    await copyProfileLink();
  }

  // The performance table is driven by the balance endpoint (money) and the
  // encoding column by /api/creator/videos (processing) — joined here so neither
  // endpoint has to know about the other's job.
  const encodingById = new Map(videos.map((v) => [v.id, v]));

  return (
    <div className="min-h-screen page-enter">
      <Header />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-8">
        {/* Page Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-display font-bold">Creator Dashboard</h1>
            <p className="text-white/50 text-sm">Track your earnings and video performance</p>
          </div>
          <div className="flex gap-3">
            <Link href="/creator/analytics" className="btn-ghost flex items-center gap-2">
              <BarChart3 className="w-4 h-4" /> Analytics
            </Link>
            {user?.kycStatus !== "APPROVED" && (
              <Link href="/creator/kyc" className="btn-ghost flex items-center gap-2 text-amber-400">
                <AlertCircle className="w-4 h-4" /> Complete KYC
              </Link>
            )}
            <Link href="/creator/upload" className="btn-brand flex items-center gap-2">
              <Upload className="w-4 h-4" /> Upload Video
            </Link>
          </div>
        </div>

        {/* KYC Warning */}
        {user?.kycStatus !== "APPROVED" && (
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-2xl p-4 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-amber-400 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-amber-400 text-sm">
                KYC not yet verified
              </p>
              <p className="text-xs text-amber-400/60 mt-1">
                You must complete KYC verification before uploading videos or requesting payouts.
                <Link href="/creator/kyc" className="underline ml-1">
                  Submit now
                </Link>
              </p>
            </div>
          </div>
        )}

        {/* Balance Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="glass-card p-5">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-xl bg-brand-500/20 flex items-center justify-center">
                <DollarSign className="w-5 h-5 text-brand-400" />
              </div>
              <span className="text-sm text-white/60">Total Earnings</span>
            </div>
            <p className="text-2xl font-bold">{formatTZS(balance?.totalEarned || 0)}</p>
          </div>

          <div className="glass-card p-5">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/20 flex items-center justify-center">
                <Wallet className="w-5 h-5 text-emerald-400" />
              </div>
              <span className="text-sm text-white/60">Available Balance</span>
            </div>
            <p className="text-2xl font-bold text-emerald-400">
              {formatTZS(balance?.availableBalance || 0)}
            </p>
          </div>

          <div className="glass-card p-5">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-xl bg-amber-500/20 flex items-center justify-center">
                <Clock className="w-5 h-5 text-amber-400" />
              </div>
              <span className="text-sm text-white/60">Pending (14 days)</span>
            </div>
            <p className="text-2xl font-bold text-amber-400">
              {formatTZS(balance?.pendingBalance || 0)}
            </p>
          </div>

          <div className="glass-card p-5">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-xl bg-brand-500/20 flex items-center justify-center">
                <TrendingUp className="w-5 h-5 text-brand-400" />
              </div>
              <span className="text-sm text-white/60">Today&apos;s Earnings</span>
            </div>
            <p className="text-2xl font-bold text-brand-400">
              {formatTZS(creatorData?.todayEarnings || 0)}
            </p>
          </div>
        </div>

        {/* Verification and sharing — the two things a creator goes looking for
            and, until now, had nowhere on this page to find. */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Blue tick */}
          <div className="glass-card p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <div
                  className={cn(
                    "w-10 h-10 rounded-xl flex items-center justify-center",
                    blueTick?.live ? "bg-sky-500/20" : "bg-white/5"
                  )}
                >
                  <BadgeCheck
                    className={cn("w-5 h-5", blueTick?.live ? "text-sky-400" : "text-white/40")}
                  />
                </div>
                <div>
                  <p className="font-display font-bold flex items-center gap-1.5">
                    Blue tick
                    {blueTick?.live && <BadgeCheck className="w-4 h-4 text-sky-400" />}
                  </p>
                  <p className="text-xs text-white/50">
                    {blueTick?.live
                      ? blueTick.expiresAt
                        ? `Verified until ${formatDay(blueTick.expiresAt)}`
                        : "Verified"
                      : `${formatTZS(blueTick?.price ?? 10000)} / month`}
                  </p>
                </div>
              </div>

              {blueTick?.live ? (
                <span className="text-xs px-3 py-1.5 rounded-full border border-sky-500/40 bg-sky-500/10 text-sky-300 font-medium">
                  Active
                </span>
              ) : blueTick?.pending ? (
                <span className="text-xs px-3 py-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-300 font-medium">
                  Awaiting approval
                </span>
              ) : (
                <button
                  onClick={() => setShowBlueTickModal(true)}
                  disabled={!blueTick}
                  className="btn-brand text-sm disabled:opacity-50"
                >
                  Get verified
                </button>
              )}
            </div>

            <p className="text-xs text-white/40 mt-3 leading-relaxed">
              {blueTick?.live
                ? "The badge is shown next to your name on your profile and wherever your videos appear."
                : blueTick?.pending
                  ? `TZS ${blueTick.pending.amount.toLocaleString()} received for ${blueTick.pending.months} month${blueTick.pending.months > 1 ? "s" : ""} — an admin approves it, then the badge appears.`
                  : "A verified badge next to your name, bought by the month. Pay from your wallet or your earnings — an admin approves it and it goes live."}
            </p>

            {!blueTick?.live && !blueTick?.pending && blueTick && (
              <p className="text-xs text-white/40 mt-2">
                Wallet {formatTZS(blueTick.walletBalance)} · earnings{" "}
                {formatTZS(blueTick.availableBalance)}
              </p>
            )}

            {blueTick?.history.some((row) => row.status === "REJECTED") && (
              <p className="text-xs text-amber-300/70 mt-2">
                A previous request was declined and refunded.
              </p>
            )}
          </div>

          {/* Share link */}
          <div className="glass-card p-5">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-brand-500/20 flex items-center justify-center">
                <Share2 className="w-5 h-5 text-brand-400" />
              </div>
              <div>
                <p className="font-display font-bold">Your link</p>
                <p className="text-xs text-white/50">
                  Anyone who opens it lands on your profile — no account needed.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 mt-4">
              <input
                readOnly
                value={profileUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="input-field text-xs flex-1"
                aria-label="Your shareable profile link"
              />
              <button
                onClick={copyProfileLink}
                className="btn-ghost shrink-0 flex items-center gap-1.5 text-sm"
                title="Copy link"
              >
                {linkCopied ? (
                  <Check className="w-4 h-4 text-emerald-400" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
                {linkCopied ? "Copied" : "Copy"}
              </button>
            </div>

            <div className="flex flex-wrap gap-2 mt-3">
              <button onClick={shareProfileLink} className="btn-ghost text-xs flex items-center gap-1.5">
                <Share2 className="w-3.5 h-3.5" /> Share
              </button>
              {profileUrl.startsWith("http") && (
                <a
                  href={`https://wa.me/?text=${encodeURIComponent(
                    `Watch my videos on Genhub: ${profileUrl}`
                  )}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-ghost text-xs"
                >
                  WhatsApp
                </a>
              )}
              <Link href={`/creator/${user?.id ?? ""}`} className="btn-ghost text-xs">
                View as a visitor
              </Link>
            </div>
          </div>
        </div>

        {/* Stats Row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="glass-card p-4 text-center">
            <Eye className="w-5 h-5 text-white/40 mx-auto mb-1" />
            <p className="text-lg font-bold">{formatCount(creatorData?.totalViews || 0)}</p>
            <p className="text-xs text-white/40">Total Views</p>
          </div>
          <div className="glass-card p-4 text-center">
            <Film className="w-5 h-5 text-white/40 mx-auto mb-1" />
            <p className="text-lg font-bold">{creatorData?.videoStats.length || 0}</p>
            <p className="text-xs text-white/40">Videos</p>
          </div>
          <div className="glass-card p-4 text-center">
            <BarChart3 className="w-5 h-5 text-white/40 mx-auto mb-1" />
            <p className="text-lg font-bold">
              {creatorData?.videoStats.reduce((s, v) => s + v.purchaseCount, 0) || 0}
            </p>
            <p className="text-xs text-white/40">Purchases</p>
          </div>
          <div className="glass-card p-4 text-center">
            <Banknote className="w-5 h-5 text-white/40 mx-auto mb-1" />
            <p className="text-lg font-bold">70%</p>
            <p className="text-xs text-white/40">Your Revenue Share</p>
          </div>
        </div>

        {/*
          Withdrawals — the money side, and the one thing a creator who has sold
          something looks for. How much is theirs, where it will be sent, and what
          is still holding it back, in one place that is always reachable.
        */}
        <div className="glass-card p-5">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/20 flex items-center justify-center">
                <Banknote className="w-5 h-5 text-emerald-400" />
              </div>
              <div>
                <p className="font-display font-bold">Withdraw your money</p>
                <p className="text-xs text-white/50">
                  {savedPayoutAccount
                    ? `Goes to ${describePayoutAccount(savedPayoutAccount)}`
                    : "To M-Pesa, Tigo Pesa, Airtel Money or a bank account — you enter it once and it is remembered."}
                </p>
              </div>
            </div>

            {/* Locked until the minimum is actually there, as it always was:
                a withdrawal below TZS 30,000 is not something the platform can
                send, so the button does not pretend otherwise. The blockers
                below say which condition is missing, which is the part that used
                to be missing — a greyed-out button and a parenthesis. */}
            <div className="flex flex-col items-end gap-1">
              <button
                onClick={openPayoutModal}
                disabled={!canRequestPayout}
                title={
                  canRequestPayout
                    ? "Withdraw to M-Pesa, Tigo Pesa, Airtel Money or your bank"
                    : "Unlocks at TZS 30,000 available with an approved identity check"
                }
                className="btn-brand flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Banknote className="w-4 h-4" /> Withdraw
              </button>
              {!canRequestPayout && (
                <span className="text-[11px] text-white/45">
                  Min TZS 30,000 + verified ID
                </span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4 text-sm">
            <div className="rounded-xl bg-surface-300/30 p-3">
              <p className="text-xs text-white/50">Available to withdraw</p>
              <p className="font-bold text-emerald-400">
                {formatTZS(balance?.availableBalance || 0)}
              </p>
            </div>
            <div className="rounded-xl bg-surface-300/30 p-3">
              <p className="text-xs text-white/50">Still clearing (14 days)</p>
              <p className="font-bold text-amber-400">
                {formatTZS(balance?.pendingBalance || 0)}
              </p>
            </div>
            <div className="rounded-xl bg-surface-300/30 p-3">
              <p className="text-xs text-white/50">Minimum per withdrawal</p>
              <p className="font-bold">TZS 30,000</p>
            </div>
          </div>

          {withdrawalBlockers.length > 0 && (
            <ul className="mt-4 space-y-2">
              {withdrawalBlockers.map((blocker) => (
                <li
                  key={blocker.text}
                  className="flex items-start gap-2 text-xs text-white/60 leading-relaxed"
                >
                  <AlertCircle className="w-3.5 h-3.5 text-amber-400/80 shrink-0 mt-0.5" />
                  <span>
                    {blocker.text}
                    {blocker.href && (
                      <Link
                        href={blocker.href}
                        className="text-brand-400 hover:underline ml-1 whitespace-nowrap"
                      >
                        {blocker.linkLabel}
                      </Link>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Videos still transcoding are held back from the public feed until
            they can actually play, so say so rather than letting a creator
            wonder why a finished upload is not live. */}
        {awaitingPublish > 0 && (
          <div className="glass-card p-4 flex items-start gap-3 border border-amber-500/20 bg-amber-500/5">
            <Loader2 className="w-5 h-5 text-amber-400 shrink-0 mt-0.5 animate-spin" />
            <div className="text-sm">
              <p className="font-medium text-amber-300">
                {awaitingPublish === 1
                  ? "1 video is still processing"
                  : `${awaitingPublish} videos are still processing`}
              </p>
              <p className="text-white/50 mt-0.5">
                They will go live on their own the moment Bunny Stream finishes —
                no action needed. You will get a notification when each one is ready.
              </p>
            </div>
          </div>
        )}

        {/* My Videos — everything this creator has posted, including the ones
            the public feed cannot show yet, with the actions they need on it. */}
        <div className="glass-card overflow-hidden">
          <div className="p-4 border-b border-white/10 flex items-center justify-between gap-3">
            <div>
              <h2 className="font-display font-bold">My Videos</h2>
              <p className="text-xs text-white/40 mt-0.5">
                {videos.length === 0
                  ? "Nothing posted yet"
                  : `${videos.length} posted · ` +
                    `${videos.filter((v) => !v.isPublished).length} not live`}
              </p>
            </div>
            <Link href="/creator/upload" className="btn-ghost text-xs flex items-center gap-1.5">
              <Upload className="w-3.5 h-3.5" /> Upload
            </Link>
          </div>

          <div className="divide-y divide-white/5">
            {videos.map((video) => (
              <div key={video.id} className="flex items-center gap-3 p-4 hover:bg-white/5 transition">
                {/* Thumbnail — the picture the viewer will see on the feed. A
                    missing one gets the same treatment as a broken one, because
                    from the creator's side both mean "post has no cover". */}
                <div className="w-24 h-16 shrink-0 rounded-lg overflow-hidden bg-surface-300/40 flex items-center justify-center">
                  {video.thumbnailUrl ? (
                    <Image
                      src={video.thumbnailUrl}
                      alt=""
                      width={96}
                      height={64}
                      unoptimized={!canOptimizeImage(video.thumbnailUrl)}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <ImageOff className="w-5 h-5 text-white/30" />
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium truncate">{video.title}</p>
                    {!video.isPublished && (
                      <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
                        Not live
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-white/40 mt-0.5">
                    {formatTZS(video.price)} · {formatCount(video.viewsCount)} views ·{" "}
                    {video.purchaseCount} sales · {formatRelativeTime(new Date(video.createdAt))}
                  </p>
                  <div className="mt-1">
                    <EncodingBadge encoding={video.encoding} />
                  </div>
                </div>

                {/* Actions */}
                <div className="relative shrink-0">
                  <button
                    type="button"
                    aria-label={`Actions for ${video.title}`}
                    aria-expanded={openMenuId === video.id}
                    onClick={() => setOpenMenuId(openMenuId === video.id ? null : video.id)}
                    disabled={deletingId === video.id}
                    className="p-2 rounded-lg hover:bg-white/10 transition disabled:opacity-50"
                  >
                    {deletingId === video.id ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <MoreVertical className="w-4 h-4" />
                    )}
                  </button>

                  {openMenuId === video.id && (
                    <div className="absolute right-0 top-10 z-20 min-w-[180px] rounded-xl border border-white/10 bg-surface-200 py-1 shadow-xl">
                      <button
                        type="button"
                        onClick={() => openEditor(video)}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-white/10 transition"
                      >
                        <Pencil className="w-3.5 h-3.5" /> Edit title & price
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setOpenMenuId(null);
                          void togglePublished(video);
                        }}
                        disabled={publishingId === video.id}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-white/10 transition disabled:opacity-50"
                      >
                        {video.isPublished ? (
                          <>
                            <EyeOff className="w-3.5 h-3.5" /> Take out of the feed
                          </>
                        ) : (
                          <>
                            <Upload className="w-3.5 h-3.5" /> Publish now
                          </>
                        )}
                      </button>
                      <Link
                        href={`/video/${video.slug || video.id}`}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-white/10 transition"
                        onClick={() => setOpenMenuId(null)}
                      >
                        <Eye className="w-3.5 h-3.5" /> View as a viewer
                      </Link>
                      <button
                        type="button"
                        onClick={() => void removeVideo(video)}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red-400 hover:bg-red-500/10 transition"
                      >
                        <Trash2 className="w-3.5 h-3.5" /> Delete video
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {videos.length === 0 && (
              <div className="px-4 py-12 text-center">
                <Film className="w-8 h-8 mx-auto text-white/20 mb-3" />
                <p className="text-white/50 text-sm">You have not posted a video yet</p>
                <Link href="/creator/upload" className="btn-brand inline-flex items-center gap-2 mt-4">
                  <Upload className="w-4 h-4" /> Upload your first video
                </Link>
              </div>
            )}
          </div>
        </div>

        {/* Video Performance Table */}
        <div className="glass-card overflow-hidden">
          <div className="p-4 border-b border-white/10">
            <h2 className="font-display font-bold">Video Performance</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left text-xs text-white/50 border-b border-white/5">
                  <th className="px-4 py-3">Video</th>
                  <th className="px-4 py-3">Price</th>
                  <th className="px-4 py-3">Views</th>
                  <th className="px-4 py-3">Sales</th>
                  <th className="px-4 py-3">Revenue</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {(creatorData?.videoStats || []).map((v) => (
                  <tr key={v.id} className="border-b border-white/5 hover:bg-white/5 transition">
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium truncate max-w-[200px]">{v.title}</p>
                      <p className="text-xs text-white/40">
                        {formatRelativeTime(new Date(v.createdAt))}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-sm">{formatTZS(v.price)}</td>
                    <td className="px-4 py-3 text-sm">{formatCount(v.viewsCount)}</td>
                    <td className="px-4 py-3 text-sm">{v.purchaseCount}</td>
                    <td className="px-4 py-3 text-sm font-medium text-emerald-400">
                      {formatTZS(v.totalEarned)}
                    </td>
                    <td className="px-4 py-3">
                      <EncodingBadge encoding={encodingById.get(v.id)?.encoding} />
                      {encodingById.get(v.id)?.isPublished === false && (
                        <button
                          onClick={() => {
                            const video = encodingById.get(v.id);
                            if (video) togglePublished(video);
                          }}
                          disabled={publishingId === v.id}
                          className="mt-1 flex items-center gap-1 text-xs text-brand-400 hover:text-brand-300 disabled:opacity-50"
                        >
                          {publishingId === v.id ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Upload className="w-3 h-3" />
                          )}
                          Publish now
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {(!creatorData?.videoStats || creatorData.videoStats.length === 0) && (
                  <tr>
                    <td colSpan={6} className="px-4 py-12 text-center text-white/40">
                      No videos yet
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Paid Messages — the inbox as a revenue line. Every message is paid,
            and the money clears on the same 14-day schedule as a video sale, so
            the held part is shown with the date it frees up instead of being
            folded into one number that cannot be spent yet. */}
        <div className="glass-card p-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-brand-500/20 flex items-center justify-center">
                <MessageSquare className="w-5 h-5 text-brand-400" />
              </div>
              <div>
                <h2 className="font-display font-bold">Paid Messages</h2>
                <p className="text-xs text-white/40">
                  Every message a fan sends you is worth what they chose to pay — you keep 70% of it
                </p>
              </div>
            </div>
            <Link href="/inbox" className="text-xs text-brand-400 hover:underline">
              Open inbox →
            </Link>
          </div>

          {!paidMessages ? (
            <p className="text-sm text-white/40">
              Message earnings could not be loaded just now. Refresh to try again.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="rounded-xl bg-surface-300/30 p-4">
                  <p className="text-xs text-white/40">Messages received</p>
                  <p className="text-xl font-bold mt-1">
                    {formatCount(paidMessages.messages)}
                  </p>
                </div>
                <div className="rounded-xl bg-surface-300/30 p-4">
                  <p className="text-xs text-white/40">Earned from messages</p>
                  <p className="text-xl font-bold mt-1 text-emerald-400">
                    {formatTZS(paidMessages.earned)}
                  </p>
                  <p className="text-[11px] text-white/35 mt-1">
                    your 70% of {formatTZS(paidMessages.gross)} paid by fans
                    {paidMessages.cleared > 0
                      ? ` · ${formatTZS(paidMessages.cleared)} cleared`
                      : ""}
                  </p>
                </div>
                <div className="rounded-xl bg-surface-300/30 p-4">
                  <p className="text-xs text-white/40">In 14-day holding</p>
                  <p className="text-xl font-bold mt-1 text-amber-400">
                    {formatTZS(paidMessages.held)}
                  </p>
                  <p className="text-[11px] text-white/35 mt-1">
                    {paidMessages.heldMessages === 0
                      ? "Nothing held right now"
                      : `${paidMessages.heldMessages} message${
                          paidMessages.heldMessages === 1 ? "" : "s"
                        }${
                          paidMessages.nextReleaseAt
                            ? ` — first frees up ${formatDay(paidMessages.nextReleaseAt)}`
                            : ""
                        }`}
                  </p>
                </div>
              </div>

              {paidMessages.recent.length > 0 ? (
                <div className="mt-4 space-y-2">
                  {paidMessages.recent.map((m) => (
                    <div
                      key={m.id}
                      className="flex items-center gap-3 p-3 rounded-xl bg-surface-300/20"
                    >
                      <div className="w-9 h-9 rounded-full bg-brand-500/20 flex items-center justify-center text-brand-400 font-bold text-sm shrink-0">
                        {m.sender.displayName?.[0] || "U"}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm truncate">
                          {m.sender.displayName || "A fan"}
                        </p>
                        <p className="text-xs text-white/40">
                          {formatRelativeTime(new Date(m.createdAt))}
                          {m.held ? ` · clears ${formatDay(m.clearsAt)}` : " · cleared"}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="font-bold text-sm text-emerald-400">
                          +{formatTZS(m.earned)}
                        </p>
                        <p className="text-[11px] text-white/35">
                          {formatTZS(m.amount)} paid
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-white/40 mt-4">
                  No paid messages yet. A fan picks the amount when they write to you, and it
                  shows up here — the one part of this dashboard that comes from your inbox.
                </p>
              )}
            </>
          )}
        </div>

        {/* Recent Transactions */}
        <div className="glass-card p-4">
          <h2 className="font-display font-bold mb-4">Recent Transactions</h2>
          <div className="space-y-3">
            {(creatorData?.recentTransactions || []).map((tx) => (
              <div
                key={tx.id}
                className="flex items-center gap-3 p-3 rounded-xl bg-surface-300/30"
              >
                <div className="w-10 h-10 rounded-full bg-emerald-500/20 flex items-center justify-center">
                  <ArrowUpRight className="w-5 h-5 text-emerald-400" />
                </div>
                <div className="flex-1">
                  <p className="text-sm">{transactionLabel(tx)}</p>
                  <p className="text-xs text-white/40">
                    {formatRelativeTime(new Date(tx.createdAt))}
                  </p>
                </div>
                <p className="font-bold text-sm text-emerald-400">
                  +{formatTZS(tx.creatorCut || tx.amount)}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/*
          Withdrawals — where the money went, and the one thing a creator
          actually needs from a payout: the receipt number, so they can match it
          against the M-Pesa SMS or the bank alert on their own phone. A paid row
          without it is why this section exists.
        */}
        <div className="glass-card p-4">
          <h2 className="font-display font-bold mb-4">Withdrawals</h2>
          {(creatorData?.payouts || []).length === 0 ? (
            <p className="text-sm text-white/40">
              No withdrawal requests yet. Use <strong>Withdraw</strong> above when you
              have at least TZS 30,000 available; the request appears here with its
              status and, once paid, the receipt number.
            </p>
          ) : (
            <div className="space-y-3">
              {(creatorData?.payouts || []).map((payout) => (
                <div
                  key={payout.id}
                  className="flex items-center gap-3 p-3 rounded-xl bg-surface-300/30"
                >
                  <div className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center shrink-0">
                    <Banknote className="w-5 h-5 text-white/60" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm">
                      {formatTZS(payout.amount)}
                      <span className="text-white/40">
                        {" • "}
                        {describePayoutAccount(payout)}
                      </span>
                    </p>
                    <p className="text-xs text-white/40">
                      Requested {formatRelativeTime(new Date(payout.createdAt))}
                    </p>
                    {payout.status === "PAID" && payout.paymentReference && (
                      <p className="text-xs text-emerald-400 mt-0.5">
                        Receipt: {payout.paymentReference}
                      </p>
                    )}
                    {payout.status === "REJECTED" && payout.adminNote && (
                      <p className="text-xs text-red-400/80 mt-0.5">
                        Reason: {payout.adminNote}
                      </p>
                    )}
                  </div>
                  <PayoutStatus status={payout.status} />
                </div>
              ))}
            </div>
          )}
        </div>
      </main>

      {/* Cover cropper — a 16:9 frame, because that is the shape the feed draws. */}
      {coverCropFile && (
        <ImageCropper
          file={coverCropFile}
          shape="wide"
          confirmLabel="Use this cover"
          busy={uploadingCover}
          onCancel={() => setCoverCropFile(null)}
          onConfirm={(cropped) => {
            setCoverCropFile(null);
            void uploadCover(cropped);
          }}
        />
      )}

      {/* Edit Video Modal — everything a viewer sees before paying, in one form. */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 backdrop-blur-sm p-4">
          <div className="glass-card my-auto w-full max-w-2xl p-6">
            <h2 className="text-xl font-display font-bold mb-1">Edit video</h2>
            <p className="text-xs text-white/40 mb-5">
              The cover, the title, the description, the price and the free preview —
              everything a viewer sees before they pay. The file itself is replaced
              by uploading again.
            </p>

            <div className="space-y-5">
              {/* Cover image */}
              <div>
                <label className="text-sm text-white/60 mb-2 block">Cover image</label>
                <div className="flex items-start gap-4">
                  <div className="w-40 h-24 shrink-0 rounded-xl overflow-hidden bg-surface-300/40 flex items-center justify-center">
                    {editCoverUrl ? (
                      <Image
                        src={editCoverUrl}
                        alt=""
                        width={160}
                        height={96}
                        unoptimized={!canOptimizeImage(editCoverUrl)}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <ImageOff className="w-5 h-5 text-white/30" />
                    )}
                  </div>
                  <div className="space-y-2">
                    <label className="btn-ghost inline-flex items-center gap-1.5 text-xs cursor-pointer">
                      {uploadingCover ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Upload className="w-3.5 h-3.5" />
                      )}
                      {uploadingCover ? "Uploading…" : editCoverUrl ? "Replace cover" : "Add cover"}
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        className="hidden"
                        disabled={uploadingCover}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          // Reset so picking the same file again still fires.
                          e.target.value = "";
                          if (!file) return;
                          if (!file.type.startsWith("image/")) {
                            toast("error", "Please choose an image file");
                            return;
                          }
                          // Frame it as a 16:9 cover before it is uploaded.
                          setCoverCropFile(file);
                        }}
                      />
                    </label>
                    <p className="text-xs text-white/40">
                      JPEG, PNG or WebP, up to 5 MB. This is the picture on the feed —
                      you can move and zoom it before it is saved.
                    </p>
                  </div>
                </div>
              </div>

              <div>
                <label className="text-sm text-white/60 mb-2 block" htmlFor="edit-title">
                  Title
                </label>
                <input
                  id="edit-title"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  maxLength={200}
                  className="input-field"
                />
              </div>

              <div>
                <label className="text-sm text-white/60 mb-2 block" htmlFor="edit-description">
                  Description
                </label>
                <textarea
                  id="edit-description"
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  maxLength={5000}
                  rows={3}
                  placeholder="What happens in this video?"
                  className="input-field min-h-[90px] resize-y text-white/80"
                />
                <p className="text-xs text-white/40 mt-1">
                  {editDescription.length}/5000 characters
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-sm text-white/60 mb-2 block flex items-center gap-2" htmlFor="edit-price">
                    <DollarSign className="w-4 h-4" /> Price (TZS)
                  </label>
                  <input
                    id="edit-price"
                    type="number"
                    min={0}
                    max={1000000}
                    value={editPrice}
                    onChange={(e) => setEditPrice(e.target.value)}
                    className="input-field"
                  />
                  <p className="text-xs text-white/40 mt-1">
                    {editPrice.trim() === ""
                      ? "Enter a price — an empty box is not a price, and it is not free either."
                      : Number(editPrice) === 0
                        ? "Free to watch — anyone, signed in or not, can see the whole video."
                        : `You keep ${formatTZS(Math.round(Number(editPrice) * 0.7))} of each sale (70%); 0 makes it free to watch.`}
                  </p>
                </div>
                <div>
                  <label className="text-sm text-white/60 mb-2 block flex items-center gap-2" htmlFor="edit-teaser">
                    <Film className="w-4 h-4" /> Free preview (seconds)
                  </label>
                  <input
                    id="edit-teaser"
                    type="number"
                    min={15}
                    max={30}
                    value={editTeaserDuration}
                    onChange={(e) => setEditTeaserDuration(parseInt(e.target.value) || 15)}
                    className="input-field"
                  />
                  <p className="text-xs text-white/40 mt-1">
                    How much a viewer sees before paying. 15-30 seconds. This is the
                    duration badge; it does not unlock part of the video — a paid scene
                    with no trailer clip shows no preview at all.
                  </p>
                </div>
              </div>

              {/* Intro trailer — the clip a non-buyer watches before the paywall */}
              <div className="rounded-xl border border-white/10 p-4">
                <label className="text-sm text-white/60 mb-2 flex items-center gap-2">
                  <Clapperboard className="w-4 h-4" /> Intro trailer clip
                </label>
                <p className="text-xs text-white/45 mb-3 leading-relaxed">
                  A short clip (10–30s) that people who have not paid can watch, with an
                  unlock offer under it. Without one, a paid scene shows only a poster —
                  we will not sign a non-buyer into the whole video to give them a preview.
                </p>

                <div className="flex flex-wrap items-center gap-3">
                  <label className="btn-ghost cursor-pointer inline-flex items-center gap-2 text-sm">
                    <span aria-hidden>🎬</span>
                    <span>
                      {uploadingEditTeaser
                        ? `Uploading… ${editTeaserProgress}%`
                        : newTeaserBunnyVideoId
                          ? "Replace the new trailer"
                          : editTeaserAttached
                            ? "Replace trailer clip"
                            : "Choose a trailer clip"}
                    </span>
                    <input
                      type="file"
                      accept="video/*"
                      className="hidden"
                      disabled={uploadingEditTeaser}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) uploadEditTeaser(file);
                      }}
                    />
                  </label>

                  {(newTeaserBunnyVideoId || editTeaserAttached) && (
                    <span
                      className={cn(
                        "text-xs",
                        newTeaserBunnyVideoId ? "text-amber-400/80" : "text-emerald-400/80"
                      )}
                    >
                      {newTeaserBunnyVideoId
                        ? "New trailer ready — press Save to attach it"
                        : "Trailer attached — non-buyers see this instead of the full video"}
                    </span>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-sm text-white/60 mb-2 block" htmlFor="edit-category">
                    Category
                  </label>
                  <select
                    id="edit-category"
                    value={editCategory}
                    onChange={(e) => setEditCategory(e.target.value)}
                    className="input-field"
                  >
                    <option value="">No category</option>
                    {CATEGORIES.filter((c) => c.id !== "all").map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                    {/* A video tagged before the category list changed still
                        holds a slug that is no longer offered. Without this the
                        select renders empty and a later save would silently
                        erase the tag the creator already chose. */}
                    {editCategory && !CATEGORIES.some((c) => c.id === editCategory) && (
                      <option value={editCategory}>{editCategory} (old tag)</option>
                    )}
                  </select>
                </div>
                <div>
                  <label className="text-sm text-white/60 mb-2 block flex items-center gap-2" htmlFor="edit-tags">
                    <Tag className="w-4 h-4" /> Tags (comma separated)
                  </label>
                  <input
                    id="edit-tags"
                    value={editTags}
                    onChange={(e) => setEditTags(e.target.value)}
                    maxLength={200}
                    placeholder="music, tanzania, africa"
                    className="input-field"
                  />
                  <p className="text-xs text-white/40 mt-1">
                    {editTags.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 10).length}/10 tags
                  </p>
                </div>
              </div>

              {/* Captions */}
              <div>
                <label
                  className="text-sm text-white/60 mb-2 block flex items-center gap-2"
                  htmlFor="edit-captions"
                >
                  <Captions className="w-4 h-4" /> Captions (.vtt)
                </label>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    id="edit-captions"
                    value={editCaptionsUrl}
                    onChange={(e) => setEditCaptionsUrl(e.target.value)}
                    maxLength={2048}
                    placeholder="https://… or upload a file"
                    className="input-field flex-1"
                  />
                  <label className="btn-ghost inline-flex items-center justify-center gap-1.5 text-xs cursor-pointer whitespace-nowrap">
                    {uploadingCaptions ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Upload className="w-3.5 h-3.5" />
                    )}
                    {uploadingCaptions ? "Uploading…" : "Upload .vtt"}
                    <input
                      type="file"
                      accept=".vtt,text/vtt"
                      className="hidden"
                      disabled={uploadingCaptions}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (file) void uploadCaptions(file);
                      }}
                    />
                  </label>
                </div>
                <p className="text-xs text-white/40 mt-1">
                  A WebVTT file, so deaf and hard-of-hearing viewers can follow the
                  scene and anyone can watch with the sound off. Leave it empty for no
                  captions. Viewers turn them on with the CC button.
                </p>
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button onClick={() => setEditing(null)} className="btn-ghost flex-1">
                Cancel
              </button>
              <button
                onClick={saveEdit}
                disabled={savingEdit}
                className="btn-brand flex-1 flex items-center justify-center gap-2"
              >
                {savingEdit && <Loader2 className="w-4 h-4 animate-spin" />}
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Payout Modal — withdraw to a phone number or a bank account. */}
      {showPayoutModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="glass-card w-full max-w-md p-6 animate-slide-up">
            <h2 className="text-xl font-display font-bold mb-2">Withdraw money</h2>
            <p className="text-sm text-white/50 mb-4">
              Available balance: {formatTZS(balance?.availableBalance || 0)} · minimum
              TZS 30,000 per request.
            </p>

            {savedPayoutAccount && (
              <p className="mb-4 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/70">
                Filled in from your last withdrawal:{" "}
                <span className="text-white/90">{describePayoutAccount(savedPayoutAccount)}</span>.
                Change it below and the new account is used from then on.
              </p>
            )}

            {!canRequestPayout && withdrawalBlockers.length > 0 && (
              <ul className="mb-4 space-y-1.5 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2">
                {withdrawalBlockers.map((blocker) => (
                  <li key={blocker.text} className="text-xs text-amber-200/90 leading-relaxed">
                    {blocker.text}
                  </li>
                ))}
              </ul>
            )}

            <div className="space-y-4">
              <div>
                <label className="text-sm text-white/60 mb-2 block">Amount (TZS)</label>
                <input
                  type="number"
                  value={payoutAmount}
                  onChange={(e) => setPayoutAmount(parseInt(e.target.value) || 0)}
                  min={30000}
                  max={balance?.availableBalance || 0}
                  className="input-field"
                />
              </div>

              <div>
                <label className="text-sm text-white/60 mb-2 block">Payment Method</label>
                <select
                  value={payoutMethod}
                  onChange={(e) => setPayoutMethod(e.target.value)}
                  className="input-field"
                >
                  {PAYOUT_METHODS.map((method) => (
                    <option key={method} value={method}>
                      {PAYOUT_METHOD_LABEL[method]}
                    </option>
                  ))}
                </select>
              </div>

              {/* A bank needs to know WHICH bank: the account number alone is not
                  a destination. The API has always accepted this; the form never
                  sent it, so the admin paying it out had a number and no bank. */}
              {isBankPayout(payoutMethod) && (
                <div>
                  <label className="text-sm text-white/60 mb-2 block">Bank name</label>
                  <input
                    type="text"
                    value={payoutBankName}
                    onChange={(e) => setPayoutBankName(e.target.value)}
                    placeholder="e.g. CRDB, NMB, NBC"
                    className="input-field"
                  />
                </div>
              )}

              <div>
                <label className="text-sm text-white/60 mb-2 block">
                  {isBankPayout(payoutMethod) ? "Account number" : "Phone number"}
                </label>
                <input
                  type="text"
                  value={payoutAccount}
                  onChange={(e) => setPayoutAccount(e.target.value)}
                  placeholder={
                    isBankPayout(payoutMethod) ? "Account number" : "07XX XXX XXX"
                  }
                  className="input-field"
                />
                <p className="text-xs text-white/40 mt-1">
                  The money is sent here, so double-check it — a wrong number cannot be
                  recalled once it is sent.
                </p>
              </div>

              <div className="flex gap-3">
                <button onClick={() => setShowPayoutModal(false)} className="btn-ghost flex-1">
                  Cancel
                </button>
                <button
                  onClick={handlePayout}
                  disabled={
                    requestingPayout ||
                    !canRequestPayout ||
                    payoutAmount < 30000 ||
                    !payoutAccount ||
                    (isBankPayout(payoutMethod) && !payoutBankName.trim())
                  }
                  className="btn-brand flex-1"
                >
                  {requestingPayout ? "Submitting..." : "Withdraw"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Blue tick checkout. The months are chosen here and charged once, up
          front: the request then waits for an admin, and a declined request is
          refunded to the same balance it came from. */}
      {showBlueTickModal && blueTick && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="glass-card w-full max-w-md p-6 animate-slide-up">
            <h2 className="text-xl font-display font-bold mb-1 flex items-center gap-2">
              <BadgeCheck className="w-5 h-5 text-sky-400" /> Blue tick
            </h2>
            <p className="text-white/60 text-sm mb-5">
              TZS {blueTick.price.toLocaleString()} for {blueTick.monthDays} days, shown next to
              your name everywhere your profile appears. An admin approves it before it goes
              live; if they decline it, you are refunded in full.
            </p>

            <div className="space-y-4">
              <div>
                <label className="text-sm text-white/60 mb-2 block">How many months?</label>
                <div className="flex gap-2">
                  {[1, 3, 6, 12]
                    .filter((m) => m <= blueTick.maxMonths)
                    .map((m) => (
                      <button
                        key={m}
                        onClick={() => setBlueTickMonths(m)}
                        className={cn(
                          "flex-1 py-2 rounded-xl border text-sm font-medium transition",
                          blueTickMonths === m
                            ? "border-brand-500/60 bg-brand-500/20 text-brand-300"
                            : "border-white/10 bg-white/5 text-white/60 hover:border-white/25"
                        )}
                      >
                        {m}
                      </button>
                    ))}
                </div>
              </div>

              <div className="bg-surface-300/40 rounded-xl p-4 flex justify-between text-sm">
                <span className="text-white/60">Total</span>
                <span className="font-bold text-brand-400">
                  TZS {(blueTick.price * blueTickMonths).toLocaleString()}
                </span>
              </div>

              <p className="text-xs text-white/40">
                Paid from your wallet first, then your available earnings. Wallet{" "}
                {formatTZS(blueTick.walletBalance)} · earnings{" "}
                {formatTZS(blueTick.availableBalance)}.
              </p>

              {blueTick.price * blueTickMonths >
                Math.max(blueTick.walletBalance, blueTick.availableBalance) && (
                <p className="text-xs text-amber-300/90">
                  Neither balance covers this yet. Earn or top up, then come back — the option
                  stays here.
                </p>
              )}

              <div className="flex gap-3">
                <button onClick={() => setShowBlueTickModal(false)} className="btn-ghost flex-1">
                  Cancel
                </button>
                <button
                  onClick={buyBlueTick}
                  disabled={
                    buyingBlueTick ||
                    blueTick.price * blueTickMonths >
                      Math.max(blueTick.walletBalance, blueTick.availableBalance)
                  }
                  className="btn-brand flex-1 disabled:opacity-50"
                >
                  {buyingBlueTick
                    ? "Processing..."
                    : `Pay TZS ${(blueTick.price * blueTickMonths).toLocaleString()}`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
