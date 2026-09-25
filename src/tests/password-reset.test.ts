// =============================================================================
// GENHUB - Password reset
//
// These two routes had no test at all, which is a strange gap for the only flow
// that hands an account to whoever holds a link. What is pinned here:
//
//   1. The database never stores the token. It stores sha256(token), so a leaked
//      dump is not a set of working account-takeover links. The token exists only
//      in the message we sent.
//   2. Reset accepts the token it emailed and only that — i.e. the lookup hashes
//      what the client presented.
//   3. A used or expired token is refused.
//   4. The response says the same thing whether or not the account exists, so the
//      endpoint cannot be used to enumerate users.
//
// Storage, mail, SMS and the rate limiter are mocked; hashing and the route logic
// are real.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

const mocks = vi.hoisted(() => ({
  userFindFirst: vi.fn(),
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  resetUpdateMany: vi.fn(),
  resetCreate: vi.fn(),
  resetFindUnique: vi.fn(),
  resetUpdate: vi.fn(),
  transaction: vi.fn(),
  sendEmail: vi.fn(),
  sendSms: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    user: {
      findFirst: mocks.userFindFirst,
      findUnique: mocks.userFindUnique,
      update: mocks.userUpdate,
    },
    passwordReset: {
      updateMany: mocks.resetUpdateMany,
      create: mocks.resetCreate,
      findUnique: mocks.resetFindUnique,
      update: mocks.resetUpdate,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/redis", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 99, resetAt: 0 })),
}));

vi.mock("@/lib/config", () => ({
  default: { appUrl: "https://genhub.example", nodeEnv: "test", cookieName: "genhub_token" },
}));

vi.mock("@/lib/email", () => ({
  sendPasswordResetEmail: mocks.sendEmail,
}));

vi.mock("@/lib/sms", () => ({
  sendPasswordResetSms: mocks.sendSms,
}));

import { POST as forgotPassword } from "@/app/api/auth/forgot-password/route";
import { POST as resetPassword } from "@/app/api/auth/reset-password/route";

function post(body: unknown) {
  return new Request("http://localhost/api/auth/forgot-password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindFirst.mockResolvedValue({ id: "u1" });
  mocks.userFindUnique.mockResolvedValue({ email: "fan@example.com", phone: null });
  mocks.resetCreate.mockResolvedValue({ id: "reset-1" });
  mocks.sendEmail.mockResolvedValue({ transport: "smtp", sent: true });
  mocks.sendSms.mockResolvedValue({ transport: "console", sent: true });
  mocks.transaction.mockImplementation(
    async (run: (tx: unknown) => Promise<unknown>) =>
      run({ user: { update: mocks.userUpdate }, passwordReset: { update: mocks.resetUpdate } })
  );
});

describe("requesting a reset", () => {
  it("stores only the hash, and emails a link that carries the token", async () => {
    const response = await forgotPassword(post({ email: "fan@example.com" }));
    expect(response.status).toBe(200);

    const stored = mocks.resetCreate.mock.calls[0][0].data.token as string;
    const emailed = mocks.sendEmail.mock.calls[0][1] as string;
    const tokenInLink = new URL(emailed).searchParams.get("token") as string;

    expect(tokenInLink).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).toBe(sha(tokenInLink));
    // The whole point: the row cannot be replayed.
    expect(stored).not.toBe(tokenInLink);
  });

  it("sends the token by SMS when the account has only a phone", async () => {
    mocks.userFindFirst.mockResolvedValue({ id: "u2" });
    mocks.userFindUnique.mockResolvedValue({ email: null, phone: "0712345678" });

    await forgotPassword(post({ phone: "0712345678" }));

    const url = mocks.sendSms.mock.calls[0][1] as string;
    const tokenInLink = new URL(url).searchParams.get("token") as string;
    expect(mocks.resetCreate.mock.calls[0][0].data.token).toBe(sha(tokenInLink));
  });

  it("retires every outstanding token before issuing a new one", async () => {
    await forgotPassword(post({ email: "fan@example.com" }));

    expect(mocks.resetUpdateMany).toHaveBeenCalledWith({
      where: { userId: "u1", used: false },
      data: { used: true },
    });
  });

  it("answers identically when the account does not exist", async () => {
    // Otherwise the endpoint is a user-enumeration oracle.
    mocks.userFindFirst.mockResolvedValue(null);

    const response = await forgotPassword(post({ email: "nobody@example.com" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toMatch(/if that account exists/i);
    expect(mocks.resetCreate).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("requires an email or a phone", async () => {
    const response = await forgotPassword(post({}));
    expect(response.status).toBe(422);
  });
});

describe("using the token", () => {
  it("looks the token up by its hash", async () => {
    const token = "a".repeat(64);
    mocks.resetFindUnique.mockResolvedValue({
      id: "reset-1",
      userId: "u1",
      used: false,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const response = await resetPassword(post({ token, password: "new-pass-123" }));

    expect(response.status).toBe(200);
    expect(mocks.resetFindUnique).toHaveBeenCalledWith({ where: { token: sha(token) } });
    expect(mocks.userUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.resetUpdate).toHaveBeenCalledWith({
      where: { id: "reset-1" },
      data: { used: true },
    });
  });

  it("refuses a token that has already been used", async () => {
    mocks.resetFindUnique.mockResolvedValue({
      id: "reset-1",
      userId: "u1",
      used: true,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const response = await resetPassword(post({ token: "b".repeat(64), password: "new-pass-123" }));

    expect(response.status).toBe(400);
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it("refuses an expired token", async () => {
    mocks.resetFindUnique.mockResolvedValue({
      id: "reset-1",
      userId: "u1",
      used: false,
      expiresAt: new Date(Date.now() - 1_000),
    });

    const response = await resetPassword(post({ token: "c".repeat(64), password: "new-pass-123" }));
    expect(response.status).toBe(400);
  });

  it("refuses a token that was never issued", async () => {
    mocks.resetFindUnique.mockResolvedValue(null);

    const response = await resetPassword(post({ token: "d".repeat(64), password: "new-pass-123" }));
    expect(response.status).toBe(400);
  });

  it("refuses a password shorter than the registration minimum", async () => {
    const response = await resetPassword(post({ token: "e".repeat(64), password: "short" }));
    expect(response.status).toBe(422);
  });
});
