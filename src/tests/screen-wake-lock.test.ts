// =============================================================================
// GENHUB - Keeping the screen awake for an upload
//
// A suspended tab does not raise an error. It simply stops sending, which is why
// the creator's bar freezes with nothing to show for it — and why every rule
// below is worth pinning rather than trusting:
//
//   * the lock is requested BEFORE the reserve call, so the screen cannot lock
//     between the file picker and the first chunk;
//   * the browser drops the lock when the tab is hidden, so coming back has to
//     take it again — and only while a transfer is still running;
//   * a lock that arrives after a cancel is released rather than adopted;
//   * nothing here throws when the browser has no Wake Lock API at all, because
//     an optimisation that can fail an upload is not an optimisation.
//
// The environment is injected, which is the whole reason this is a module: the
// page was not testable, and the rules matter more than the four lines that
// called them.
// =============================================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ScreenWakeLock } from "@/lib/screen-wake-lock";

/** A sentinel that records whether the browser was told to let the screen go. */
class FakeSentinel {
  released = false;
  releaseCount = 0;

  async release() {
    this.released = true;
    this.releaseCount += 1;
  }
}

/**
 * A stand-in for `navigator` + `document` that behaves the way the real pair
 * does where it matters: hiding the tab drops the sentinel, and coming back
 * fires `visibilitychange`.
 */
function fakeBrowser(options: { supported?: boolean; refuse?: boolean } = {}) {
  const requests: FakeSentinel[] = [];
  const listeners = new Set<() => void>();
  /** Resolved by the test, to model a request that has not answered yet. */
  let deferred: ((sentinel: FakeSentinel) => void) | null = null;

  const environment = {
    navigator: options.supported === false
      ? {}
      : {
          wakeLock: {
            async request(_type: "screen") {
              if (options.refuse) throw new DOMException("refused", "NotAllowedError");
              if (deferred) {
                return await new Promise<FakeSentinel>((resolve) => {
                  deferred = (sentinel) => {
                    deferred = null;
                    resolve(sentinel);
                  };
                });
              }
              const sentinel = new FakeSentinel();
              requests.push(sentinel);
              return sentinel;
            },
          },
        },
    document: {
      hidden: false,
      addEventListener: (_type: "visibilitychange", listener: () => void) => void listeners.add(listener),
      removeEventListener: (_type: "visibilitychange", listener: () => void) => void listeners.delete(listener),
    },
  };

  return {
    environment,
    requests,
    listenerCount: () => listeners.size,
    /** The browser hiding the tab: it drops the lock, then tells the page. */
    hide: () => {
      environment.document.hidden = true;
      for (const sentinel of requests) sentinel.released = true;
      for (const listener of [...listeners]) listener();
    },
    show: () => {
      environment.document.hidden = false;
      for (const listener of [...listeners]) listener();
    },
    /** Start a request that answers only when the test says so. */
    hold: () => {
      deferred = () => {};
    },
    answerHeld: (sentinel: FakeSentinel) => {
      requests.push(sentinel);
      deferred?.(sentinel);
    },
  };
}

describe("holding the screen awake", () => {
  it("takes the lock and reports it held", async () => {
    const browser = fakeBrowser();
    const lock = new ScreenWakeLock(browser.environment);

    await expect(lock.acquire()).resolves.toBe(true);
    expect(lock.held).toBe(true);
    expect(browser.requests).toHaveLength(1);
  });

  it("does not ask twice while it already holds one", async () => {
    // Called on every chunk, so it has to be free. Two locks for one transfer
    // is a screen held awake by a request nobody will ever release.
    const browser = fakeBrowser();
    const lock = new ScreenWakeLock(browser.environment);

    await lock.acquire();
    await lock.acquire();
    await lock.acquire();

    expect(browser.requests).toHaveLength(1);
  });

  it("takes it again when the creator comes back to the tab", async () => {
    // The case the lock exists for: the phone locked, the browser dropped the
    // lock, and the transfer is still running underneath.
    const browser = fakeBrowser();
    const lock = new ScreenWakeLock(browser.environment);

    await lock.watch();
    expect(browser.requests).toHaveLength(1);

    browser.hide();
    // The browser's release is what makes this false — nothing in this module
    // gave it up.
    expect(lock.held).toBe(false);
    // A request made while hidden would be refused, so none is made.
    expect(browser.requests).toHaveLength(1);

    browser.show();
    await Promise.resolve();
    expect(browser.requests).toHaveLength(2);
    expect(lock.held).toBe(true);
  });

  it("does not take it back once the transfer has stopped", async () => {
    // Otherwise a creator who finished an upload and left the tab in the
    // background keeps the screen awake for nothing, indefinitely.
    const browser = fakeBrowser();
    const lock = new ScreenWakeLock(browser.environment);

    await lock.watch();
    lock.stop();

    browser.hide();
    browser.show();
    await Promise.resolve();

    expect(browser.requests).toHaveLength(1);
    expect(lock.held).toBe(false);
    expect(browser.listenerCount()).toBe(0);
  });

  it("releases the lock instead of adopting one that arrives after a cancel", async () => {
    const browser = fakeBrowser();
    const lock = new ScreenWakeLock(browser.environment);

    browser.hold();
    const pending = lock.acquire();
    // The creator pressed Cancel while the request was still in flight.
    lock.release();

    const sentinel = new FakeSentinel();
    browser.answerHeld(sentinel);
    await pending;

    expect(sentinel.releaseCount).toBe(1);
    expect(lock.held).toBe(false);
  });

  it("gives the lock back on stop", async () => {
    const browser = fakeBrowser();
    const lock = new ScreenWakeLock(browser.environment);

    await lock.acquire();
    lock.stop();

    expect(browser.requests[0].releaseCount).toBe(1);
    expect(lock.held).toBe(false);
  });

  it("survives a browser with no Wake Lock API at all", async () => {
    // Safari before 16.4, and every desktop browser that never shipped it. The
    // upload must simply continue; a rejected promise here would fail a
    // transfer whose bytes are perfectly fine.
    const browser = fakeBrowser({ supported: false });
    const lock = new ScreenWakeLock(browser.environment);

    await expect(lock.acquire()).resolves.toBe(false);
    await expect(lock.watch()).resolves.toBe(false);
    expect(() => lock.stop()).not.toThrow();
  });

  it("survives a browser that refuses the request", async () => {
    const browser = fakeBrowser({ refuse: true });
    const lock = new ScreenWakeLock(browser.environment);

    await expect(lock.acquire()).resolves.toBe(false);
    expect(lock.held).toBe(false);
  });
});

// =============================================================================
// The form's own half of the contract
//
// The module cannot pin WHEN the page asks: the ordering is the page's, and it
// is the whole point — a lock requested after the first chunk has left is a lock
// requested too late. The page is a React component with no renderer in this
// suite, so its source is asserted directly, the way this repository already
// checks the cron routes and the deployment workflows.
// =============================================================================

describe("the upload form's use of it", () => {
  const page = readFileSync(
    join(process.cwd(), "src", "app", "creator", "upload", "page.tsx"),
    "utf8"
  );

  /** The body of one top-level async function in the page. */
  function slice(from: string, to: string): string {
    const start = page.indexOf(from);
    const end = page.indexOf(to, start);
    expect(start, `${from} is not in the upload page`).toBeGreaterThan(-1);
    expect(end, `${to} is not after ${from}`).toBeGreaterThan(start);
    return page.slice(start, end);
  }

  it("keeps one instance for the page, not one per render", () => {
    expect(page).toContain("new ScreenWakeLock()");
    // A ref, because a second instance would hold a second lock and release
    // neither: the first would be lost on the re-render that created it.
    expect(page).toMatch(/useRef<ScreenWakeLock \| null>/);
  });

  it("asks for the lock before the slot is reserved", () => {
    // Reserve and the first PATCH are one transfer, and the first PATCH can be
    // in flight before the browser emits a single progress event — so \"ask when
    // progress starts\" asks too late, which is the fault this whole file is
    // about.
    const reserve = slice("async function startVideoUpload", "async function runVideoUpload");

    const asked = reserve.indexOf("await holdScreenAwake()");
    const reserved = reserve.indexOf("await initiateUpload()");

    expect(asked).toBeGreaterThan(-1);
    expect(reserved).toBeGreaterThan(-1);
    expect(asked).toBeLessThan(reserved);
  });

  it("asks for it before the first chunk is sent, on every path", () => {
    // The retry path reaches runVideoUpload without going through
    // startVideoUpload, so the request cannot live only in one of them.
    const upload = slice("async function runVideoUpload", "async function handleSubmit");

    const asked = upload.indexOf("await holdScreenAwake()");
    const sent = upload.indexOf("uploadToBunny(");

    expect(asked).toBeGreaterThan(-1);
    expect(sent).toBeGreaterThan(-1);
    expect(asked).toBeLessThan(sent);
  });

  it("watches for the tab coming back only while a transfer is running", () => {
    expect(page).toContain("void watchScreenWake()");
    // The two cannot branch differently: one effect, keyed on `transferring`.
    expect(page).toMatch(/if \(!transferring\)[\s\S]{0,400}releaseScreenWake\(\)/);
  });

  it("releases it on unmount, along with the upload itself", () => {
    // Leaving the page mid-transfer is a cancel, and a cancel that leaves an
    // invisible XHR running holds a lock and an orphaned slot behind it.
    expect(page).toMatch(
      /uploadAbortRef\.current\?\.abort\(\)[\s\S]{0,200}releaseScreenWake\(\)/
    );
  });

  it("never touches the Wake Lock API itself", () => {
    // One home for the rules (the module): a second `navigator.wakeLock.request`
    // here would be a second lifecycle to keep in step with this one, and the
    // one that drifts is the one nobody is looking at.
    expect(page).not.toContain("navigator.wakeLock");
  });
});