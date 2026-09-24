// =============================================================================
// GENHUB - Ask who is signed in once per page load, not once per component
//
// Almost every page in this app asks `/api/auth/me` on mount — to decide between
// the page and its "sign in first" guard — and the shared Header asks it too, for
// the avatar and the menu. So one page load made two identical requests in the
// same few milliseconds, and for a signed-out visitor both were answered 401: two
// red lines in the console for the most ordinary state there is, which is how a
// real error stops being noticed.
//
// This hands the same answer to everybody who asks while it is on the way, then
// forgets it almost immediately. The window is deliberately tiny: this is a
// session, and a cache that outlives a sign-in or a sign-out shows the wrong
// header to the wrong person — five seconds of a stale answer is a bug report.
// Two seconds covers the mount burst and nothing else.
//
// The answer is a `Response`, the same shape every call site already reads
// (`res.ok`, `res.status`, `res.json()`), so this is a rename in those files and
// not a rewrite of fifteen guards. Each caller gets its own clone: a body can be
// read once, and there are many readers.
// =============================================================================

/** How long an answer may be reused. See the note above — keep it small. */
export const CURRENT_USER_TTL_MS = 2_000;

/** Where every page's guard looks for the session. */
export const CURRENT_USER_PATH = "/api/auth/me";

interface Waiter {
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
}

interface Entry {
  at: number;
  /**
   * The answer, once it is here.
   *
   * Held because the callers do not arrive together: the Header asks on mount
   * and the page's guard runs a tick later. A entry that only remembered its
   * waiters gave a late caller a promise nothing would ever resolve — the page
   * kept its spinner up while the answer sat in the previous request. Callers
   * arriving after the answer get a clone of it and no second request.
   */
  settled: Response | null;
  waiters: Waiter[];
}

let entry: Entry | null = null;

/**
 * Who is signed in, shared with everyone who asks at the same time.
 *
 * Never throws for the caller beyond what `fetch` itself throws: a signed-out
 * visitor is a 401 *response*, not an exception, and every call site already
 * handles that status.
 */
export function fetchCurrentUser(): Promise<Response> {
  const now = Date.now();
  const current = entry;

  if (current && now - current.at < CURRENT_USER_TTL_MS) {
    // Cloned before anybody consumes the original, so one caller's `.json()`
    // does not take the body away from the next.
    if (current.settled) return Promise.resolve(current.settled.clone());
    return subscribe(current);
  }

  const fresh: Entry = { at: now, settled: null, waiters: [] };
  entry = fresh;

  fetch(CURRENT_USER_PATH)
    .then((response) => {
      fresh.settled = response;
      for (const waiter of fresh.waiters) waiter.resolve(response.clone());
    })
    .catch((error: unknown) => {
      // A failure is not remembered: a network that blipped must not sign people
      // out of a session that is fine for the next two seconds.
      if (entry === fresh) entry = null;
      for (const waiter of fresh.waiters) waiter.reject(error);
    })
    // A failed request must not surface as an unhandled rejection: the waiters
    // above are the only callers, and each of them has already been told.
    .catch(() => {});

  return subscribe(fresh);
}

function subscribe(target: Entry): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    target.waiters.push({ resolve, reject });
  });
}

/**
 * Forget the answer now.
 *
 * Called when the answer changes for a reason this module cannot see: a sign-in
 * and a sign-out. Without it, a fan who submits the login form within the window
 * can keep looking at a header that says "Sign in" — the fresh session, reported
 * by a stale 401.
 */
export function forgetCurrentUser(): void {
  entry = null;
}

/** For tests: how many readers are waiting on the shared answer. */
export function currentUserWaiters(): number {
  return entry?.waiters.length ?? 0;
}
