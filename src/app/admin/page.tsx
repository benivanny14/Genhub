"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Header from "@/components/Header";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import {
  Shield,
  HelpCircle,
  RotateCcw,
  Smartphone,
  Users,
  AlertTriangle,
  DollarSign,
  BarChart3,
  CheckCircle,
  XCircle,
  Clock,
  Eye,
  Ban,
  FileText,
  TrendingUp,
  Activity,
  HardDrive,
  BadgeCheck,
  UserX,
  Ticket,
  Wallet,
  CreditCard,
  RefreshCcw,
  ReceiptText,
  Loader2,
  Play,
  Rocket,
  Upload,
} from "lucide-react";

/**
 * Live readiness of the things that cannot be fixed from the code — the video
 * host, email/SMS delivery, the app URL used for webhooks, and the payment
 * gateway's own account state. Admin needs to see these without shell access.
 */
interface SystemReadiness {
  appUrl?: string;
  appUrlSource?: string;
  gateway?: string;
  readyForLive?: boolean;
  sandbox?: boolean;
  checks: { key: string; ok: boolean; value?: string | number; hint?: string }[];
  topWarnings: string[];
  /**
   * The launch gate, asked of this deployment (§ `/api/admin/launch-readiness`).
   * Unlike `topWarnings`, every entry here is a hard stop before real users, so
   * the card can lead with a verdict instead of a list to interpret.
   */
  launch?: {
    ready: boolean;
    blockers: { id: string; label: string; fix: string }[];
  };
  delivery?: { stuckPending?: number; deliveryWarning?: string | null };
  /**
   * The local gateway circuit breaker. Open means calls are being skipped for a
   * moment because HarakaPay stopped answering — not that the key is wrong.
   */
  gatewayBreaker?: {
    open?: boolean;
    failures?: number;
    skipped?: number;
    warning?: string | null;
  };
}

/**
 * Liveness of the scheduled background workers. A schedule that stops firing
 * produces no request and no error, so this is the only place it can show up.
 */
interface CronWorkerHealth {
  id: string;
  name: string;
  consequence: string;
  schedule: string;
  everyMinutes: number;
  staleAfterMinutes: number;
  inFlightGraceMinutes: number;
  /** Reaches a customer's phone, so "Run now" asks before starting it. */
  sendsCustomerRequests: boolean;
  state: "never" | "late" | "stalled" | "failing" | "running" | "ok";
  ageMinutes: number | null;
  /** The last moment this worker did anything — the run it finished, or the run
   *  it started and never came back from. null when it has never run. */
  silentSince: string | null;
  /** Minutes since `silentSince`; differs from ageMinutes for a killed run. */
  silentForMinutes: number | null;
  lastSummary: string | null;
  lastError: string | null;
  lastDurationMs: number | null;
  consecutiveFailures: number;
  runsTotal: number;
  unfinishedRun: boolean;
  detail: string;
}

interface CronHealth {
  workers: CronWorkerHealth[];
  /** Workers needing attention, most urgent first — the server owns the order. */
  needsAttention: string[];
  /** Those workers named, with how long each has been quiet. */
  attentionSummary: string;
  counts: Record<CronWorkerHealth["state"], number>;
  alerting: number;
  degraded: boolean;
  checkedAt: string;
}

interface KycItem {
  id: string;
  userId: string;
  idDocumentUrl: string;
  selfieUrl: string;
  idDocumentType: string | null;
  status: string;
  createdAt: string;
  user: {
    id: string;
    displayName: string | null;
    email: string | null;
    phone: string | null;
    createdAt: string;
  };
}

interface ReportItem {
  id: string;
  reason: string;
  description: string | null;
  status: string;
  createdAt: string;
  reporter: { id: string; displayName: string | null; phone: string | null };
  video: {
    id: string;
    title: string;
    thumbnailUrl: string | null;
    creator: { id: string; displayName: string | null; strikes: number };
  };
}

interface PayoutItem {
  id: string;
  amount: number;
  paymentMethod: string;
  accountDetails: string;
  status: string;
  createdAt: string;
  creator: {
    id: string;
    displayName: string | null;
    phone: string | null;
    email: string | null;
    kycStatus: string;
  };
}

interface CreatorItem {
  id: string;
  displayName: string | null;
  email: string | null;
  phone: string | null;
  role: string;
  isVerified: boolean;
  isBanned: boolean;
  banReason: string | null;
  kycStatus: string;
  strikes: number;
  walletBalance: number;
  createdAt: string;
  _count: { videos: number };
}

interface OverviewData {
  users: { total: number; creators: number; viewers: number; admins: number; banned: number };
  videos: { total: number; published: number; flagged: number };
  engagement: { totalViews: number; activeSubscriptions: number; totalFavorites: number };
  transactions: { total: number; totalAmount: number; todayAmount: number; totalPlatformFees: number; totalCreatorPayouts: number };
  overview: { platformRevenue: number; creatorEarnings: number };
  kyc: { pending: number };
  payouts: { pending: number };
  topCreators: { id: string; displayName: string | null; totalEarned: number; availableBalance: number; pendingBalance: number; strikes: number }[];
}

interface CouponItem {
  id: string;
  code: string;
  type: string;
  value: number;
  isActive: boolean;
  maxUses: number | null;
  usedCount: number;
  expiresAt: string | null;
  createdAt: string;
}

interface EarningsCreator {
  creatorId: string;
  displayName: string | null;
  email: string | null;
  avatarUrl: string | null;
  isVerified: boolean;
  kycStatus: string;
  pendingBalance: number;
  availableBalance: number;
  releasedTotal: number;
  totalEarned: number;
  maturedTotal: number;
  readyToRelease: number;
}

interface EarningsData {
  creators: EarningsCreator[];
  totals: { pending: number; available: number; released: number; ready: number };
  holdingPeriodDays: number;
}

interface AdminPayment {
  id: string;
  amount: number;
  type: string;
  status: string;
  gateway: string | null;
  providerRef: string | null;
  createdAt: string;
  ageMinutes: number;
  stuck: boolean;
  viewer: { id: string; displayName: string | null; email: string | null; phone: string | null };
  video: { id: string; title: string } | null;
  creator: { id: string; displayName: string | null } | null;
}

interface PaymentSummary {
  pending: number;
  stuck: number;
  /** Charges a customer may already have paid for — needs a human decision. */
  investigating?: number;
  stuckAfterMinutes: number;
}

/**
 * The launch checklist, as reported by /api/admin/setup. This is the half that
 * used to only exist in a terminal: which values are still missing, where each
 * one comes from, and whether a value that IS set actually works.
 */
interface SetupItem {
  id: string;
  key: string | null;
  title: string;
  site: string;
  steps: string[];
  example?: string;
  must?: string;
  mustHint?: string;
  forbid?: string;
  forbidHint?: string;
  sensitive?: boolean;
  state: "ok" | "missing" | "placeholder" | "local" | "wrong";
  /** A safe summary. Secrets arrive as "set · 64 characters", never in full. */
  display: string | null;
  hint?: string;
  restartPending: boolean;
}

interface SetupGroup {
  id: string;
  title: string;
  cost: string;
  time: string;
  blurb: string;
  items: SetupItem[];
}

interface SetupProbe {
  id: string;
  name: string;
  state: "ok" | "warn" | "fail" | "skip";
  detail: string;
}

interface SetupReport {
  groups: SetupGroup[];
  summary: { done: number; todo: number; restartPending: number };
  envFile: { path: string; present: boolean };
  probes?: SetupProbe[];
}

/** Result of the real upload round trip (POST /api/admin/bunny-self-test). */
interface PipelineTest {
  verdict: "ok" | "accepted-not-stored" | "failed";
  headline: string;
  detail: string;
  bytesSent: number;
  steps: { label: string; ok: boolean; detail: string }[];
}

function SetupStateIcon({ state }: { state: SetupItem["state"] }) {
  if (state === "ok") return <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />;
  // "wrong" is a value that fails the shape this variable must have, so it is a
  // failure rather than a warning - unlike "local", which is fine on a laptop.
  if (state === "placeholder" || state === "local")
    return <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />;
  return <XCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />;
}

function SetupProbeIcon({ state }: { state: SetupProbe["state"] }) {
  if (state === "ok") return <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />;
  if (state === "warn") return <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />;
  if (state === "skip") return <Clock className="w-4 h-4 text-white/25 shrink-0 mt-0.5" />;
  return <XCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />;
}

const JOB_STATE_LABEL: Record<CronWorkerHealth["state"], string> = {
  ok: "Running on schedule",
  running: "Running now",
  late: "Overdue",
  // Distinct from "overdue" on purpose: the schedule is fine here, the job is
  // dying when it runs, and the two need different fixes.
  stalled: "Killed mid-run",
  failing: "Failing",
  never: "Never run",
};

/** States that mean someone should look. */
const JOB_STATE_ALERTS: CronWorkerHealth["state"][] = ["late", "stalled", "failing"];

/**
 * The workers needing attention first, in the order the API ranked them.
 *
 * The list is otherwise in registry order, which puts whichever worker stopped
 * wherever it happens to sit — so on a card whose entire job is to say what
 * stopped, finding it meant reading all four rows and comparing their ages. The
 * order comes from the server rather than being recomputed here, so the card and
 * the API cannot disagree about which problem is the urgent one.
 */
function orderForAttention(jobs: CronHealth): CronWorkerHealth[] {
  const rank = new Map(jobs.needsAttention.map((id, i) => [id, i]));
  // Stable sort: workers that need nothing keep their registry order.
  return [...jobs.workers].sort(
    (a, b) =>
      (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER)
  );
}

function JobStateIcon({ state }: { state: CronWorkerHealth["state"] }) {
  if (state === "ok") return <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />;
  if (state === "running")
    return <Loader2 className="w-4 h-4 text-blue-400 shrink-0 mt-0.5 animate-spin" />;
  if (state === "late") return <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />;
  if (state === "stalled") return <Clock className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />;
  if (state === "failing") return <XCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />;
  // Muted, not red: a worker that has never run usually means no scheduler is
  // configured yet, which is setup work rather than something that broke.
  return <HelpCircle className="w-4 h-4 text-white/25 shrink-0 mt-0.5" />;
}

function SetupGroupCard({ group }: { group: SetupGroup }) {
  const pending = group.items.filter((i) => i.state !== "ok");
  const settled = group.items.filter((i) => i.state === "ok");

  return (
    <div className="glass-card p-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h3 className="font-display font-bold flex items-center gap-2">
            {pending.length === 0 ? (
              <CheckCircle className="w-5 h-5 text-emerald-400" />
            ) : (
              <Clock className="w-5 h-5 text-amber-400" />
            )}
            {group.title}
          </h3>
          <p className="text-sm text-white/50 mt-1 max-w-2xl">{group.blurb}</p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-xs text-white/40">{group.cost}</p>
          <p className="text-xs text-white/30">{group.time}</p>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {pending.map((item) => (
          <div key={item.id} className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
            <div className="flex items-start gap-3">
              <SetupStateIcon state={item.state} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-medium">{item.title}</p>
                  {item.key ? (
                    <code className="text-xs text-brand-300/80">{item.key}</code>
                  ) : (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-white/5 text-white/50">
                      dashboard, not a file
                    </span>
                  )}
                  {item.display && (
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${
                        item.sensitive
                          ? "bg-emerald-500/10 text-emerald-300/80"
                          : "bg-white/5 text-white/50"
                      }`}
                    >
                      {item.display}
                    </span>
                  )}
                </div>

                {item.hint && <p className="text-xs text-amber-300/80 mt-1.5">{item.hint}</p>}
                {item.restartPending && (
                  <p className="text-xs text-amber-300/80 mt-1.5">
                    Saved after this server started - restart to apply.
                  </p>
                )}

                <p className="text-xs text-white/40 mt-2">
                  Where: <span className="text-white/60">{item.site}</span>
                </p>
                <ol className="mt-2 space-y-1 list-decimal list-inside">
                  {item.steps.map((step, i) => (
                    <li key={i} className="text-xs text-white/60">
                      {step}
                    </li>
                  ))}
                </ol>
                {item.example && (
                  <p className="mt-2 text-xs">
                    <span className="text-white/40">Put this in the file: </span>
                    <code className="text-brand-300/90 break-all">{item.example}</code>
                  </p>
                )}
              </div>
            </div>
          </div>
        ))}

        {settled.map((item) => (
          <div key={item.id} className="flex items-center gap-2 flex-wrap px-1">
            <CheckCircle className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span className="text-xs text-white/50">{item.title}</span>
            {item.key && <code className="text-xs text-white/25">{item.key}</code>}
            {item.display && <span className="text-xs text-emerald-300/60 truncate">{item.display}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AdminDashboard() {
  const router = useRouter();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<
    "overview" | "kyc" | "reports" | "payouts" | "creators" | "coupons" | "earnings" | "payments" | "setup"
  >("overview");
  const [loading, setLoading] = useState(true);
  const [kycList, setKycList] = useState<KycItem[]>([]);
  const [reportList, setReportList] = useState<ReportItem[]>([]);
  const [payoutList, setPayoutList] = useState<PayoutItem[]>([]);
  const [creatorList, setCreatorList] = useState<CreatorItem[]>([]);
  const [couponList, setCouponList] = useState<CouponItem[]>([]);
  const [stats, setStats] = useState<OverviewData | null>(null);
  const [newCoupon, setNewCoupon] = useState({ code: "", type: "PERCENT", value: 10, maxUses: "", expiresInDays: "" });
  const [creatingCoupon, setCreatingCoupon] = useState(false);
  const [earnings, setEarnings] = useState<EarningsData | null>(null);
  const [releasing, setReleasing] = useState<string | null>(null);
  const [paymentList, setPaymentList] = useState<AdminPayment[]>([]);
  const [paymentSummary, setPaymentSummary] = useState<PaymentSummary | null>(null);
  const [paymentStatus, setPaymentStatus] = useState("PENDING");
  const [expiring, setExpiring] = useState<string | null>(null);
  // Force-expiring releases the customer's lock, so it asks for confirmation in
  // an in-app dialog instead of a native window.confirm.
  const [pendingExpire, setPendingExpire] = useState<AdminPayment | null>(null);
  // Resolving an investigation decides whether someone gets what they paid for,
  // so it goes through an in-app dialog with the consequence spelled out.
  const [pendingResolve, setPendingResolve] = useState<{
    payment: AdminPayment;
    outcome: "GRANT" | "MARK_UNPAID";
  } | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState<string | null>(null);
  const [resolveNote, setResolveNote] = useState("");
  // Reversing a charge the customer already paid: which leg of the refund we
  // move, why, and (for a network reversal) the HarakaPay reference.
  const [pendingRefund, setPendingRefund] = useState<AdminPayment | null>(null);
  const [refundDestination, setRefundDestination] = useState<"WALLET" | "GATEWAY">(
    "WALLET"
  );
  const [refundReason, setRefundReason] = useState("");
  const [refundGatewayRef, setRefundGatewayRef] = useState("");
  const [refunding, setRefunding] = useState<string | null>(null);
  const [system, setSystem] = useState<SystemReadiness | null>(null);
  const [systemBusy, setSystemBusy] = useState(false);
  const [jobs, setJobs] = useState<CronHealth | null>(null);
  const [jobsBusy, setJobsBusy] = useState(false);
  // Starting a worker by hand: which one is running, which one is waiting for
  // the operator to confirm that it may charge a customer's phone, and what the
  // last manual run came back with.
  const [runBusy, setRunBusy] = useState<string | null>(null);
  const [runConfirm, setRunConfirm] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<{
    worker: string;
    tone: "ok" | "error";
    text: string;
  } | null>(null);
  const [setup, setSetup] = useState<SetupReport | null>(null);
  const [setupBusy, setSetupBusy] = useState(false);
  const [pipeline, setPipeline] = useState<PipelineTest | null>(null);
  const [pipelineBusy, setPipelineBusy] = useState(false);
  // Native window.prompt is blocked in some embedded browsers, so the flows that
  // need a typed reason (ban, KYC / payout rejection) use this in-app dialog.
  const [reasonDialog, setReasonDialog] = useState<{
    title: string;
    label: string;
    placeholder: string;
    confirmLabel: string;
    tone: "danger" | "brand";
    onConfirm: (value: string) => void;
  } | null>(null);
  const [reasonValue, setReasonValue] = useState("");

  function askReason(
    cfg: Omit<NonNullable<typeof reasonDialog>, "onConfirm"> & {
      onConfirm: (value: string) => void;
    }
  ) {
    setReasonValue("");
    setReasonDialog(cfg);
  }

  // Only depends on the router, so it is stable across renders and can be a
  // real dependency of the callers below.
  const checkAdmin = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me");

      // Two different situations that used to share one destination. Nobody
      // signed in can be helped by the home page — they need the sign-in form,
      // and they need to come back here afterwards, which is what the middleware
      // writes into `?redirect=`. Somebody signed in as a non-admin is not
      // missing a session at all; the dashboard is simply not theirs.
      if (res.status === 401) {
        router.push("/login?redirect=%2Fadmin");
        return;
      }

      const data = await res.json();
      if (!data.success || data.data?.role !== "ADMIN") {
        router.push("/");
        return;
      }
    } catch {
      router.push("/login?redirect=%2Fadmin");
    } finally {
      setLoading(false);
    }
  }, [router]);

  // One place to notice that this tab is no longer an admin session.
  //
  // Found in production: a tab opened as an admin keeps calling these endpoints
  // after the session has moved on — a second tab signed in as somebody else, a
  // token that expired, an admin who was demoted. Each call was answered 401/403
  // and reported as its own toast, so the page looked usable and failed on every
  // click: twelve 403s in a minute from one tab, and the person clicking had no
  // way to tell that the fix was to sign in again.
  const sessionLostAt = useRef(0);
  const adminFetch = useCallback(
    async (input: string, init?: RequestInit): Promise<Response> => {
      const res = await fetch(input, init);
      if (res.status !== 401 && res.status !== 403) return res;

      // A burst of failing calls is one lost session, not twelve: re-check at
      // most every few seconds, so a page that fires eight requests on mount
      // does not fire eight redirects.
      const now = Date.now();
      if (now - sessionLostAt.current > 3000) {
        sessionLostAt.current = now;
        toast(
          "warning",
          "Your admin session has ended. Sign in again to continue."
        );
        void checkAdmin();
      }

      // An answer the callers already know how to read. Every one of them is
      // `if (data.success) … else toast(data.error)`, so the explanation travels
      // through the path that exists instead of one invented for it — which is
      // why this returns a body rather than throwing.
      return new Response(
        JSON.stringify({
          success: false,
          code: "SESSION_LOST",
          error: "Your admin session has ended. Sign in again to continue.",
        }),
        { status: res.status, headers: { "content-type": "application/json" } }
      );
    },
    [checkAdmin, toast]
  );

  useEffect(() => {
    checkAdmin();
  }, [checkAdmin]);

  useEffect(() => {
    if (activeTab === "overview") {
      // Load stats + pending counts so tab badges populate too
      fetchOverview();
      fetchKyc();
      fetchReports();
      fetchPayouts();
      fetchPayments();
      fetchSystemReadiness();
      fetchJobs();
      // Cheap on purpose: reading config opens no connections, and this is what
      // populates the tab badge before anyone clicks it.
      fetchSetup();
    }
    if (activeTab === "setup" && !setup) fetchSetup();
    if (activeTab === "kyc") fetchKyc();
    if (activeTab === "reports") fetchReports();
    if (activeTab === "payouts") fetchPayouts();
    if (activeTab === "creators") fetchCreators();
    if (activeTab === "coupons") fetchCoupons();
    if (activeTab === "earnings") fetchEarnings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === "payments") fetchPayments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, paymentStatus]);

  async function fetchOverview() {
    try {
      const res = await adminFetch("/api/admin/overview");
      const data = await res.json();
      if (data.success) setStats(data.data);
    } catch {}
  }

  async function fetchSystemReadiness() {
    setSystemBusy(true);
    try {
      const [healthRes, payRes, launchRes] = await Promise.all([
        fetch("/api/health"),
        fetch("/api/payments/health"),
        // The launch gate. Read-only and network-free, so it costs nothing to
        // ask alongside the other two rather than behind a button.
        adminFetch("/api/admin/launch-readiness"),
      ]);
      const health = await healthRes.json().catch(() => null);
      const pay = await payRes.json().catch(() => null);
      const launch = await launchRes.json().catch(() => null);

      const checks: SystemReadiness["checks"] = [];
      if (pay?.data?.checks) {
        for (const [key, value] of Object.entries(
          pay.data.checks as Record<string, { ok: boolean; value?: string | number; hint?: string }>
        )) {
          checks.push({ key, ok: !!value?.ok, value: value?.value, hint: value?.hint });
        }
      }
      checks.push({
        key: "database",
        ok: health?.checks?.database === "up",
        value: health?.checks?.database,
      });
      checks.push({
        key: "videoHost",
        ok: health?.checks?.bunny === "configured",
        value: health?.checks?.bunny,
        hint: "Bunny Stream — uploads and signed playback need it",
      });
      checks.push({
        key: "email",
        ok: health?.checks?.email === "smtp",
        value: health?.checks?.email,
        hint: "console = emails only reach the server log",
      });
      checks.push({
        key: "sms",
        ok: health?.checks?.sms === "africastalking",
        value: health?.checks?.sms,
        hint: "console = password-reset SMS never arrives",
      });

      const balance = pay?.data?.balance;
      if (balance) {
        checks.push({
          key: "gatewayFloat",
          ok: Number(balance.float_balance ?? 0) > 0,
          value: `float ${balance.float_balance ?? 0} · wallet ${balance.wallet_balance ?? 0}`,
          hint: "With a zero float HarakaPay accepts the charge and never delivers the USSD prompt",
        });
      }

      const breaker = pay?.data?.gatewayBreaker;
      if (breaker) {
        checks.push({
          key: "gatewayBreaker",
          ok: !breaker.open,
          value: breaker.open
            ? `open · ${breaker.failures ?? 0} failure(s) in a row · ${breaker.skipped ?? 0} call(s) skipped`
            : "closed",
          hint: "Temporary circuit breaker: while open, gateway calls are skipped instead of hanging",
        });
      }

      setSystem({
        appUrl: pay?.data?.checks?.appUrl?.value,
        appUrlSource: pay?.data?.checks?.appUrl?.source,
        gateway: pay?.data?.gateway,
        readyForLive: pay?.data?.readyForLive,
        sandbox: pay?.data?.checks?.sandboxMode?.value === true,
        checks,
        topWarnings: [
          // First, because it is the one that makes every other gateway result
          // read wrong while it lasts.
          ...(pay?.data?.gatewayBreaker?.warning ? [pay.data.gatewayBreaker.warning] : []),
          ...(pay?.data?.floatWarning ? [pay.data.floatWarning] : []),
          ...(pay?.data?.delivery?.deliveryWarning ? [pay.data.delivery.deliveryWarning] : []),
          ...(health?.warnings || []),
        ],
        delivery: pay?.data?.delivery,
        gatewayBreaker: pay?.data?.gatewayBreaker,
        launch: launch?.data,
      });
    } catch {
      // Readiness is informational — never surface it as an error toast
    } finally {
      setSystemBusy(false);
    }
  }

  async function fetchJobs() {
    setJobsBusy(true);
    try {
      const res = await adminFetch("/api/admin/jobs");
      const data = await res.json();
      if (data.success) setJobs(data.data as CronHealth);
    } catch {
      // Informational, like readiness — never an error toast
    } finally {
      setJobsBusy(false);
    }
  }

  /**
   * Start one worker now.
   *
   * The success path refreshes the card from the response itself, so the row
   * shows the run that just happened rather than the state before it.
   */
  async function runWorker(workerId: string, confirm = false) {
    setRunBusy(workerId);
    setRunConfirm(null);
    try {
      const res = await adminFetch("/api/admin/jobs/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ worker: workerId, confirm }),
      });
      const data = await res.json();

      if (data.success) {
        setRunResult({
          worker: workerId,
          tone: "ok",
          text: `${data.message || "Ran."}${
            data.data?.durationMs != null ? ` · ${(data.data.durationMs / 1000).toFixed(1)}s` : ""
          }`,
        });
        if (data.data?.health) setJobs(data.data.health as CronHealth);
      } else {
        setRunResult({
          worker: workerId,
          tone: "error",
          text: data.error || "Could not run it.",
        });
        // A refusal or a failed run both leave the card out of date.
        fetchJobs();
      }
    } catch {
      setRunResult({ worker: workerId, tone: "error", text: "The request failed." });
    } finally {
      setRunBusy(null);
    }
  }

  async function fetchKyc() {
    try {
      const res = await adminFetch("/api/admin/kyc?status=PENDING");
      const data = await res.json();
      if (data.success) setKycList(data.data.kycs);
    } catch {}
  }

  async function fetchReports() {
    try {
      const res = await adminFetch("/api/admin/reports?status=PENDING");
      const data = await res.json();
      if (data.success) setReportList(data.data);
    } catch {}
  }

  async function fetchPayouts() {
    try {
      const res = await adminFetch("/api/admin/payouts?status=PENDING");
      const data = await res.json();
      if (data.success) setPayoutList(data.data.payouts);
    } catch {}
  }

  async function fetchCreators() {
    try {
      const res = await adminFetch("/api/admin/users?role=CREATOR");
      const data = await res.json();
      if (data.success) setCreatorList(data.data.users);
    } catch {}
  }

  async function fetchCoupons() {
    try {
      const res = await adminFetch("/api/admin/coupons");
      const data = await res.json();
      if (data.success) setCouponList(data.data.coupons);
    } catch {}
  }

  async function createCoupon() {
    if (!newCoupon.code.trim() || creatingCoupon) return;
    setCreatingCoupon(true);
    try {
      const res = await adminFetch("/api/admin/coupons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: newCoupon.code.trim(),
          type: newCoupon.type,
          value: parseInt(String(newCoupon.value)) || 0,
          maxUses: newCoupon.maxUses ? parseInt(newCoupon.maxUses) : undefined,
          expiresInDays: newCoupon.expiresInDays ? parseInt(newCoupon.expiresInDays) : undefined,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setNewCoupon({ code: "", type: "PERCENT", value: 10, maxUses: "", expiresInDays: "" });
        fetchCoupons();
      } else {
        toast("error", data.error || "Something went wrong");
      }
    } catch {
      toast("error", "An error occurred");
    } finally {
      setCreatingCoupon(false);
    }
  }

  async function toggleCoupon(id: string) {
    try {
      const res = await adminFetch(`/api/admin/coupons?id=${id}`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) fetchCoupons();
      else toast("error", data.error || "Something went wrong");
    } catch {
      toast("error", "An error occurred");
    }
  }

  async function submitCreatorAction(
    userId: string,
    action: "VERIFY" | "UNVERIFY" | "BAN" | "UNBAN",
    reason?: string
  ) {
    try {
      const res = await adminFetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reason ? { userId, action, reason } : { userId, action }),
      });
      const data = await res.json();
      if (data.success) fetchCreators();
      else toast("error", data.error || "Something went wrong");
    } catch {
      toast("error", "An error occurred");
    }
  }

  function handleCreatorAction(userId: string, action: "VERIFY" | "UNVERIFY" | "BAN" | "UNBAN") {
    if (action === "BAN") {
      askReason({
        title: "Ban this creator",
        label: "Reason (shared with the creator)",
        placeholder: "e.g. Repeated copyright violations",
        confirmLabel: "Ban creator",
        tone: "danger",
        onConfirm: (reason) => submitCreatorAction(userId, action, reason),
      });
      return;
    }
    submitCreatorAction(userId, action);
  }

  async function handleKycReview(kycId: string, status: "APPROVED" | "REJECTED", reason?: string) {
    try {
      const res = await adminFetch("/api/admin/kyc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kycId, status, rejectionReason: reason }),
      });
      const data = await res.json();
      if (data.success) {
        fetchKyc();
      } else {
        toast("error", data.error || "Something went wrong");
      }
    } catch {
      toast("error", "An error occurred");
    }
  }

  async function handleReportAction(reportId: string, action: string, reason: string) {
    try {
      const res = await adminFetch("/api/admin/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportId, action, reason }),
      });
      const data = await res.json();
      if (data.success) {
        fetchReports();
      } else {
        toast("error", data.error || "Something went wrong");
      }
    } catch {
      toast("error", "An error occurred");
    }
  }

  async function handlePayoutAction(payoutId: string, action: string, note?: string) {
    try {
      const res = await adminFetch("/api/admin/payouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payoutId, action, adminNote: note }),
      });
      const data = await res.json();
      if (data.success) {
        fetchPayouts();
      } else {
        toast("error", data.error || "Something went wrong");
      }
    } catch {
      toast("error", "An error occurred");
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

  async function fetchEarnings() {
    try {
      const res = await adminFetch("/api/admin/earnings");
      const data = await res.json();
      if (data.success) setEarnings(data.data);
    } catch {}
  }

  async function handleRelease(creatorId: string | "all") {
    if (releasing) return;
    setReleasing(creatorId);
    try {
      const res = await adminFetch("/api/admin/earnings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(creatorId === "all" ? {} : { creatorId }),
      });
      const data = await res.json();
      if (data.success) {
        toast("success", data.message || "Release complete");
        fetchEarnings();
      } else {
        toast("error", data.error || "Something went wrong");
      }
    } catch {
      toast("error", "An error occurred");
    } finally {
      setReleasing(null);
    }
  }

  async function fetchPayments() {
    try {
      const res = await adminFetch(`/api/admin/payments?status=${paymentStatus}`);
      const data = await res.json();
      if (data.success) {
        setPaymentList(data.data.transactions || []);
        setPaymentSummary(data.data.summary || null);
      }
    } catch {}
  }

  async function paymentAction(
    payment: AdminPayment,
    action: "expire" | "recheck" | "grant" | "mark_unpaid",
    note?: string
  ) {
    const res = await adminFetch("/api/admin/payments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, transactionId: payment.id, ...(note ? { note } : {}) }),
    });
    const data = await res.json();
    if (data.success) {
      // A re-check that changed nothing is information, not a success — and a
      // gateway we could not reach at all is a warning, because that is exactly
      // what an unfunded/inactive merchant account looks like.
      const tone = data.data?.gatewayError
        ? "error"
        : action === "recheck" && data.data?.settled === false
          ? "info"
          : "success";
      toast(tone, data.data?.message || "Done");
      fetchPayments();
      return true;
    }
    toast("error", data.error || "That action could not be completed");
    return false;
  }

  async function expireCharge(payment: AdminPayment) {
    setPendingExpire(null);
    setExpiring(payment.id);
    try {
      await paymentAction(payment, "expire");
    } catch {
      toast("error", "An error occurred");
    } finally {
      setExpiring(null);
    }
  }

  async function recheckCharge(payment: AdminPayment) {
    setRechecking(payment.id);
    try {
      await paymentAction(payment, "recheck");
    } catch {
      toast("error", "An error occurred");
    } finally {
      setRechecking(null);
    }
  }

  async function resolveCharge(
    payment: AdminPayment,
    outcome: "GRANT" | "MARK_UNPAID",
    note?: string
  ) {
    setPendingResolve(null);
    setResolving(payment.id);
    try {
      await paymentAction(payment, outcome === "GRANT" ? "grant" : "mark_unpaid", note);
    } catch {
      toast("error", "An error occurred");
    } finally {
      setResolving(null);
    }
  }

  // The refund carries more than a reason: it also decides WHERE the money goes.
  // WALLET is ours to do; GATEWAY is the operator's dashboard work, and the
  // reference is the only evidence it happened.
  async function issueRefund(payment: AdminPayment) {
    setPendingRefund(null);
    setRefunding(payment.id);
    try {
      const res = await adminFetch("/api/admin/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "refund",
          transactionId: payment.id,
          destination: refundDestination,
          reason: refundReason.trim() || undefined,
          gatewayRef: refundDestination === "GATEWAY" ? refundGatewayRef.trim() : undefined,
        }),
      });
      const data = await res.json();

      if (data.success) {
        toast("success", data.data?.message || "Charge reversed");
        setRefundReason("");
        setRefundGatewayRef("");
        setRefundDestination("WALLET");
        fetchPayments();
      } else {
        toast("error", data.error || "Could not reverse this charge");
      }
    } catch {
      toast("error", "An error occurred");
    } finally {
      setRefunding(null);
    }
  }

  async function fetchSetup(runProbes = false) {
    setSetupBusy(true);
    try {
      // POST runs the live probes as well; GET only reads configuration.
      const res = await adminFetch("/api/admin/setup", { method: runProbes ? "POST" : "GET" });
      const data = await res.json();
      if (data.success) {
        setSetup(data.data);
      } else {
        toast("error", data.error || "Could not load the setup checklist");
      }
    } catch {
      toast("error", "Could not load the setup checklist");
    } finally {
      setSetupBusy(false);
    }
  }

  /**
   * Drive the real upload path end to end. Slow enough that the button shows
   * progress, and honest about the difference between "the key works" and
   * "the file survived".
   */
  async function runPipelineTest() {
    setPipelineBusy(true);
    setPipeline(null);
    try {
      const res = await adminFetch("/api/admin/bunny-self-test", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setPipeline(data.data as PipelineTest);
      } else {
        toast("error", data.error || "The pipeline test could not run");
      }
    } catch {
      toast("error", "Network error while testing the pipeline");
    } finally {
      setPipelineBusy(false);
    }
  }

  const tabs = [
    { id: "overview" as const, label: "Overview", icon: BarChart3 },
    { id: "kyc" as const, label: "KYC", icon: Shield, badge: kycList.length },
    { id: "reports" as const, label: "Reports", icon: AlertTriangle, badge: reportList.length },
    { id: "payouts" as const, label: "Payouts", icon: DollarSign, badge: payoutList.length },
    { id: "creators" as const, label: "Creators", icon: BadgeCheck },
    { id: "coupons" as const, label: "Coupons", icon: Ticket },
    { id: "earnings" as const, label: "Earnings", icon: Wallet },
    {
      id: "payments" as const,
      label: "Payments",
      icon: CreditCard,
      // Investigations come first: that badge means real customers who may have
      // been charged for something they never received.
      badge: (paymentSummary?.investigating || 0) + (paymentSummary?.stuck || 0),
    },
    {
      id: "setup" as const,
      label: "Setup",
      icon: Rocket,
      badge: setup?.summary.todo,
    },
  ];

  return (
    <div className="min-h-screen page-enter">
      <Header />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-display font-bold flex items-center gap-3">
            <Shield className="w-7 h-7 text-brand-400" />
            Admin Panel
          </h1>
          <p className="text-white/50 text-sm mt-1">Genhub platform management</p>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 overflow-x-auto pb-4 mb-6">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium whitespace-nowrap transition ${
                activeTab === tab.id
                  ? "bg-brand-500 text-white shadow-lg shadow-brand-500/25"
                  : "bg-surface-400/60 text-white/60 hover:text-white hover:bg-surface-400"
              }`}
            >
              <tab.icon className="w-4 h-4" />
              {tab.label}
              {tab.badge != null && tab.badge > 0 && (
                <span className="bg-red-500 text-white text-xs w-5 h-5 rounded-full flex items-center justify-center">
                  {tab.badge}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Overview Tab */}
        {activeTab === "overview" && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="glass-card p-5">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-xl bg-brand-500/20 flex items-center justify-center">
                    <Users className="w-5 h-5 text-brand-400" />
                  </div>
                  <span className="text-sm text-white/60">Total Users</span>
                </div>
                <p className="text-2xl font-bold">{stats ? stats.users.total.toLocaleString() : "…"}</p>
                <p className="text-xs text-white/40 mt-1">
                  {stats
                    ? `${stats.users.creators} creators · ${stats.users.viewers} viewers · ${stats.users.banned} banned`
                    : "Loading…"}
                </p>
              </div>
              <div className="glass-card p-5">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-xl bg-emerald-500/20 flex items-center justify-center">
                    <DollarSign className="w-5 h-5 text-emerald-400" />
                  </div>
                  <span className="text-sm text-white/60">Platform Revenue (30%)</span>
                </div>
                <p className="text-2xl font-bold text-emerald-400">
                  {stats ? `TZS ${stats.overview.platformRevenue.toLocaleString()}` : "…"}
                </p>
                <p className="text-xs text-white/40 mt-1">
                  {stats ? `Creators earned TZS ${stats.overview.creatorEarnings.toLocaleString()}` : "Loading…"}
                </p>
              </div>
              <div className="glass-card p-5">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-500/20 flex items-center justify-center">
                    <Clock className="w-5 h-5 text-amber-400" />
                  </div>
                  <span className="text-sm text-white/60">Pending KYC</span>
                </div>
                <p className="text-2xl font-bold text-amber-400">
                  {stats ? stats.kyc.pending : kycList.length || "…"}
                </p>
              </div>
              <div className="glass-card p-5">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-xl bg-red-500/20 flex items-center justify-center">
                    <AlertTriangle className="w-5 h-5 text-red-400" />
                  </div>
                  <span className="text-sm text-white/60">New Reports</span>
                </div>
                <p className="text-2xl font-bold text-red-400">{reportList.length || 0}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="glass-card p-5 text-center">
                <Activity className="w-6 h-6 text-brand-400 mx-auto mb-2" />
                <p className="text-sm text-white/60">Total Views</p>
                <p className="text-lg font-bold mt-1">
                  {stats ? stats.engagement.totalViews.toLocaleString() : "…"}
                </p>
                <p className="text-xs text-white/40 mt-1">
                  {stats ? `${stats.engagement.activeSubscriptions} active subscriptions` : ""}
                </p>
              </div>
              <div className="glass-card p-5 text-center">
                <HardDrive className="w-6 h-6 text-purple-400 mx-auto mb-2" />
                <p className="text-sm text-white/60">Published Videos</p>
                <p className="text-lg font-bold mt-1">
                  {stats ? `${stats.videos.published} / ${stats.videos.total}` : "…"}
                </p>
                <p className="text-xs text-white/40 mt-1">
                  {stats && stats.videos.flagged > 0 ? `${stats.videos.flagged} flagged` : "No flagged videos"}
                </p>
              </div>
              <div className="glass-card p-5 text-center">
                <TrendingUp className="w-6 h-6 text-emerald-400 mx-auto mb-2" />
                <p className="text-sm text-white/60">Gross Volume</p>
                <p className="text-lg font-bold mt-1">
                  {stats ? `TZS ${stats.transactions.totalAmount.toLocaleString()}` : "…"}
                </p>
                <p className="text-xs text-white/40 mt-1">
                  {stats ? `${stats.transactions.total} transactions · ${stats.transactions.todayAmount.toLocaleString()} TZS today` : ""}
                </p>
              </div>
            </div>

            {/* System readiness — the parts of "is this live for real?" that
                no amount of application code can fix on its own. */}
            <div className="glass-card p-5">
              <div className="flex items-center justify-between gap-3 mb-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-blue-500/20 flex items-center justify-center">
                    <Activity className="w-5 h-5 text-blue-400" />
                  </div>
                  <div>
                    <h3 className="font-display font-bold">System readiness</h3>
                    <p className="text-xs text-white/50">
                      {system?.sandbox
                        ? "Payments are in SANDBOX — no USSD push, no real money"
                        : "Live configuration as the server sees it"}
                    </p>
                  </div>
                </div>
                <button
                  onClick={fetchSystemReadiness}
                  disabled={systemBusy}
                  className="btn-ghost text-sm flex items-center gap-1.5 disabled:opacity-50"
                >
                  {systemBusy ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <RefreshCcw className="w-4 h-4" />
                  )}
                  Re-check
                </button>
              </div>

              {/* The verdict first. An operator glancing at this card should
                  learn whether the site can face real users before reading a
                  single check — and every line in it is a hard stop, not a
                  preference, which is what separates it from the warnings
                  further down. */}
              {system?.launch && (
                <div
                  className={`mb-4 rounded-xl border px-3 py-2.5 ${
                    system.launch.ready
                      ? "border-emerald-500/20 bg-emerald-500/5"
                      : "border-red-500/25 bg-red-500/5"
                  }`}
                >
                  <p
                    className={`text-sm font-semibold flex items-center gap-2 ${
                      system.launch.ready ? "text-emerald-300" : "text-red-300"
                    }`}
                  >
                    {system.launch.ready ? (
                      <CheckCircle className="w-4 h-4" />
                    ) : (
                      <XCircle className="w-4 h-4" />
                    )}
                    {system.launch.ready
                      ? "Launch-ready — nothing blocking"
                      : `${system.launch.blockers.length} blocker(s) before real users`}
                  </p>
                  {!system.launch.ready && (
                    <ul className="mt-2 space-y-1.5">
                      {system.launch.blockers.map((b) => (
                        <li key={b.id} className="text-xs text-white/70">
                          <span className="text-red-300/90">{b.label}</span>
                          <span className="text-white/40"> · {b.fix}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {/* Says where the value comes from, because the fix lines
                      above name variables and nothing else would tell the
                      reader that SETUP.md is the answer. */}
                  <p className="text-xs text-white/40 mt-2">
                    The same list <code>npm run preflight:prod</code> prints, read from this
                    deployment&apos;s own environment.
                  </p>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {(system?.checks || []).map((c) => (
                  <div
                    key={c.key}
                    className="flex items-start gap-2 rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2"
                    title={c.hint}
                  >
                    {c.ok ? (
                      <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                    ) : (
                      <XCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-medium capitalize">
                        {c.key.replace(/([A-Z])/g, " $1").toLowerCase()}
                      </p>
                      {c.value !== undefined && (
                        <p className="text-xs text-white/50 truncate">{String(c.value)}</p>
                      )}
                      {c.hint && (
                        <p className="text-xs text-white/40 mt-0.5">{c.hint}</p>
                      )}
                    </div>
                  </div>
                ))}
                {!system && (
                  <p className="text-sm text-white/50">
                    {systemBusy ? "Checking…" : "Readiness not loaded."}
                  </p>
                )}
              </div>

              {!!system?.topWarnings.length && (
                <div className="mt-4 space-y-2">
                  {system.topWarnings.map((w, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2"
                    >
                      <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                      <p className="text-xs text-amber-200/90">{w}</p>
                    </div>
                  ))}
                </div>
              )}

              <p className="text-xs text-white/40 mt-4">
                App URL: {system?.appUrl || "—"}
                {system?.appUrlSource ? ` (from ${system.appUrlSource})` : ""} · Gateway:{" "}
                {system?.gateway || "—"} · Run <code>npm run preflight:prod</code> for the full
                launch gate.
              </p>
            </div>

            {/* Background jobs — a schedule that stops firing produces no
                request, no log line and no error, so nothing else in the app
                can report it. Each worker stamps a heartbeat as it runs. */}
            <div className="glass-card p-5">
              <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
                <div className="flex items-center gap-3">
                  <div
                    className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                      jobs?.degraded ? "bg-red-500/20" : "bg-brand-500/20"
                    }`}
                  >
                    <Clock
                      className={`w-5 h-5 ${jobs?.degraded ? "text-red-400" : "text-brand-400"}`}
                    />
                  </div>
                  <div>
                    <h3 className="font-display font-bold">Background jobs</h3>
                    <p className="text-xs text-white/50">
                      {!jobs
                        ? jobsBusy
                          ? "Checking…"
                          : "Not loaded."
                        : jobs.needsAttention.length > 0
                          ? // Naming them here, not only counting them: the question
                            // this card answers is "which one stopped, and since
                            // when", and a count alone sends the reader hunting
                            // through four rows for the answer.
                            `${jobs.needsAttention.length} of ${jobs.workers.length} need attention — ${jobs.attentionSummary}`
                          : jobs.counts.never === jobs.workers.length
                            ? "No scheduler is calling these yet"
                            : "All four workers are within their cadence"}
                    </p>
                  </div>
                </div>
                <button
                  onClick={fetchJobs}
                  disabled={jobsBusy}
                  className="btn-ghost text-sm flex items-center gap-1.5 disabled:opacity-50"
                >
                  {jobsBusy ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <RefreshCcw className="w-4 h-4" />
                  )}
                  Re-check
                </button>
              </div>

              <div className="space-y-2">
                {/* One column, not detail-left / result-right: on a phone-width
                    admin panel that split squeezed the result into a narrow
                    ribbon and wrapped the worker name onto three lines. */}
                {(jobs ? orderForAttention(jobs) : []).map((w) => (
                  <div
                    key={w.id}
                    className="rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2"
                  >
                    <div className="flex items-start gap-2">
                    <JobStateIcon state={w.state} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">
                        {w.name}{" "}
                        <span className="text-xs text-white/40 font-normal">
                          · every {w.everyMinutes} min
                        </span>
                      </p>
                      <p className="text-xs text-white/50 break-words">{w.detail}</p>
                      {/* The absolute moment, next to the age the detail already
                          gives: an age cannot be held against a deploy, a log or
                          "it was working when I left", and that comparison is
                          what an operator actually does next. */}
                      {JOB_STATE_ALERTS.includes(w.state) && w.silentSince && (
                        <p className="text-xs text-white/40 break-words mt-0.5">
                          Last activity {new Date(w.silentSince).toLocaleString("en-US")}
                        </p>
                      )}
                      {w.lastSummary && (
                        <p className="text-xs text-white/60 break-words mt-0.5">
                          Last result: {w.lastSummary}
                        </p>
                      )}
                      {(w.state === "late" || w.state === "never" || w.state === "stalled") && (
                        <p className="text-xs text-white/35 mt-0.5 break-words">
                          While it is not running: {w.consequence}
                        </p>
                      )}
                      <p className="text-xs text-white/30 mt-1">
                        <span
                          className={
                            JOB_STATE_ALERTS.includes(w.state)
                              ? "text-amber-400/70"
                              : w.state === "never"
                                ? "text-white/40"
                                : "text-emerald-400/70"
                          }
                        >
                          {JOB_STATE_LABEL[w.state]}
                        </span>
                        {w.runsTotal > 0 && ` · ${w.runsTotal} run(s) recorded`}
                        {w.lastDurationMs != null && ` · took ${(w.lastDurationMs / 1000).toFixed(1)}s`}
                        {w.consecutiveFailures > 0 &&
                          ` · ${w.consecutiveFailures} consecutive failure(s)`}
                      </p>
                    </div>
                    {/* Runs the real job through the same lock and heartbeat as
                        the schedule, so a green result here means the schedule
                        will work too — not that a simulation did. */}
                    <button
                      onClick={() =>
                        w.sendsCustomerRequests ? setRunConfirm(w.id) : runWorker(w.id)
                      }
                      disabled={runBusy === w.id}
                      title="Run this worker now — it makes the same changes a scheduled run would"
                      className="btn-ghost text-xs flex items-center gap-1 shrink-0 disabled:opacity-50"
                    >
                      {runBusy === w.id ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Play className="w-3.5 h-3.5" />
                      )}
                      Run now
                    </button>
                    </div>

                    {runConfirm === w.id && (
                      <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2">
                        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                        <p className="text-xs text-amber-200/80 flex-1 min-w-[12rem]">
                          This is the one worker that can charge someone who did not ask: when a
                          wallet cannot cover a renewal it sends a USSD prompt to that fan&apos;s
                          phone. Running it can charge real renewals that are already due.
                        </p>
                        <button onClick={() => runWorker(w.id, true)} className="btn-brand text-xs">
                          Run it anyway
                        </button>
                        <button onClick={() => setRunConfirm(null)} className="btn-ghost text-xs">
                          Cancel
                        </button>
                      </div>
                    )}

                    {runResult?.worker === w.id && (
                      <p
                        className={`text-xs mt-1.5 break-words ${
                          runResult.tone === "ok" ? "text-emerald-400" : "text-red-400"
                        }`}
                      >
                        {runResult.tone === "ok" ? "Ran now: " : "Could not run it: "}
                        {runResult.text}
                      </p>
                    )}
                  </div>
                ))}
                {!jobs && (
                  <p className="text-sm text-white/50">
                    {jobsBusy ? "Reading heartbeats…" : "Heartbeats not loaded."}
                  </p>
                )}
              </div>

              {jobs && jobs.counts.never > 0 && (
                <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2">
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-200/80">
                    {jobs.counts.never === jobs.workers.length
                      ? "No worker has ever run. Nothing is scheduling them yet — either the cron block is not deployed or the GitHub Actions workflow has no APP_URL and CRON_SECRET configured. See PRODUCTION.md §4.0.1. Run any of them now to check the job itself works while you fix the schedule."
                      : `${jobs.counts.never} worker(s) have never run. Check their schedules in PRODUCTION.md §4.0.1, or run them now to prove the job itself works.`}
                  </p>
                </div>
              )}

              {jobs && (
                <p className="text-xs text-white/40 mt-4">
                  Checked as of {new Date(jobs.checkedAt).toLocaleTimeString()}. Each worker counts
                  as overdue after roughly four of its own intervals of silence, so one late run
                  does not raise an alarm; a run still open well past its usual runtime counts as
                  killed. Both thresholds are listed against the worker itself in{" "}
                  <code className="text-white/50">cron-heartbeat.service.ts</code>. Run now
                  starts the real job — the same code, the same lock and the same heartbeat as the
                  schedule — so a green result here means the schedule will work too. A worker
                  that is already running is refused rather than started twice, and anything
                  started here is recorded as a manual run.
                </p>
              )}
            </div>

            {/* Top creators */}
            {stats && stats.topCreators.length > 0 && (
              <div className="glass-card p-5">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-xl bg-brand-500/20 flex items-center justify-center">
                    <TrendingUp className="w-5 h-5 text-brand-400" />
                  </div>
                  <span className="text-sm text-white/60">Top Creators by Earnings</span>
                </div>
                <div className="space-y-3">
                  {stats.topCreators.map((creator, index) => (
                    <div
                      key={creator.id}
                      className="flex items-center justify-between gap-3 text-sm"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="w-6 h-6 rounded-lg bg-surface-400 flex items-center justify-center text-xs font-bold text-white/60 shrink-0">
                          {index + 1}
                        </span>
                        <span className="truncate">
                          {creator.displayName || "Creator"}
                          {creator.strikes > 0 && (
                            <span className="text-red-400 text-xs ml-2">
                              {creator.strikes} strike{creator.strikes > 1 ? "s" : ""}
                            </span>
                          )}
                        </span>
                      </div>
                      <div className="text-right shrink-0">
                        <span className="font-medium text-emerald-400">
                          TZS {creator.totalEarned.toLocaleString()}
                        </span>
                        <span className="block text-xs text-white/40">
                          {creator.availableBalance.toLocaleString()} available
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* KYC Tab */}
        {activeTab === "kyc" && (
          <div className="space-y-4">
            <h2 className="font-display font-bold">KYC Queue</h2>
            {kycList.length === 0 ? (
              <div className="glass-card p-12 text-center">
                <CheckCircle className="w-12 h-12 text-emerald-400/30 mx-auto mb-3" />
                <p className="text-white/50">No pending KYC submissions</p>
              </div>
            ) : (
              <div className="grid gap-4">
                {kycList.map((kyc) => (
                  <div key={kyc.id} className="glass-card p-5">
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                      <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-full bg-brand-500/20 flex items-center justify-center text-brand-400 font-bold">
                          {kyc.user.displayName?.[0] || "U"}
                        </div>
                        <div>
                          <p className="font-medium">{kyc.user.displayName || "Unknown"}</p>
                          <p className="text-xs text-white/50">{kyc.user.email || kyc.user.phone}</p>
                          <p className="text-xs text-white/40">
                            ID: {kyc.idDocumentType || "Unknown"} • Submitted:{" "}
                            {new Date(kyc.createdAt).toLocaleDateString("en-US")}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <a
                          href={kyc.idDocumentUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="btn-ghost text-xs flex items-center gap-1"
                        >
                          <FileText className="w-3 h-3" /> ID Document
                        </a>
                        <a
                          href={kyc.selfieUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="btn-ghost text-xs flex items-center gap-1"
                        >
                          <Eye className="w-3 h-3" /> Selfie
                        </a>
                        <button
                          onClick={() => handleKycReview(kyc.id, "APPROVED")}
                          className="bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 px-3 py-1.5 rounded-lg text-xs font-medium transition"
                        >
                          <CheckCircle className="w-3 h-3 inline mr-1" /> Approve
                        </button>
                        <button
                          onClick={() =>
                            askReason({
                              title: "Reject this KYC submission",
                              label: "Reason (shared with the creator)",
                              placeholder: "e.g. Selfie does not match the ID document",
                              confirmLabel: "Reject",
                              tone: "danger",
                              onConfirm: (reason) =>
                                handleKycReview(kyc.id, "REJECTED", reason),
                            })
                          }
                          className="bg-red-500/20 text-red-400 hover:bg-red-500/30 px-3 py-1.5 rounded-lg text-xs font-medium transition"
                        >
                          <XCircle className="w-3 h-3 inline mr-1" /> Reject
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Reports Tab */}
        {activeTab === "reports" && (
          <div className="space-y-4">
            <h2 className="font-display font-bold">Video Reports</h2>
            {reportList.length === 0 ? (
              <div className="glass-card p-12 text-center">
                <CheckCircle className="w-12 h-12 text-emerald-400/30 mx-auto mb-3" />
                <p className="text-white/50">No new reports</p>
              </div>
            ) : (
              <div className="grid gap-4">
                {reportList.map((report) => (
                  <div key={report.id} className="glass-card p-5">
                    <div className="flex flex-col gap-3">
                      <div className="flex items-start justify-between">
                        <div>
                          <p className="font-medium">{report.video.title}</p>
                          <p className="text-xs text-white/50 mt-1">
                            Creator: {report.video.creator.displayName} • Strikes: {report.video.creator.strikes}/3
                          </p>
                        </div>
                        <span className="badge-warning">{report.reason}</span>
                      </div>

                      {report.description && (
                        <p className="text-sm text-white/60 bg-surface-300/40 rounded-lg p-3">
                          {report.description}
                        </p>
                      )}

                      <div className="flex items-center gap-2 flex-wrap">
                        <button
                          onClick={() => handleReportAction(report.id, "HIDDEN", "Video hidden due to report")}
                          className="bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 px-3 py-1.5 rounded-lg text-xs font-medium transition"
                        >
                          Hide Video
                        </button>
                        <button
                          onClick={() => handleReportAction(report.id, "FROZEN_EARNINGS", "Earnings frozen due to report")}
                          className="bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 px-3 py-1.5 rounded-lg text-xs font-medium transition"
                        >
                          Freeze Earnings
                        </button>
                        <button
                          onClick={() => handleReportAction(report.id, "WARNING", "Warning issued to creator")}
                          className="bg-orange-500/20 text-orange-400 hover:bg-orange-500/30 px-3 py-1.5 rounded-lg text-xs font-medium transition"
                        >
                          Warning
                        </button>
                        <button
                          onClick={() => handleReportAction(report.id, "BANNED", "Account banned due to report")}
                          className="bg-red-500/20 text-red-400 hover:bg-red-500/30 px-3 py-1.5 rounded-lg text-xs font-medium transition"
                        >
                          <Ban className="w-3 h-3 inline mr-1" /> Ban
                        </button>
                        <button
                          onClick={() => handleReportAction(report.id, "DISMISSED", "Report dismissed")}
                          className="btn-ghost text-xs"
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Payouts Tab */}
        {activeTab === "payouts" && (
          <div className="space-y-4">
            <h2 className="font-display font-bold">Payout Requests</h2>
            {payoutList.length === 0 ? (
              <div className="glass-card p-12 text-center">
                <CheckCircle className="w-12 h-12 text-emerald-400/30 mx-auto mb-3" />
                <p className="text-white/50">No pending payout requests</p>
              </div>
            ) : (
              <div className="grid gap-4">
                {payoutList.map((payout) => (
                  <div key={payout.id} className="glass-card p-5">
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                      <div>
                        <p className="font-medium">
                          {payout.creator.displayName || "Creator"} — TZS {payout.amount.toLocaleString()}
                        </p>
                        <p className="text-xs text-white/50 mt-1">
                          Method: {payout.paymentMethod} • Account: {payout.accountDetails}
                        </p>
                        <p className="text-xs text-white/40">
                          Requested: {new Date(payout.createdAt).toLocaleDateString("en-US")}
                        </p>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handlePayoutAction(payout.id, "APPROVED", "Approved")}
                          className="bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 px-3 py-1.5 rounded-lg text-xs font-medium transition"
                        >
                          <CheckCircle className="w-3 h-3 inline mr-1" /> Approve
                        </button>
                        <button
                          onClick={() => handlePayoutAction(payout.id, "PAID", "Paid")}
                          className="bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 px-3 py-1.5 rounded-lg text-xs font-medium transition"
                        >
                          Mark Paid
                        </button>
                        <button
                          onClick={() =>
                            askReason({
                              title: "Reject this payout",
                              label: "Reason (shared with the creator)",
                              placeholder: "e.g. Payout details are incorrect",
                              confirmLabel: "Reject",
                              tone: "danger",
                              onConfirm: (reason) =>
                                handlePayoutAction(payout.id, "REJECTED", reason),
                            })
                          }
                          className="bg-red-500/20 text-red-400 hover:bg-red-500/30 px-3 py-1.5 rounded-lg text-xs font-medium transition"
                        >
                          <XCircle className="w-3 h-3 inline mr-1" /> Reject
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {/* Creators Tab — verified badge management */}
        {activeTab === "creators" && (
          <div className="space-y-4">
            <h2 className="font-display font-bold">Creators</h2>
            {creatorList.length === 0 ? (
              <div className="glass-card p-12 text-center">
                <Users className="w-12 h-12 text-brand-400/30 mx-auto mb-3" />
                <p className="text-white/50">No creators found</p>
              </div>
            ) : (
              <div className="grid gap-4">
                {creatorList.map((creator) => (
                  <div key={creator.id} className="glass-card p-5">
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                      <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-full bg-brand-500/20 flex items-center justify-center text-brand-400 font-bold">
                          {creator.displayName?.[0] || "C"}
                        </div>
                        <div>
                          <p className="font-medium flex items-center gap-2">
                            {creator.displayName || "Unknown"}
                            {creator.isVerified && (
                              <BadgeCheck className="w-4 h-4 text-brand-400" />
                            )}
                            {creator.isBanned && (
                              <span className="bg-red-500/20 text-red-400 text-[10px] font-bold px-1.5 py-0.5 rounded">
                                BANNED
                              </span>
                            )}
                          </p>
                          <p className="text-xs text-white/50">{creator.email || creator.phone}</p>
                          <p className="text-xs text-white/40">
                            KYC: {creator.kycStatus} • Videos: {creator._count.videos} • Strikes: {creator.strikes}/3 • Joined:{" "}
                            {new Date(creator.createdAt).toLocaleDateString("en-US")}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {creator.isVerified ? (
                          <button
                            onClick={() => handleCreatorAction(creator.id, "UNVERIFY")}
                            className="btn-ghost text-xs flex items-center gap-1"
                          >
                            <XCircle className="w-3 h-3" /> Remove Verified
                          </button>
                        ) : (
                          <button
                            onClick={() => handleCreatorAction(creator.id, "VERIFY")}
                            className="bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 px-3 py-1.5 rounded-lg text-xs font-medium transition flex items-center gap-1"
                          >
                            <BadgeCheck className="w-3 h-3" /> Verify
                          </button>
                        )}
                        {creator.isBanned ? (
                          <button
                            onClick={() => handleCreatorAction(creator.id, "UNBAN")}
                            className="bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 px-3 py-1.5 rounded-lg text-xs font-medium transition flex items-center gap-1"
                          >
                            <CheckCircle className="w-3 h-3" /> Unban
                          </button>
                        ) : (
                          <button
                            onClick={() => handleCreatorAction(creator.id, "BAN")}
                            className="bg-red-500/20 text-red-400 hover:bg-red-500/30 px-3 py-1.5 rounded-lg text-xs font-medium transition flex items-center gap-1"
                          >
                            <UserX className="w-3 h-3" /> Ban
                          </button>
                        )}
                        <a href={`/creator/${creator.id}`} className="btn-ghost text-xs">
                          View Profile
                        </a>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Earnings Tab — pending vs released balances + manual release */}
        {activeTab === "earnings" && (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <h2 className="font-display font-bold">Creator Earnings</h2>
              <button
                onClick={() => handleRelease("all")}
                disabled={releasing !== null || (earnings?.totals.ready ?? 0) <= 0}
                className="btn-brand disabled:opacity-50 flex items-center gap-2 justify-center"
              >
                <Clock className={`w-4 h-4 ${releasing === "all" ? "animate-spin" : ""}`} />
                {releasing === "all"
                  ? "Releasing…"
                  : `Release matured — TZS ${(earnings?.totals.ready ?? 0).toLocaleString()}`}
              </button>
            </div>

            {earnings ? (
              <>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <div className="glass-card p-4">
                    <p className="text-xs text-white/50">In holding (pending)</p>
                    <p className="text-xl font-bold mt-1">TZS {earnings.totals.pending.toLocaleString()}</p>
                  </div>
                  <div className="glass-card p-4">
                    <p className="text-xs text-white/50">Available for payout</p>
                    <p className="text-xl font-bold mt-1 text-emerald-400">TZS {earnings.totals.available.toLocaleString()}</p>
                  </div>
                  <div className="glass-card p-4">
                    <p className="text-xs text-white/50">Released (lifetime)</p>
                    <p className="text-xl font-bold mt-1 text-brand-300">TZS {earnings.totals.released.toLocaleString()}</p>
                  </div>
                  <div className="glass-card p-4 border border-amber-500/30">
                    <p className="text-xs text-amber-300/80">Matured — ready now</p>
                    <p className="text-xl font-bold mt-1 text-amber-400">TZS {earnings.totals.ready.toLocaleString()}</p>
                  </div>
                </div>

                <p className="text-xs text-white/40">
                  Automatic release runs after the {earnings.holdingPeriodDays}-day holding period
                  (cron: <code className="text-brand-300">/api/cron/release-earnings</code>). Manual release moves any matured funds immediately.
                </p>

                {earnings.creators.length === 0 ? (
                  <div className="glass-card p-12 text-center">
                    <Wallet className="w-12 h-12 text-brand-400/30 mx-auto mb-3" />
                    <p className="text-white/50">No creators with balances yet</p>
                  </div>
                ) : (
                  <div className="grid gap-3">
                    {earnings.creators.map((c) => (
                      <div key={c.creatorId} className="glass-card p-4">
                        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-medium flex items-center gap-1.5">
                              {c.displayName || "Creator"}
                              {c.isVerified && <BadgeCheck className="w-4 h-4 text-sky-400" />}
                            </p>
                            <p className="text-xs text-white/40 truncate">{c.email || c.creatorId}</p>
                          </div>
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-5 gap-y-1 text-xs">
                            <div>
                              <p className="text-white/40">Holding</p>
                              <p className="font-semibold">TZS {c.pendingBalance.toLocaleString()}</p>
                            </div>
                            <div>
                              <p className="text-white/40">Available</p>
                              <p className="font-semibold text-emerald-400">TZS {c.availableBalance.toLocaleString()}</p>
                            </div>
                            <div>
                              <p className="text-white/40">Released</p>
                              <p className="font-semibold text-brand-300">TZS {c.releasedTotal.toLocaleString()}</p>
                            </div>
                            <div>
                              <p className="text-white/40">Ready now</p>
                              <p className="font-semibold text-amber-400">TZS {c.readyToRelease.toLocaleString()}</p>
                            </div>
                          </div>
                          <button
                            onClick={() => handleRelease(c.creatorId)}
                            disabled={releasing !== null || c.readyToRelease <= 0}
                            className="bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 disabled:opacity-40 px-3 py-1.5 rounded-lg text-xs font-medium transition shrink-0"
                          >
                            {releasing === c.creatorId ? "Releasing…" : "Release now"}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="skeleton h-40 w-full rounded-xl" />
            )}
          </div>
        )}

        {/* Coupons Tab — promo codes */}
        {activeTab === "coupons" && (
          <div className="space-y-6">
            <h2 className="font-display font-bold">Promo Codes</h2>

            {/* Create coupon */}
            <div className="glass-card p-5 space-y-4">
              <h3 className="font-medium text-sm text-white/70">Create a coupon</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                <input
                  type="text"
                  value={newCoupon.code}
                  onChange={(e) => setNewCoupon({ ...newCoupon, code: e.target.value.toUpperCase() })}
                  placeholder="CODE (e.g. WELCOME10)"
                  className="input-field uppercase"
                  maxLength={32}
                />
                <select
                  value={newCoupon.type}
                  onChange={(e) => setNewCoupon({ ...newCoupon, type: e.target.value })}
                  className="input-field"
                >
                  <option value="PERCENT">% off / % bonus</option>
                  <option value="FIXED">Flat TZS bonus</option>
                </select>
                <input
                  type="number"
                  value={newCoupon.value}
                  onChange={(e) => setNewCoupon({ ...newCoupon, value: parseInt(e.target.value) || 0 })}
                  placeholder={newCoupon.type === "PERCENT" ? "% (1–100)" : "TZS"}
                  className="input-field"
                  min={1}
                  max={newCoupon.type === "PERCENT" ? 100 : undefined}
                />
                <input
                  type="number"
                  value={newCoupon.maxUses}
                  onChange={(e) => setNewCoupon({ ...newCoupon, maxUses: e.target.value })}
                  placeholder="Max uses (∞)"
                  className="input-field"
                  min={1}
                />
                <input
                  type="number"
                  value={newCoupon.expiresInDays}
                  onChange={(e) => setNewCoupon({ ...newCoupon, expiresInDays: e.target.value })}
                  placeholder="Expires (days)"
                  className="input-field"
                  min={1}
                />
              </div>
              <button
                onClick={createCoupon}
                disabled={creatingCoupon || !newCoupon.code.trim() || newCoupon.value < 1}
                className="btn-brand text-sm px-5 py-2.5 disabled:opacity-50"
              >
                {creatingCoupon ? "Creating…" : "Create Coupon"}
              </button>
            </div>

            {/* Coupon list */}
            {couponList.length === 0 ? (
              <div className="glass-card p-12 text-center">
                <Ticket className="w-12 h-12 text-brand-400/30 mx-auto mb-3" />
                <p className="text-white/50">No coupons yet — create your first one above.</p>
              </div>
            ) : (
              <div className="grid gap-3">
                {couponList.map((coupon) => (
                  <div key={coupon.id} className="glass-card p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-brand-500/20 flex items-center justify-center">
                        <Ticket className="w-5 h-5 text-brand-400" />
                      </div>
                      <div>
                        <p className="font-mono font-bold tracking-wider">{coupon.code}</p>
                        <p className="text-xs text-white/50">
                          {coupon.type === "PERCENT"
                            ? `${coupon.value}% ${"off purchases / extra on top-ups"}`
                            : `TZS ${coupon.value.toLocaleString()} value`}
                          {coupon.maxUses !== null && ` • ${coupon.usedCount}/${coupon.maxUses} used`}
                          {coupon.maxUses === null && ` • ${coupon.usedCount} used`}
                          {coupon.expiresAt &&
                            ` • expires ${new Date(coupon.expiresAt).toLocaleDateString("en-US")}`}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-[10px] font-bold px-2 py-1 rounded ${
                          coupon.isActive
                            ? "bg-emerald-500/20 text-emerald-400"
                            : "bg-white/10 text-white/40"
                        }`}
                      >
                        {coupon.isActive ? "ACTIVE" : "DISABLED"}
                      </span>
                      <button onClick={() => toggleCoupon(coupon.id)} className="btn-ghost text-xs">
                        {coupon.isActive ? "Disable" : "Enable"}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Payments Tab */}
        {activeTab === "payments" && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-display font-bold text-lg flex items-center gap-2">
                  <CreditCard className="w-5 h-5 text-brand-400" /> Payment operations
                </h2>
                <p className="text-white/50 text-sm mt-1 max-w-2xl">
                  Every charge settles through HarakaPay. Expire a charge whose USSD prompt
                  was never answered to release the customer&apos;s checkout lock — a late
                  settlement is still honoured, so no money is lost. Charges marked
                  <span className="text-amber-400"> Being checked</span> were approved on
                  the phone but never settled: those need a decision, and the customer has
                  been told not to pay again until you make it.
                </p>
              </div>
              <button onClick={fetchPayments} className="btn-ghost text-sm flex items-center gap-2">
                <RefreshCcw className="w-4 h-4" /> Refresh
              </button>
            </div>

            {paymentSummary && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="glass-card p-4">
                  <p className="text-xs text-white/50">Pending charges</p>
                  <p className="text-2xl font-bold">{paymentSummary.pending}</p>
                </div>
                <div className="glass-card p-4">
                  <p className="text-xs text-white/50">
                    Stuck &gt;{paymentSummary.stuckAfterMinutes} min
                  </p>
                  <p
                    className={`text-2xl font-bold ${
                      paymentSummary.stuck > 0 ? "text-amber-400" : ""
                    }`}
                  >
                    {paymentSummary.stuck}
                  </p>
                </div>
                <div
                  className={`p-4 rounded-xl border ${
                    (paymentSummary.investigating || 0) > 0
                      ? "border-amber-500/40 bg-amber-500/10"
                      : "glass-card"
                  }`}
                >
                  <p className="text-xs text-white/50">Being checked with networks</p>
                  <p
                    className={`text-2xl font-bold ${
                      (paymentSummary.investigating || 0) > 0 ? "text-amber-400" : ""
                    }`}
                  >
                    {paymentSummary.investigating || 0}
                  </p>
                  {(paymentSummary.investigating || 0) > 0 && (
                    <p className="text-[11px] text-amber-400/80 mt-1">
                      Customers may already have paid. Decide each one.
                    </p>
                  )}
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              {["UNDER_INVESTIGATION", "PENDING", "SUCCESS", "REFUNDED", "FAILED"].map((s) => (
                <button
                  key={s}
                  onClick={() => setPaymentStatus(s)}
                  className={`px-3 py-1.5 rounded-full text-sm font-medium border transition ${
                    paymentStatus === s
                      ? "border-brand-500 bg-brand-500/10 text-brand-400"
                      : "border-white/10 text-white/60 hover:border-white/30"
                  }`}
                >
                  {s === "SUCCESS"
                    ? "Completed"
                    : s === "UNDER_INVESTIGATION"
                      ? "Being checked"
                      : s === "REFUNDED"
                        ? "Refunded"
                        : s.charAt(0) + s.slice(1).toLowerCase()}
                  {s === "UNDER_INVESTIGATION" &&
                    (paymentSummary?.investigating || 0) > 0 && (
                      <span className="ml-1.5 text-amber-400">
                        {paymentSummary!.investigating}
                      </span>
                    )}
                </button>
              ))}
            </div>

            {paymentList.length === 0 ? (
              <div className="glass-card p-12 text-center">
                <ReceiptText className="w-12 h-12 text-brand-400/30 mx-auto mb-3" />
                <p className="text-white/50">
                  No {paymentStatus.toLowerCase().replace("_", " ")} charges.
                </p>
              </div>
            ) : (
              <div className="grid gap-3">
                {paymentList.map((p) => (
                  <div
                    key={p.id}
                    className="glass-card p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <p className="font-medium truncate">
                        {p.type}
                        {p.video?.title ? ` — ${p.video.title}` : ""}
                        {p.creator?.displayName ? ` — ${p.creator.displayName}` : ""}
                      </p>
                      <p className="text-xs text-white/50 mt-0.5">
                        {p.viewer.displayName || p.viewer.email || p.viewer.phone || p.viewer.id}
                        {" · "}TZS {p.amount.toLocaleString()}
                        {p.gateway ? ` · ${p.gateway}` : ""}
                        {p.providerRef ? ` · ${p.providerRef}` : ""}
                      </p>
                      <p className="text-xs text-white/40 mt-0.5">
                        {new Date(p.createdAt).toLocaleString("en-US")} · {p.ageMinutes}m ago
                        {p.stuck && <span className="text-amber-400"> · stuck</span>}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <span
                        className={`text-[10px] font-bold px-2 py-1 rounded ${
                          p.status === "SUCCESS"
                            ? "bg-emerald-500/20 text-emerald-400"
                            : p.status === "PENDING" ||
                                p.status === "UNDER_INVESTIGATION"
                              ? "bg-amber-500/20 text-amber-400"
                              : p.status === "REFUNDED"
                                ? "bg-sky-500/20 text-sky-400"
                                : "bg-red-500/20 text-red-400"
                        }`}
                      >
                        {p.status === "UNDER_INVESTIGATION" ? "BEING CHECKED" : p.status}
                      </span>
                      {p.status === "PENDING" && (
                        <button
                          onClick={() => setPendingExpire(p)}
                          disabled={expiring === p.id}
                          className="btn-ghost text-xs text-amber-400 disabled:opacity-50"
                        >
                          {expiring === p.id ? "Expiring…" : "Expire"}
                        </button>
                      )}

                      {/* The two ways out of an investigation. Both are decisions
                          about someone's money, so both confirm first. */}
                      {p.status === "UNDER_INVESTIGATION" && (
                        <>
                          <button
                            onClick={() => recheckCharge(p)}
                            disabled={rechecking === p.id || resolving === p.id}
                            className="btn-ghost text-xs disabled:opacity-50"
                          >
                            {rechecking === p.id ? "Asking…" : "Re-check gateway"}
                          </button>
                          <button
                            onClick={() => setPendingResolve({ payment: p, outcome: "GRANT" })}
                            disabled={resolving === p.id || rechecking === p.id}
                            className="btn-ghost text-xs text-emerald-400 disabled:opacity-50"
                          >
                            {resolving === p.id ? "Working…" : "Customer paid"}
                          </button>
                          <button
                            onClick={() =>
                              setPendingResolve({ payment: p, outcome: "MARK_UNPAID" })
                            }
                            disabled={resolving === p.id || rechecking === p.id}
                            className="btn-ghost text-xs text-white/60 disabled:opacity-50"
                          >
                            Never paid
                          </button>
                        </>
                      )}

                      {/* Money we hold and cannot hand over. Allowed on any
                          collected charge, not just a flagged one: a customer
                          can ask for a refund weeks after a charge settled. */}
                      {(p.status === "UNDER_INVESTIGATION" || p.status === "SUCCESS") && (
                        <button
                          onClick={() => {
                            setPendingRefund(p);
                            setRefundDestination("WALLET");
                            setRefundReason("");
                            setRefundGatewayRef("");
                          }}
                          disabled={refunding === p.id || resolving === p.id}
                          className="btn-ghost text-xs text-red-400 disabled:opacity-50"
                        >
                          {refunding === p.id ? "Reversing…" : "Refund"}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Setup Tab */}
        {activeTab === "setup" && (
          <div className="space-y-6">
            <div className="glass-card p-5">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  <h2 className="font-display font-bold flex items-center gap-2">
                    <Rocket className="w-5 h-5 text-brand-400" />
                    Launch setup
                  </h2>
                  <p className="text-sm text-white/50 mt-1">
                    Everything the site still needs before real users. Config is read from{" "}
                    <code className="text-white/70">{setup?.envFile.path || ".env.local"}</code>
                    {setup && !setup.envFile.present &&
                      " (not found - on a deploy these come from the host's environment)"}.
                  </p>
                </div>
                <button
                  onClick={() => fetchSetup(true)}
                  disabled={setupBusy}
                  className="btn-ghost text-sm flex items-center gap-1.5 disabled:opacity-50"
                >
                  {setupBusy ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <RefreshCcw className="w-4 h-4" />
                  )}
                  Re-check
                </button>
              </div>

              {setup ? (
                <div className="mt-4">
                  <div className="flex items-center gap-3 flex-wrap text-sm">
                    <span className="text-emerald-400">{setup.summary.done} collected</span>
                    <span className="text-white/20">·</span>
                    <span className="text-white/70">{setup.summary.todo} still to do</span>
                  </div>
                  <div className="h-2 rounded-full bg-white/5 mt-3 overflow-hidden">
                    <div
                      className="h-full bg-brand-500 transition-all"
                      style={{
                        width: `${Math.round(
                          (setup.summary.done /
                            Math.max(setup.summary.done + setup.summary.todo, 1)) *
                            100
                        )}%`,
                      }}
                    />
                  </div>
                </div>
              ) : (
                <p className="text-sm text-white/50 mt-4">
                  {setupBusy ? "Reading configuration…" : "Not loaded."}
                </p>
              )}

              {!!setup?.summary.restartPending && (
                <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2">
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-200/80">
                    {setup.summary.restartPending} value(s) were saved to .env.local after this server
                    started. Stop the server and start it again for them to take effect.
                  </p>
                </div>
              )}
            </div>

            {!!setup?.probes?.length && (
              <div className="glass-card p-5">
                <h2 className="font-display font-bold flex items-center gap-2">
                  <Activity className="w-5 h-5 text-brand-400" />
                  Live connections
                </h2>
                <p className="text-sm text-white/50 mt-1">
                  Real read-only connections. This is the half that proves a value works, not just
                  that it exists. Press Re-check to run them.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-4">
                  {setup.probes.map((probe) => (
                    <div
                      key={probe.id}
                      className="flex items-start gap-2 rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2"
                    >
                      <SetupProbeIcon state={probe.state} />
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{probe.name}</p>
                        <p className="text-xs text-white/50 break-words">{probe.detail}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* The only check that can tell "the key is valid" apart from
                "uploads actually work". It writes to the live Bunny library, so
                it is a button, never part of the Re-check sweep. */}
            <div className="glass-card p-5">
              <h2 className="font-display font-bold flex items-center gap-2">
                <Upload className="w-5 h-5 text-brand-400" />
                Video pipeline test
              </h2>
              <p className="text-sm text-white/50 mt-1">
                Creates a video object in your Bunny library, uploads a few
                kilobytes through the same signed path a creator uses, then reads
                it back and deletes it. A valid API key does not prove uploads
                work — this does. Takes a few seconds.
              </p>
              <button
                onClick={runPipelineTest}
                disabled={pipelineBusy}
                className="btn-brand text-sm mt-3 disabled:opacity-50 inline-flex items-center gap-2"
              >
                {pipelineBusy ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" /> Uploading…
                  </>
                ) : (
                  <>
                    <Upload className="w-4 h-4" /> Test upload pipeline
                  </>
                )}
              </button>

              {pipeline && (
                <div
                  className={`mt-4 rounded-xl border p-3 ${
                    pipeline.verdict === "ok"
                      ? "border-emerald-500/30 bg-emerald-500/5"
                      : pipeline.verdict === "accepted-not-stored"
                        ? "border-amber-500/30 bg-amber-500/5"
                        : "border-red-500/30 bg-red-500/5"
                  }`}
                >
                  <p className="text-sm font-semibold">
                    {pipeline.verdict === "ok" ? "✓ " : "✗ "}
                    {pipeline.headline}
                  </p>
                  <p className="text-xs text-white/60 mt-1">{pipeline.detail}</p>

                  {pipeline.steps.length > 0 && (
                    <ul className="mt-3 space-y-1">
                      {pipeline.steps.map((step, i) => (
                        <li key={i} className="flex items-start gap-2 text-xs">
                          <span
                            className={
                              step.ok ? "text-emerald-400" : "text-red-400"
                            }
                          >
                            {step.ok ? "✓" : "✗"}
                          </span>
                          <span className="text-white/70">
                            <span className="font-medium">{step.label}</span>
                            <span className="text-white/40"> — {step.detail}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>

            {setup?.groups.map((group) => (
              <SetupGroupCard key={group.id} group={group} />
            ))}

            {!setup && (
              <div className="glass-card p-5">
                <p className="text-sm text-white/50">
                  {setupBusy ? "Reading configuration…" : "Setup report not loaded."}
                </p>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Typed-reason dialog (ban / reject) */}
      {reasonDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => setReasonDialog(null)}
        >
          <div
            className="glass-card w-full max-w-md p-6 animate-slide-up"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <AlertTriangle
                className={`w-5 h-5 ${
                  reasonDialog.tone === "danger" ? "text-red-400" : "text-brand-400"
                }`}
              />
              <h2 className="font-display font-bold">{reasonDialog.title}</h2>
            </div>

            <label
              className="text-sm text-white/60 mt-4 mb-2 block"
              htmlFor="admin-reason"
            >
              {reasonDialog.label}
            </label>
            <textarea
              id="admin-reason"
              value={reasonValue}
              onChange={(e) => setReasonValue(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder={reasonDialog.placeholder}
              className="input-field"
              autoFocus
            />

            <div className="flex gap-3 mt-5">
              <button onClick={() => setReasonDialog(null)} className="btn-ghost flex-1">
                Cancel
              </button>
              <button
                onClick={() => {
                  const value = reasonValue.trim();
                  if (!value) return;
                  const run = reasonDialog.onConfirm;
                  setReasonDialog(null);
                  run(value);
                }}
                disabled={!reasonValue.trim()}
                className="btn-brand flex-1 disabled:opacity-50"
              >
                {reasonDialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reverse a collected charge */}
      {pendingRefund && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 overflow-y-auto"
          role="dialog"
          aria-modal="true"
          onClick={() => setPendingRefund(null)}
        >
          <div
            className="glass-card w-full max-w-lg p-6 animate-slide-up my-8"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <RotateCcw className="w-5 h-5 text-red-400" />
              <h2 className="font-display font-bold">Reverse this charge?</h2>
            </div>

            <p className="text-sm text-white/60 mt-3">
              TZS {pendingRefund.amount.toLocaleString()} · {pendingRefund.type}
              {pendingRefund.providerRef ? ` · ${pendingRefund.providerRef}` : ""}
            </p>
            <p className="text-sm text-white/60 mt-1">
              {pendingRefund.viewer.displayName ||
                pendingRefund.viewer.email ||
                pendingRefund.viewer.phone ||
                pendingRefund.viewer.id}
              {pendingRefund.video?.title ? ` · ${pendingRefund.video.title}` : ""}
              {!pendingRefund.video && pendingRefund.creator?.displayName
                ? ` · ${pendingRefund.creator.displayName}`
                : ""}
            </p>

            {/* Which leg of the refund moves. This is the decision that decides
                whether the customer can be paid twice. */}
            <label className="text-sm text-white/60 mt-5 mb-2 block">
              How is the customer made whole?
            </label>
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setRefundDestination("WALLET")}
                className={`w-full text-left p-3 rounded-xl border transition ${
                  refundDestination === "WALLET"
                    ? "border-brand-500 bg-brand-500/10"
                    : "border-white/10 hover:border-white/30"
                }`}
              >
                <p className="text-sm font-medium flex items-center gap-2">
                  <Wallet className="w-4 h-4" /> Wallet credit — instant
                </p>
                <p className="text-xs text-white/50 mt-1">
                  We credit TZS {pendingRefund.amount.toLocaleString()} to their wallet
                  right now. Nothing is sent back through the network, so they cannot be
                  paid twice.
                </p>
              </button>

              <button
                type="button"
                onClick={() => setRefundDestination("GATEWAY")}
                disabled={pendingRefund.type === "WALLET_TOPUP"}
                className={`w-full text-left p-3 rounded-xl border transition disabled:opacity-40 disabled:cursor-not-allowed ${
                  refundDestination === "GATEWAY"
                    ? "border-brand-500 bg-brand-500/10"
                    : "border-white/10 hover:border-white/30"
                }`}
              >
                <p className="text-sm font-medium flex items-center gap-2">
                  <Smartphone className="w-4 h-4" /> Back to their phone
                </p>
                <p className="text-xs text-white/50 mt-1">
                  {pendingRefund.type === "WALLET_TOPUP"
                    ? "Take the TZS " +
                      pendingRefund.amount.toLocaleString() +
                      " credit back out of their wallet and return it to the number they paid from. HarakaPay has no reversal API, so send it back in their dashboard first."
                    : "Money goes back to the number they paid from, not to their wallet. HarakaPay has no reversal API, so send it back in their dashboard first, then record the reference below."}
                </p>
              </button>
            </div>

            {refundDestination === "GATEWAY" && (
              <div className="mt-4">
                <label
                  className="text-sm text-white/60 mb-2 block"
                  htmlFor="refund-gateway-ref"
                >
                  HarakaPay reversal reference (required)
                </label>
                <input
                  id="refund-gateway-ref"
                  type="text"
                  value={refundGatewayRef}
                  onChange={(e) => setRefundGatewayRef(e.target.value)}
                  placeholder="e.g. REV-2026-000123"
                  className="input-field"
                  maxLength={120}
                />
                <p className="text-xs text-white/40 mt-1">
                  We cannot verify this — it is recorded as the evidence that the money
                  went back.
                </p>
              </div>
            )}

            <label className="text-sm text-white/60 mt-4 mb-2 block" htmlFor="refund-reason">
              Why is it being refunded? (shown to the customer)
            </label>
            <textarea
              id="refund-reason"
              value={refundReason}
              onChange={(e) => setRefundReason(e.target.value)}
              rows={2}
              maxLength={200}
              placeholder="e.g. the creator withdrew this video before you watched it"
              className="input-field"
            />

            {/* What this does to both sides, stated before it happens. */}
            <div className="mt-4 rounded-xl border border-white/10 bg-surface-300/30 p-3 text-xs space-y-1">
              <p className="text-white/60">
                <span className="text-white/80">Customer:</span>{" "}
                {refundDestination === "WALLET"
                  ? `TZS ${pendingRefund.amount.toLocaleString()} added to their wallet`
                  : pendingRefund.type === "WALLET_TOPUP"
                    ? `TZS ${pendingRefund.amount.toLocaleString()} removed from their wallet and returned to their phone`
                    : `TZS ${pendingRefund.amount.toLocaleString()} returned to their phone`}
                {". "}
                {/* Only promise to take something away if they ever had it: a
                    charge that never settled unlocked nothing. */}
                {pendingRefund.type === "WALLET_TOPUP"
                  ? "The top-up credit is taken back."
                  : pendingRefund.status === "SUCCESS"
                    ? pendingRefund.type === "PPV_PURCHASE"
                      ? "Access to the video ends."
                      : pendingRefund.type === "SUBSCRIPTION"
                        ? "The membership ends and will not auto-renew."
                        : ""
                    : "Nothing was ever unlocked by it, so there is nothing to take away."}
              </p>
              <p className="text-white/60">
                <span className="text-white/80">Creator:</span>{" "}
                {pendingRefund.status === "SUCCESS"
                  ? "the 70% share is taken back from their holding first, then their available balance. Anything already paid out becomes a recorded platform loss."
                  : "nothing is taken back. This charge never settled in our books, so the creator was never credited for it — the refund is a cost we absorb."}
              </p>
              <p className="text-white/60">
                <span className="text-white/80">Recorded:</span> status becomes REFUNDED
                with your admin id, the destination and the reason.
              </p>
            </div>

            <div className="flex gap-3 mt-5">
              <button onClick={() => setPendingRefund(null)} className="btn-ghost flex-1">
                Cancel
              </button>
              <button
                onClick={() => issueRefund(pendingRefund)}
                disabled={
                  refunding === pendingRefund.id ||
                  (refundDestination === "GATEWAY" && !refundGatewayRef.trim())
                }
                className="flex-1 bg-red-500/90 hover:bg-red-500 text-white font-medium rounded-xl px-4 py-2.5 transition disabled:opacity-50"
              >
                {refunding === pendingRefund.id ? "Reversing…" : "Reverse and refund"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Resolve an under-investigation charge */}
      {pendingResolve && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => setPendingResolve(null)}
        >
          <div
            className="glass-card w-full max-w-md p-6 animate-slide-up"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <HelpCircle
                className={`w-5 h-5 ${
                  pendingResolve.outcome === "GRANT" ? "text-emerald-400" : "text-amber-400"
                }`}
              />
              <h2 className="font-display font-bold">
                {pendingResolve.outcome === "GRANT"
                  ? "Confirm the customer paid"
                  : "Confirm the money never moved"}
              </h2>
            </div>

            <p className="text-sm text-white/60 mt-3">
              TZS {pendingResolve.payment.amount.toLocaleString()} ·{" "}
              {pendingResolve.payment.type}
              {pendingResolve.payment.providerRef
                ? ` · ${pendingResolve.payment.providerRef}`
                : ""}
            </p>
            <p className="text-sm text-white/60 mt-2">
              {pendingResolve.payment.viewer.displayName ||
                pendingResolve.payment.viewer.email ||
                pendingResolve.payment.viewer.phone ||
                pendingResolve.payment.viewer.id}
              {pendingResolve.payment.video?.title
                ? ` · ${pendingResolve.payment.video.title}`
                : ""}
            </p>

            <p className="text-sm text-white/50 mt-4">
              {pendingResolve.outcome === "GRANT"
                ? "The purchase is unlocked and the creator's 70% share is recorded, exactly as a settled payment would be. Only do this once the operator has confirmed the debit."
                : "The charge is released and the customer is told it is safe to try again. If the network turns out to have taken the money after all, the payment is still honoured — nothing is lost."}
            </p>

            <label
              className="text-sm text-white/60 mt-4 mb-2 block"
              htmlFor="resolve-note"
            >
              Note for the audit trail (optional)
            </label>
            <textarea
              id="resolve-note"
              value={resolveNote}
              onChange={(e) => setResolveNote(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder={
                pendingResolve.outcome === "GRANT"
                  ? "e.g. operator reference confirmed the debit on 0682…"
                  : "e.g. operator says no debit was posted"
              }
              className="input-field"
            />

            <div className="flex gap-3 mt-5">
              <button onClick={() => setPendingResolve(null)} className="btn-ghost flex-1">
                Cancel
              </button>
              <button
                onClick={() => {
                  const note = resolveNote.trim();
                  resolveCharge(
                    pendingResolve.payment,
                    pendingResolve.outcome,
                    note || undefined
                  );
                  setResolveNote("");
                }}
                disabled={resolving === pendingResolve.payment.id}
                className={`flex-1 disabled:opacity-50 ${
                  pendingResolve.outcome === "GRANT" ? "btn-brand" : "btn-ghost"
                }`}
              >
                {resolving === pendingResolve.payment.id
                  ? "Working…"
                  : pendingResolve.outcome === "GRANT"
                    ? "Unlock the purchase"
                    : "Release the charge"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Force-expire confirmation */}
      {pendingExpire && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => setPendingExpire(null)}
        >
          <div
            className="glass-card w-full max-w-sm p-6 animate-slide-up"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-400" />
              <h2 className="font-display font-bold">Expire this charge?</h2>
            </div>
            <p className="text-sm text-white/60 mt-3">
              TZS {pendingExpire.amount.toLocaleString()} · {pendingExpire.type}
              {pendingExpire.providerRef ? ` · ${pendingExpire.providerRef}` : ""}
            </p>
            <p className="text-sm text-white/60 mt-2">
              The charge is marked failed and the customer can pay again. If HarakaPay
              settles it later anyway, the payment is still honoured and access is granted.
            </p>
            <div className="flex gap-3 mt-5">
              <button onClick={() => setPendingExpire(null)} className="btn-ghost flex-1">
                Keep waiting
              </button>
              <button
                onClick={() => expireCharge(pendingExpire)}
                className="btn-brand flex-1"
              >
                Expire charge
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}