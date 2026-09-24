// =============================================================================
// GENHUB - One page load asks who is signed in once
//
// What this suite is about, in the shape it was found in production: a single
// page load made two or three identical requests to /api/auth/me in the same few
// milliseconds (the Header, the bottom navigation, and the page's own guard), and
// a signed-out visitor got two or three 401s in the console — the ordinary state,
// printed as failure, which is how a real error stops being read.
//
// The other half is the risk the fix introduces: a shared answer that outlives
// the session it describes. A cache that survives a sign-in shows the signed-out
// header to somebody who has just signed in, and there is no second window to
// read that in — so the window and the forgetting are both pinned here.
//
// `fetch` is stubbed, so no request leaves the process and the count of them is
// the assertion.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  CURRENT_USER_PATH,
  CURRENT_USER_TTL_MS,
  currentUserWaiters,
  fetchCurrentUser,
  forgetCurrentUser,
} from "@/lib/current-user";

/** An answer shaped like the route's: a body every caller will read. */
function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const signedOut = () => answer(401, { success: false, error: "Unauthorized" });
const signedIn = (role = "CREATOR") =>
  answer(200, { success: true, data: { id: "u1", role } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  forgetCurrentUser();
  fetchMock = vi.fn(async () => signedOut());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  forgetCurrentUser();
});

describe("fetchCurrentUser", () => {
  it("turns the mount burst into one request", async () => {
    // Header, BottomNav and the page guard, in the same tick.
    const [a, b, c] = await Promise.all([
      fetchCurrentUser(),
      fetchCurrentUser(),
      fetchCurrentUser(),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(CURRENT_USER_PATH);
    expect([a.status, b.status, c.status]).toEqual([401, 401, 401]);
  });

  it("gives every caller a readable body, not just the first", async () => {
    // A `Response` body can be read once. Sharing one object would make the
    // second caller's `.json()` throw "Body is unusable", which is a worse bug
    // than the request it saves.
    const [a, b] = await Promise.all([fetchCurrentUser(), fetchCurrentUser()]);

    const [first, second] = await Promise.all([a.json(), b.json()]);
    expect(first).toEqual({ success: false, error: "Unauthorized" });
    expect(second).toEqual(first);
  });

  it("asks again once the window has passed", async () => {
    // The clock is moved instead of fake timers: a fake timer run also fakes the
    // microtask queue, and a `Response` body never finishes resolving under it.
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    await fetchCurrentUser();
    await fetchCurrentUser();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    clock.mockReturnValue(1_000 + CURRENT_USER_TTL_MS + 1);
    await fetchCurrentUser();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("forgets the answer when the session changes", async () => {
    // Sign-in and sign-out call this. Without it the Header keeps painting the
    // old state for the rest of the window.
    await fetchCurrentUser();
    fetchMock.mockResolvedValueOnce(signedIn("ADMIN"));

    forgetCurrentUser();
    const res = await fetchCurrentUser();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await res.json()).data.role).toBe("ADMIN");
  });

  it("tells every waiter when the request itself fails", async () => {
    // A dead network is not a 401, and swallowing it into "signed out" would
    // sign a fan out of a session that is fine. Both callers get the failure.
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    const [a, b] = await Promise.allSettled([fetchCurrentUser(), fetchCurrentUser()]);

    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not leave a failed request unhandled", async () => {
    // The shared request has no `await` of its own: if nobody collects its
    // rejection, Node reports an unhandled rejection and vitest fails the file.
    const unhandled = vi.fn();
    process.once("unhandledRejection", unhandled);

    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(fetchCurrentUser()).rejects.toThrow("network down");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(unhandled).not.toHaveBeenCalled();
  });

  it("answers a caller who arrives after the answer is already here", async () => {
    // The realistic order, and the bug this module shipped before its own test
    // caught it: the Header asks and is answered, then the page's guard asks —
    // still inside the window. Remembering only the waiters left that second
    // caller on a promise nothing would resolve, so the page span forever while
    // the answer sat one line above it.
    await fetchCurrentUser();
    const late = await fetchCurrentUser();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await late.json()).success).toBe(false);
  });

  it("does not remember a failure", async () => {
    // A network blip must not sign somebody out of a session that is fine.
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(fetchCurrentUser()).rejects.toThrow("network down");

    fetchMock.mockResolvedValueOnce(signedIn());
    const res = await fetchCurrentUser();

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("joins a request that is already on the way", async () => {
    // The realistic order: the Header mounts and asks, the page's guard runs a
    // tick later. The second must join the first rather than add a request.
    let release: (res: Response) => void = () => {};
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (release = resolve))
    );

    const first = fetchCurrentUser();
    await Promise.resolve();
    const second = fetchCurrentUser();

    expect(currentUserWaiters()).toBe(2);
    release(signedIn("ADMIN"));

    const [a, b] = await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await a.json()).data.role).toBe("ADMIN");
    expect((await b.json()).data.role).toBe("ADMIN");
  });
});
