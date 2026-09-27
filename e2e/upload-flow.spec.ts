// =============================================================================
// GENHUB - the trimmer where the creator actually meets it
//
// The spec next door proves VideoTrimmer works in isolation. This one proves the
// thing the creator cares about: that picking a file on the real upload page
// opens the cutter, and that the file which then travels to Bunny is the CUT —
// not the original with its false starts still attached. That is the whole
// reason the trimmer exists, and it is a claim about two components and an
// upload client agreeing with each other, which no unit test can make.
//
// The page is served by the app's own dev server, so the layout, the route and
// the module graph are real. Only the three things a test cannot own are
// answered here: who is signed in, the upload slot Bunny would reserve, and the
// TUS endpoint the bytes would go to. Everything between the file picker and
// those answers — the guideline gate, the trimmer, the re-encode, the upload
// client, the form — runs for real.
// =============================================================================

import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { APP_URL } from "../playwright.config";

/** The cookie middleware asks for; must match config.cookieName's default. */
const COOKIE_NAME = "genhub_token";
/** Must match the id in the /api/auth/me answer below — the gate is per account. */
const USER_ID = "creator-under-test";
/** Must match GUIDELINE_ACK_STORAGE_KEY and CREATOR_GUIDELINES_VERSION. */
const GUIDELINE_KEY = "genhub.creatorGuidelines.v1";
const GUIDELINE_VERSION = 2;

const FIXTURE = path.resolve("e2e/fixtures/short.webm");
const FIXTURE_SIZE = 240_086;

/** A same-origin stand-in for Bunny's TUS endpoint, so no CORS is involved. */
const TUS_PATH = "/api/fake-tus";
const TUS_ENDPOINT = `${APP_URL}${TUS_PATH}`;

/** Everything a creator's upload leaves on the wire, for the assertions. */
interface Wire {
  /** `key base64value,…` from the reserve call. */
  metadata: string | null;
  /** `Upload-Length` — what the client said it would send. */
  declaredLength: string | null;
  /** The bytes that were actually PATCHed. */
  bytes: Buffer | null;
  /** Body of POST /api/videos, when the form was submitted. */
  created: Record<string, unknown> | null;
  /** Body of POST /api/videos/upload-signature. */
  reserved: Record<string, unknown> | null;
}

/** Read the TUS `Upload-Metadata` header back into its fields. */
function decodeMetadata(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (header ?? "").split(",")) {
    const [key, value] = pair.split(" ");
    if (!key) continue;
    out[key] = value ? Buffer.from(value, "base64").toString("utf8") : "";
  }
  return out;
}

/** Every WebM/Matroska file starts with the EBML magic. */
function isEbml(bytes: Buffer | null): boolean {
  return (
    bytes !== null &&
    bytes.length > 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  );
}

/** Answer the three things the page would ask a server for. */
async function stubBackend(page: Page, wire: Wire) {
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          id: USER_ID,
          role: "CREATOR",
          kycStatus: "APPROVED",
          displayName: "Creator Under Test",
        },
      },
    })
  );

  await page.route("**/api/videos/upload-signature", async (route) => {
    wire.reserved = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      json: {
        success: true,
        data: {
          videoId: "bunny-video-1",
          libraryId: "12345",
          endpoint: TUS_ENDPOINT,
          signature: "signature",
          expirationTime: Math.floor(Date.now() / 1000) + 3600,
        },
      },
    });
  });

  // The whole TUS protocol on one endpoint: reserve the slot on POST, capture
  // the bytes on the PATCH that fills it, and answer the resumable HEAD. The
  // PATCH body IS the file, and this is where that is kept.
  //
  // Matched with a URL predicate rather than a glob: a Playwright `*` never
  // crosses a `/`, so `**/api/fake-tus*` silently misses `/api/fake-tus/1` and
  // the PATCH would escape to the dev server for a 404.
  await page.route(
    (url) => url.pathname.startsWith(TUS_PATH),
    async (route) => {
      const request = route.request();

      if (request.method() === "POST") {
        const headers = request.headers();
        wire.metadata = headers["upload-metadata"] ?? null;
        wire.declaredLength = headers["upload-length"] ?? null;
        await route.fulfill({
          status: 201,
          headers: { Location: `${TUS_ENDPOINT}/1` },
          body: "",
        });
        return;
      }

      if (request.method() === "PATCH") {
        const body = request.postDataBuffer();
        wire.bytes = body;
        await route.fulfill({
          status: 204,
          headers: { "Upload-Offset": String(body?.length ?? 0) },
          body: "",
        });
        return;
      }

      // HEAD is the resume probe, and nothing has landed yet.
      await route.fulfill({ status: 200, headers: { "Upload-Offset": "0" }, body: "" });
    }
  );

  await page.route("**/api/videos", async (route) => {
    wire.created = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      json: { success: true, data: { id: "video-1", encodingStatus: null } },
    });
  });
}

test.describe("the creator upload page", () => {
  // The dev server compiles the route on first visit, and a 3-second cut is a
  // 3-second recording.
  test.describe.configure({ timeout: 180_000 });

  let wire: Wire;

  test.beforeEach(async ({ page }) => {
    wire = { metadata: null, declaredLength: null, bytes: null, created: null, reserved: null };

    // Middleware redirects an unauthenticated visitor away from the dashboard,
    // so the session has to exist before the first request.
    await page.context().addCookies([
      { name: COOKIE_NAME, value: "browser-test-session", url: APP_URL },
    ]);

    // Two gates stand in front of the form, and both are answered from local
    // storage: the age verification wall over the whole app, and the creator
    // guidelines, which are a one-time read per account and per version.
    await page.addInitScript(
      ({ key, id, version }) => {
        try {
          localStorage.setItem("genhub-age-verified", "true");
          localStorage.setItem(key, JSON.stringify({ [id]: version }));
        } catch {
          /* an opaque origin has no storage, and nothing to gate */
        }
      },
      { key: GUIDELINE_KEY, id: USER_ID, version: GUIDELINE_VERSION }
    );

    await stubBackend(page, wire);
  });

  test("cuts the video and uploads exactly the cut file", async ({ page }) => {
    await page.goto(`${APP_URL}/creator/upload`);

    const videoInput = page.locator(
      'label:has-text("Click here to upload your video") input[type="file"]'
    );
    await expect(videoInput).toHaveCount(1);
    await videoInput.setInputFiles(FIXTURE);

    // Picking a file opens the cutter rather than the upload.
    await expect(page.getByRole("button", { name: "Drag to cut" })).toBeVisible();

    // Keep three of the fixture's six seconds.
    await page.getByRole("slider", { name: "Clip start" }).press("ArrowRight");
    const end = page.getByRole("slider", { name: "Clip end" });
    await end.press("ArrowLeft");
    await end.press("ArrowLeft");
    await expect(page.getByText(/Keeping 0:03 of 0:06/)).toBeVisible();

    await page.getByRole("button", { name: /Upload cut \(0:03\)/ }).click();

    // The creator is told the upload happened, in the form's own words.
    await expect(page.getByText("Video uploaded successfully!")).toBeVisible({
      timeout: 60_000,
    });
    // That banner appears the moment the slot is reserved, so wait for the bytes
    // themselves rather than assuming they have already arrived.
    await expect.poll(() => wire.bytes?.length ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);

    // What went over the wire is a WebM, and it is not empty.
    expect(isEbml(wire.bytes)).toBe(true);
    expect(wire.bytes!.length).toBeGreaterThan(20_000);

    // It was declared as the cut, under the cut's own name — a viewer never
    // meets a file called "short-trimmed.webm" unless the trim actually ran.
    const metadata = decodeMetadata(wire.metadata);
    expect(metadata.filetype).toBe("video/webm");
    expect(metadata.title).toBe("short-trimmed.webm");

    // The declared length and the bytes that followed agree — a truncated
    // upload would have been accepted by Bunny and lost half the scene.
    expect(wire.declaredLength).toBe(String(wire.bytes!.length));

    // And it is not the original: the bytes on the wire are a different file.
    expect(wire.bytes!.length).not.toBe(FIXTURE_SIZE);

    // The slot was reserved once, for this upload.
    expect(wire.reserved).not.toBeNull();
  });

  test("uploading the full video sends the original, then creates it", async ({ page }) => {
    await page.goto(`${APP_URL}/creator/upload`);

    await page
      .locator('label:has-text("Click here to upload your video") input[type="file"]')
      .setInputFiles(FIXTURE);
    await expect(page.getByRole("button", { name: "Drag to cut" })).toBeVisible();

    // The escape hatch: nothing was cut, so nothing is re-encoded.
    await page.getByRole("button", { name: "Upload full video" }).click();
    await expect(page.getByText("Video uploaded successfully!")).toBeVisible({
      timeout: 60_000,
    });
    await expect.poll(() => wire.bytes?.length ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);

    expect(isEbml(wire.bytes)).toBe(true);
    expect(wire.bytes!.length).toBe(FIXTURE_SIZE);
    expect(decodeMetadata(wire.metadata).title).toBe("short.webm");

    // Now finish the form, the way a creator would.
    await page.getByPlaceholder("Enter video title...").fill("Test scene");
    await page
      .locator('label:has-text("I confirm that every person") input[type="checkbox"]')
      .check();
    await page.getByRole("button", { name: "Create Video" }).click();

    await expect(page.getByText("Video Uploaded!")).toBeVisible({ timeout: 30_000 });

    // The create call carries the reserved video and the attestation the server
    // refuses the upload without.
    expect(wire.created?.bunnyVideoId).toBe("bunny-video-1");
    expect(wire.created?.title).toBe("Test scene");
    expect(wire.created?.complianceAttested).toBe(true);
  });
});
