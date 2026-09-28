// =============================================================================
// GENHUB - The name a person chooses IS their username
//
// Sign-up used to ask twice: a display name, and a second, separate username.
// The public name was then the display name — free text two accounts can share —
// while the unique handle sat in the profile as a different name for the same
// person. What was asked for instead: one name, chosen by the person, used as
// their username.
//
// So the handle is folded out of the name they typed (`Kayena glazed` ->
// `@kayena_glazed`), and a handle somebody else already holds is NUMBERED rather
// than refused (`@kayena_glazed_2`) — the person already said which name they
// want, and "that name is taken" is an answer to a question this form does not
// ask. Two things must not happen on the way: the derived handle must never be
// one the rules refuse (a name that opens with a reserved word), and a handle
// someone explicitly NAMED must still be reported as taken rather than quietly
// changed behind their back.
//
// Prisma, auth, mail and bcrypt are mocked; the route and the schemas are real.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  userFindFirst: vi.fn(),
  userFindUnique: vi.fn(),
  userCreate: vi.fn(),
  userUpdate: vi.fn(),
  runTransaction: vi.fn(),
  setAuthCookie: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    user: {
      findFirst: mocks.userFindFirst,
      findUnique: mocks.userFindUnique,
      create: mocks.userCreate,
      update: mocks.userUpdate,
    },
    $transaction: mocks.runTransaction,
  },
}));

vi.mock("@/lib/redis", () => ({
  checkRateLimit: async () => ({ allowed: true, remaining: 9, resetAt: 0 }),
  cacheDel: async () => {},
}));

vi.mock("@/lib/auth", () => ({
  generateToken: async () => "token",
  setAuthCookie: mocks.setAuthCookie,
  AuthError: class AuthError extends Error {
    statusCode = 401;
  },
}));

vi.mock("@/lib/email", () => ({ sendWelcomeEmail: async () => {} }));

// The hash is 12 rounds of real bcrypt work; nothing here is about the hash.
vi.mock("bcryptjs", () => ({ default: { hash: async () => "hashed-password" } }));

import { POST } from "@/app/api/auth/register/route";

const json = async (response: Response) => (await response.json()) as Record<string, unknown>;

function signUp(payload: Record<string, unknown>) {
  return POST(
    new NextRequest("https://app.test/api/auth/register", {
      method: "POST",
      body: JSON.stringify(payload),
    })
  );
}

/** The `data` handed to prisma's user.create. */
function created() {
  return (mocks.userCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data;
}

/**
 * Accounts that already exist: `username` collisions, plus an optional referrer
 * answering the referral-code lookup.
 */
function accountsExist(options: { taken?: string[]; referrer?: { id: string } | null } = {}) {
  const taken = options.taken ?? [];
  mocks.userFindUnique.mockImplementation(
    (args: { where: { username?: string; referralCode?: string } }) => {
      if (args.where.username) {
        return Promise.resolve(taken.includes(args.where.username) ? { id: "someone" } : null);
      }
      if (args.where.referralCode) return Promise.resolve(options.referrer ?? null);
      return Promise.resolve(null);
    }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindFirst.mockResolvedValue(null);
  mocks.userCreate.mockResolvedValue({
    id: "new-user",
    displayName: "Kayena glazed",
    username: "kayena_glazed",
    email: "kayena@example.com",
    phone: null,
    role: "VIEWER",
    locale: "en",
    createdAt: new Date(),
  });
  accountsExist();
});

describe("POST /api/auth/register", () => {
  it("makes the username out of the name it was given", async () => {
    const response = await signUp({
      displayName: "Kayena glazed",
      email: "kayena@example.com",
      password: "password123",
    });

    expect(response.status).toBe(201);
    expect(created().username).toBe("kayena_glazed");
    expect(created().displayName).toBe("Kayena glazed");
  });

  it("keeps the name and numbers the handle when somebody already holds it", async () => {
    accountsExist({ taken: ["kayena_glazed"] });

    const response = await signUp({
      displayName: "Kayena glazed",
      email: "other@example.com",
      password: "password123",
    });

    expect(response.status).toBe(201);
    expect(created().username).toBe("kayena_glazed_2");
  });

  it("refuses a name that would claim a reserved handle, and says why", async () => {
    const response = await signUp({
      displayName: "Admin",
      email: "admin@example.com",
      password: "password123",
    });

    expect(response.status).toBe(422);
    expect(String((await json(response)).error)).toMatch(/reserved username @admin/);
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });

  it("refuses a name with nothing a handle can be made of", async () => {
    const response = await signUp({
      displayName: "!!!",
      email: "nobody@example.com",
      password: "password123",
    });

    expect(response.status).toBe(422);
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });

  it("still reports a handle the caller NAMED as taken, instead of renumbering it", async () => {
    accountsExist({ taken: ["amani"] });

    const response = await signUp({
      displayName: "Amani Juma",
      username: "amani",
      email: "amani@example.com",
      password: "password123",
    });

    expect(response.status).toBe(409);
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });

  it("gives the next number when a derived handle loses a race", async () => {
    // The handle was free when it was looked up and somebody else's by the time
    // the insert ran — the window the UNIQUE index exists to close. Simulated by
    // the name becoming visible only once a create has been attempted.
    mocks.userFindUnique.mockImplementation((args: { where: { username?: string } }) => {
      const raced = args.where.username === "kayena_glazed" && mocks.userCreate.mock.calls.length > 0;
      return Promise.resolve(raced ? { id: "someone" } : null);
    });
    mocks.userCreate.mockRejectedValueOnce(
      Object.assign(new Error("unique"), { code: "P2002", meta: { target: ["username"] } })
    );

    const response = await signUp({
      displayName: "Kayena glazed",
      email: "kayena@example.com",
      password: "password123",
    });

    expect(response.status).toBe(201);
    const second = (mocks.userCreate.mock.calls[1][0] as { data: { username: string } }).data;
    expect(second.username).toBe("kayena_glazed_2");
  });

  it("credits the referrer nothing at sign-up — the bonus rides on a real payment", async () => {
    accountsExist({ referrer: { id: "referrer-1" } });

    const response = await signUp({
      displayName: "Amani Juma",
      email: "amani@example.com",
      password: "password123",
      referralCode: "AMANI2X9K",
    });

    expect(response.status).toBe(201);
    // The attribution is recorded on the new account...
    expect(created().referredById).toBe("referrer-1");
    // ...and no money moves. The bonus is released by the webhook when this
    // person's first payment settles (see services/referral.service.ts).
    expect(mocks.runTransaction).not.toHaveBeenCalled();
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });
});
