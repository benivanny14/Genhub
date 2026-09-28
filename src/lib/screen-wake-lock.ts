// =============================================================================
// GENHUB - Holding the screen awake for the length of a transfer
//
// This is the commonest reason a phone upload dies halfway, and it is not a
// network fault at all. Locking the screen or switching apps suspends the tab,
// and a suspended tab stops sending: the in-flight PATCH freezes with no error
// event, so the browser reports neither success nor failure and the progress bar
// simply stops. The creator comes back to a bar that has not moved, waits out
// the stall window, and gives up on a file that was one chunk from done.
//
// WHY A MODULE AND NOT A FEW LINES IN THE PAGE
//
// The rules are not obvious and each one is load-bearing:
//
//   * the lock is requested BEFORE the reserve call, not when progress starts —
//     the first PATCH can be in flight before the browser emits a single
//     progress event, and the screen must not be free to lock in that window;
//   * a hidden tab has its lock released BY THE BROWSER, so coming back to the
//     page has to take it again — and only while a transfer is still running;
//   * a lock that arrives after the upload was cancelled has to be released
//     rather than adopted, or the screen stays awake for nothing;
//   * the API does not exist in every browser and its request can be refused
//     (a hidden tab, a low battery), and neither is an error worth showing.
//
// All four are decisions, and decisions belong somewhere they can be pinned by
// a test. The page keeps the hook; this keeps the rule.
//
// The environment is injected so the rules can be checked without a browser:
// `new ScreenWakeLock({ navigator, document })` takes any object with the two
// methods this needs, and `globalThis` is used only when nothing is passed.
// =============================================================================

export interface WakeLockSentinelLike {
  /** True once the browser has dropped it — which it does when the tab hides. */
  released: boolean;
  release(): Promise<void> | void;
}

export interface WakeLockHostLike {
  wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> };
}

export interface VisibilityHostLike {
  hidden?: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface ScreenWakeLockEnvironment {
  navigator?: WakeLockHostLike;
  document?: VisibilityHostLike;
}

/**
 * The real browser, or nothing at all when there is none (SSR, a test runner).
 *
 * Deliberately reads the globals rather than the page passing them in: a caller
 * that forgot to would silently lose the lock, and losing it is invisible — the
 * upload still works, it just survives less.
 */
function defaultEnvironment(): ScreenWakeLockEnvironment {
  const env: ScreenWakeLockEnvironment = {};
  if (typeof navigator !== "undefined") env.navigator = navigator as unknown as WakeLockHostLike;
  if (typeof document !== "undefined") env.document = document as unknown as VisibilityHostLike;
  return env;
}

/**
 * Holds a screen wake lock for as long as a transfer is running.
 *
 * Lifecycle, exactly: `watch()` when bytes start moving, `acquire()` before the
 * reserve call, `stop()` on success, failure, cancel or unmount.
 */
export class ScreenWakeLock {
  private sentinel: WakeLockSentinelLike | null = null;
  /** A request currently in flight, so two callers cannot create two locks. */
  private pending: Promise<void> | null = null;
  /** Whether anyone still wants the screen awake. Cleared by release(). */
  private wanted = false;
  private listening = false;

  private readonly onVisibilityChange = () => {
    // Only coming BACK matters. The browser has already dropped the lock on the
    // way out, and a request made while hidden is refused.
    if (this.wanted && !this.env.document?.hidden) void this.acquire();
  };

  constructor(private readonly env: ScreenWakeLockEnvironment = defaultEnvironment()) {}

  /** True only while a lock this class took is still held by the browser. */
  get held(): boolean {
    return this.sentinel !== null && !this.sentinel.released;
  }

  /**
   * Ask for the lock, and mean it: from here until `release()`, a lock that
   * arrives late is adopted and a lock dropped by the browser is taken again.
   *
   * Idempotent — calling it on every chunk is free — and it never throws, so it
   * can be awaited in the middle of an upload path without a try/catch around
   * something that is only an optimisation.
   */
  async acquire(): Promise<boolean> {
    this.wanted = true;
    if (this.held) return true;

    // A lock the browser has already dropped is not worth keeping a reference
    // to; forgetting it here is what lets the request below be made again.
    if (this.sentinel?.released) this.sentinel = null;

    // A hidden tab cannot hold a screen lock, and asking anyway is a rejection
    // the browser logs. `onVisibilityChange` will make the request when the
    // creator comes back.
    if (this.env.document?.hidden) return false;

    const api = this.env.navigator?.wakeLock;
    if (!api) return false;

    if (!this.pending) {
      this.pending = (async () => {
        let sentinel: WakeLockSentinelLike | null = null;
        try {
          sentinel = await api.request("screen");
        } catch {
          // Unsupported, refused, or the tab was hidden in between. The upload
          // works without it; see the header.
          sentinel = null;
        }

        // Cancelled while the request was in flight: release rather than adopt,
        // or the screen is held awake for an upload that is no longer running.
        if (sentinel && !this.wanted) {
          try {
            await sentinel.release();
          } catch {
            /* already dropped */
          }
          sentinel = null;
        }

        this.sentinel = sentinel;
      })().finally(() => {
        this.pending = null;
      });
    }

    await this.pending;
    return this.held;
  }

  /**
   * Start (or keep) watching for the tab coming back, and take the lock now.
   *
   * Registered once per transfer; `stop()` removes it, so a page that is sat on
   * for an hour does not accumulate listeners.
   */
  async watch(): Promise<boolean> {
    this.wanted = true;
    if (!this.listening) {
      this.env.document?.addEventListener("visibilitychange", this.onVisibilityChange);
      this.listening = true;
    }
    return this.acquire();
  }

  /** Stop re-taking the lock, keeping whatever is held. */
  unsubscribe(): void {
    if (!this.listening) return;
    this.env.document?.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.listening = false;
  }

  /** Give the lock back. Safe to call when nothing is held, or twice. */
  release(): void {
    this.wanted = false;
    const sentinel = this.sentinel;
    this.sentinel = null;
    try {
      void sentinel?.release();
    } catch {
      // The browser already released it (a hidden tab does this), and a
      // rejected release is not worth a line on the creator's screen.
    }
  }

  /**
   * The whole thing, backwards: stop watching and give the lock back.
   *
   * One call rather than two at each of the four places a transfer can end —
   * success, failure, cancel, unmount — because a caller that remembers only
   * one of them leaks a screen lock instead of failing visibly.
   */
  stop(): void {
    this.unsubscribe();
    this.release();
  }
}
