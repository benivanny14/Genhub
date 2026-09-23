// =============================================================================
// GENHUB - HarakaPay Integration (the only gateway)
// USSD push payments: the customer approves the charge on their own phone.
// Docs: POST /api/v1/collect, GET /api/v1/status/{order_id}, GET /api/v1/balance
// Auth: X-API-Key header on every request.
// =============================================================================

import config from "../config";

// =============================================================================
// Types
// =============================================================================

export interface HarakaCollectRequest {
  phone: string; // 0712345678
  amount: number; // TZS, min 100
  description?: string;
  webhookUrl?: string;
}

export interface HarakaCollectResponse {
  success: boolean;
  message?: string;
  order_id?: string;
  amount?: number;
  net_amount?: number;
  fee?: number;
  error?: string;
}

export interface HarakaPayment {
  order_id: string;
  status: string; // completed | failed | pending | ...
  amount: number;
  net_amount: number;
  fee_amount: number;
  created_at: string;
  completed_at?: string | null;
}

export interface HarakaStatusResponse {
  success: boolean;
  payment?: HarakaPayment;
  error?: string;
}

export interface HarakaBalanceResponse {
  success: boolean;
  wallet_balance?: number;
  float_balance?: number;
  error?: string;
}

// =============================================================================
// Shared fetch wrapper (auth header + timeout)
// =============================================================================

async function harakaFetch<T>(path: string, init?: RequestInit): Promise<T> {
  if (!config.harakaPay.apiKey) {
    throw new Error("HARAKAPAY_API_KEY is not configured");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetch(`${config.harakaPay.baseUrl}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": config.harakaPay.apiKey,
        ...(init?.headers || {}),
      },
      cache: "no-store",
    });

    const data = (await response.json().catch(() => ({}))) as T & {
      success?: boolean;
      error?: string;
    };

    if (!response.ok) {
      throw new Error(
        `HarakaPay ${path} error ${response.status}: ${data?.error || response.statusText}`
      );
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

// =============================================================================
// 1. Collect payment (USSD push to the customer's phone)
// =============================================================================

export async function harakaCollect(
  request: HarakaCollectRequest
): Promise<HarakaCollectResponse> {
  return harakaFetch<HarakaCollectResponse>("/api/v1/collect", {
    method: "POST",
    body: JSON.stringify({
      phone: request.phone,
      amount: request.amount,
      description: request.description || "",
      ...(request.webhookUrl ? { webhook_url: request.webhookUrl } : {}),
    }),
  });
}

// =============================================================================
// 2. Payment status by HarakaPay order_id
// =============================================================================

export async function harakaStatus(
  orderId: string
): Promise<HarakaStatusResponse> {
  return harakaFetch<HarakaStatusResponse>(
    `/api/v1/status/${encodeURIComponent(orderId)}`
  );
}

// =============================================================================
// 3. Wallet balance
// =============================================================================

export async function harakaBalance(): Promise<HarakaBalanceResponse> {
  return harakaFetch<HarakaBalanceResponse>("/api/v1/balance");
}

// =============================================================================
// Webhook helpers
// =============================================================================

// Payload shape posted by HarakaPay to our webhook_url
export interface HarakaWebhookPayload {
  order_id: string;
  status: string; // "completed" | "failed"
  amount: number;
  net_amount: number;
  fee_amount: number;
  created_at: string;
  completed_at?: string | null;
}

// =============================================================================
// Human-readable failure reason
// =============================================================================
// Our fetch wrapper prefixes thrown errors with "HarakaPay /path error 4xx: ".
// Strip that so the UI can show the merchant what the gateway actually said
// (e.g. "insufficient balance", "invalid phone number").
export function harakaErrorReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const cleaned = raw
    .replace(/^HarakaPay\s+\S+\s+error\s+\d+:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "gateway haijajibu";
}

export function harakaStatusToInternal(
  status: string
): "SUCCESS" | "FAILED" | null {
  const s = status.toLowerCase();
  if (s === "completed" || s === "success") return "SUCCESS";
  if (s === "failed" || s === "cancelled" || s === "canceled") return "FAILED";
  return null;
}
