// =============================================================================
// GENHUB - Playwright configuration for the browser tests
//
// Scope: the places Vitest cannot reach. Everything in `src/**/*.test.ts` runs
// in Node with no DOM; the trimmer's real behaviour lives in a browser — a
// <video> element's duration, pointer capture on a drag, and MediaRecorder
// actually producing bytes. Those are what these specs exist to prove.
//
// One worker, no parallelism: each spec records video in real time, and two
// MediaRecorders competing for the same machine turn a 3-second clip into a
// flaky one.
// =============================================================================

import { defineConfig, devices } from "@playwright/test";

const PORT = 5199;
const BASE_URL = `http://127.0.0.1:${PORT}`;

/** The app's own dev server, for the spec that drives the real upload page. */
const APP_PORT = 3111;
export const APP_URL = `http://127.0.0.1:${APP_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  // A 3-second cut is a 3-second recording, plus seeking and the browser
  // warming up; the default 30s is close enough to be flaky on a slow machine.
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    video: "off",
    launchOptions: {
      args: [
        // The export calls play() from an async handler, after awaits — past
        // the point where a click still counts as user activation. Without
        // this the recording would be refused for reasons that have nothing to
        // do with the trimmer.
        "--autoplay-policy=no-user-gesture-required",
        // Headless has no sound device; keeping the graph silent avoids the
        // AudioContext stalling while the clip records.
        "--mute-audio",
      ],
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "npx vite --config e2e/vite.config.ts",
      url: `${BASE_URL}/e2e/harness/index.html`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      // The config is ESM in a file Vite would otherwise load as CommonJS; the
      // warning is noise in an otherwise quiet test run.
      env: { VITE_CONFIG_NATIVE_IGNORE_WARNING: "true" },
    },
    {
      // The real creator upload page, served by the app's own dev server. That
      // server compiles the page, its layout and its modules — everything but
      // the API calls, which the spec answers — so the trimmer is exercised in
      // the flow it actually ships in, not only on its own.
      command: `npx next dev -p ${APP_PORT}`,
      // A public page, so the readiness probe does not compile the whole upload
      // route before the first test even starts.
      url: `${APP_URL}/login`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
