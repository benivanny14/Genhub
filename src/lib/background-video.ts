// =============================================================================
// GENHUB - The site-wide background video (shared rules)
// =============================================================================
// An operator can put one clip behind the whole interface: a fixed layer at the
// very back of <body>, painted at z-index -11, so it sits UNDER the aurora, the
// grid and the vignette and is seen through every pane of glass on the page.
//
// This module holds the rules BOTH halves need — the admin's upload button and
// the layer that plays the result — and deliberately holds NO node built-ins:
// it is imported by client components, and a `node:path` import here would put
// a filesystem shim in the browser bundle. Every rule below is plain string,
// number and byte work for exactly that reason.
//
// WHERE THE BYTES LIVE
//
// In Cloudflare R2, reached by a signed URL the browser is handed — see
// lib/r2.ts and the two admin routes. They have been a file on disk (which the
// deployment cannot write), bytes in a function (which it will not carry past
// 4.5 MB) and a row in the database (which is no place for half a gigabyte), and
// an object store is the only one of those a 500 MB clip can actually use.
//
// The token is the whole security boundary on the bytes. It is generated as 24
// hex characters on upload and re-checked against that pattern on every read,
// and the MIME type is checked against an allowlist this file owns rather than
// trusted from anything the caller sent. The token and the type together are
// what the object's key is built from, so a row naming a path, a host, or a
// token of the wrong shape resolves to "no clip" instead of to somebody else's
// object.
//
// The bytes themselves are the one thing this module can no longer inspect: they
// go from the operator's browser straight to the bucket, so no code here ever
// sees the head of the file. What replaces that check is the destination — a URL
// this server signs for ONE key, under an allowlisted type, for one admin — and
// the fact that a clip nobody can decode is a clip the operator sees fail and
// replaces.
// =============================================================================

/**
 * The ceiling on an upload, in bytes.
 *
 * 500 MB, and it is reachable BECAUSE nothing large travels through this
 * application any more. The clip goes from the browser straight to Cloudflare R2
 * against a URL the server signs, and comes back from the CDN — so the 4.5 MB a
 * serverless function will accept in either direction is no longer the size of
 * the clip, it is only the size of the requests that sign and confirm it.
 *
 * It is a ceiling rather than a target, and a background clip is the one upload
 * where the operator should stay far below it: this loops behind a page a
 * visitor is reading, and every megabyte here is a megabyte of their data. Ten
 * to twenty seconds of 720p footage is a few megabytes and looks the same.
 */
export const MAX_BACKGROUND_VIDEO_BYTES = 500 * 1024 * 1024; // 500 MB

/** The same ceiling, written the way the interface says it. */
export const MAX_BACKGROUND_VIDEO_LABEL = "500 MB";

/**
 * The most bytes one response may carry.
 *
 * The clip may be 500 MB and the deployment refuses a function's response body
 * past 4.5 MB, so every answer is a bounded slice — including one that carried
 * no Range at all, because there is no way to send half a gigabyte in one piece.
 * (A bucket with a public hostname does not need this route at all: the serving
 * route redirects there and the CDN carries the clip.)
 *
 * Answering with a SHORTER range than was asked for is ordinary HTTP: the 206
 * carries the range actually sent, and the browser asks for the rest from that
 * offset — the same mechanism it already uses for a clip it has not finished
 * downloading. `bytes=0-` is the first request every `<video>` makes, so this is
 * the normal path, not an edge case.
 */
export const MAX_BACKGROUND_VIDEO_SLICE_BYTES = 2 * 1024 * 1024; // 2 MB

/**
 * The containers a background clip may be, and the extension each is stored as.
 *
 * Four, not "video/*": the extension is part of the path and the MIME is what
 * the browser is told to expect, so accepting a type here means accepting it as
 * something that will actually play. MP4 first because it is the one every
 * browser on every phone decodes; MOV and MKV are here because that is what
 * people's files are called, and a server that refuses the file a person has in
 * hand is a server that looks broken.
 */
export const BACKGROUND_VIDEO_TYPES: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "video/x-matroska": ".mkv",
};

/** The reverse map, for a picker that hands over a name and no MIME type. */
const EXTENSIONS: Record<string, { mimeType: string; extension: string }> = {
  mp4: { mimeType: "video/mp4", extension: ".mp4" },
  m4v: { mimeType: "video/mp4", extension: ".mp4" },
  webm: { mimeType: "video/webm", extension: ".webm" },
  mov: { mimeType: "video/quicktime", extension: ".mov" },
  qt: { mimeType: "video/quicktime", extension: ".mov" },
  mkv: { mimeType: "video/x-matroska", extension: ".mkv" },
};

/** What the file input offers. Extensions included: Android pickers send only those. */
export const BACKGROUND_VIDEO_ACCEPT = "video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov,.mkv";

/**
 * What the operator has set.
 *
 * `token` is not a secret and never leaves the server unvalidated — it is the
 * cache-buster in the URL and the key of the stored clip, and it changes
 * whenever the file is replaced so a new clip appears without a hard refresh.
 */
export interface BackgroundVideo {
  active: boolean;
  /** 24 hex characters. See `isBackgroundToken`. */
  token: string;
  /** One of `BACKGROUND_VIDEO_TYPES`. */
  mimeType: string;
  /** The name the operator chose, kept for their own card. Never used as a path. */
  name: string;
  /** Bytes stored. */
  size: number;
}

/** What a site with no background clip answers with. */
export const NO_BACKGROUND_VIDEO: BackgroundVideo = {
  active: false,
  token: "",
  mimeType: "",
  name: "",
  size: 0,
};

const TOKEN_PATTERN = /^[0-9a-f]{24}$/;

/**
 * Is this a token this app generated?
 *
 * Called on every read of a stored row and on every range request. A row that
 * was hand-edited, truncated or written by something else must resolve to "no
 * clip" rather than to a key of the editor's choosing.
 */
export function isBackgroundToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

/**
 * The extension a stored clip of this type is served as, or "" when the type is
 * not one we store. Used only to name the file in a download header — never as
 * part of an address.
 */
export function backgroundVideoExtension(mimeType: string): string {
  return BACKGROUND_VIDEO_TYPES[mimeType] ?? "";
}

/**
 * The URL the browser plays, or "" when there is nothing to play.
 *
 * The version query is what makes a replacement take effect: the address never
 * changes, so a cached copy of the old clip would otherwise outlive the admin
 * who replaced it. With the token in the URL, a new clip is a new address and
 * the old one can be cached forever.
 */
export function backgroundVideoUrl(video: BackgroundVideo | null | undefined): string {
  if (!video?.active || !isBackgroundToken(video.token)) return "";
  if (!BACKGROUND_VIDEO_TYPES[video.mimeType]) return "";
  return `/api/site/background-video?v=${video.token}`;
}

/**
 * The token that names the stored clip, or null if this row cannot name one.
 *
 * Pure string work on purpose — see the header. The caller turns this into an
 * object key with the media type; nothing else about the row reaches a store, so
 * a row carrying a path, a script or a token of the wrong length cannot address
 * anything at all.
 */
export function backgroundVideoAssetId(
  video: Pick<BackgroundVideo, "token" | "mimeType"> | null | undefined
): string | null {
  if (!video) return null;
  if (!isBackgroundToken(video.token)) return null;
  if (!BACKGROUND_VIDEO_TYPES[video.mimeType]) return null;
  return video.token;
}

export interface ResolvedBackgroundType {
  mimeType: string;
  extension: string;
}

/**
 * What a chosen file is, from the type the browser claims and the name it came
 * with, or null if it is not a container this route accepts.
 *
 * The name is only consulted when the browser said nothing useful — `file.type`
 * is empty for a good number of files dragged off a file manager, and refusing
 * a real MP4 because its picker had no opinion is the same bug the image route
 * already fixed for pictures.
 */
export function resolveBackgroundType(
  declaredType: string,
  fileName: string
): ResolvedBackgroundType | null {
  const type = (declaredType || "").split(";")[0].trim().toLowerCase();
  const direct = BACKGROUND_VIDEO_TYPES[type];
  if (direct) return { mimeType: type, extension: direct };

  const extension = /\.([A-Za-z0-9]{1,5})$/.exec((fileName || "").trim())?.[1]?.toLowerCase() ?? "";
  const byName = EXTENSIONS[extension];
  if (byName) return byName;

  return null;
}

/**
 * The ceiling, checked in the browser before a single byte leaves the device.
 *
 * Checked in the browser before a byte leaves the device — the server enforces
 * the same rules again, but a person who is told now has not just waited out a
 * transfer to be told no.
 */
export function backgroundVideoRefusal(file: {
  size: number;
  type?: string;
  name?: string;
}): string | null {
  if (!resolveBackgroundType(file.type ?? "", file.name ?? "")) {
    return "That is not a video this site can use. Choose an MP4, WebM, MOV or MKV file.";
  }
  if (file.size > MAX_BACKGROUND_VIDEO_BYTES) {
    return `That video is too large — the limit is ${MAX_BACKGROUND_VIDEO_LABEL}.`;
  }
  if (file.size === 0) {
    return "That file is empty.";
  }
  return null;
}

/**
 * What to say when the upload came back without an answer of ours.
 *
 * The route answers every refusal it makes with a JSON sentence, so anything
 * that reaches here is a failure on the way in or out: a body the platform
 * refused before the route ran, a session that expired, a rate limit. Those
 * arrive with a STATUS and, in the platform's case, with a body that is not even
 * JSON — which is exactly how an operator ends up looking at "The upload failed —
 * try again" for a file that is simply too big.
 *
 * So the status is interpreted here, once, for the one reason this module exists:
 * the sentence and the number it refers to cannot disagree about the ceiling.
 */
export function backgroundVideoUploadFailure(status: number): string {
  if (status === 413) {
    return `That video is too large — the limit is ${MAX_BACKGROUND_VIDEO_LABEL}.`;
  }
  if (status === 401 || status === 403) {
    return "Your session has expired. Sign in again, then upload the video.";
  }
  if (status === 429) {
    return "Too many uploads for now — wait a few minutes and try again.";
  }
  if (status >= 500) {
    return "The server could not store that video. Please try again in a moment.";
  }
  return "The upload failed. Please try again.";
}

/**
 * What to say when the clip could not be handed to the bucket.
 *
 * A different failure from `backgroundVideoUploadFailure`: that one covers the
 * requests that go to THIS app, and this one covers the PUT that goes straight
 * to storage against a signed URL. They need different sentences because they
 * have different fixes — a 403 here means the signature was refused or has
 * expired, not that the session ended, and telling an operator to sign in again
 * would send them to fix the wrong thing.
 */
export function backgroundVideoStoreFailure(status: number): string {
  if (status === 401 || status === 403) {
    return "The upload link was refused or has expired. Press Upload video to start again.";
  }
  if (status === 413) {
    return `That video is too large — the limit is ${MAX_BACKGROUND_VIDEO_LABEL}.`;
  }
  // Zero is the browser declining to make the request at all, and there are two
  // causes that are indistinguishable from inside XMLHttpRequest: no usable
  // connection, and a bucket whose CORS policy does not name this site — a
  // refused preflight produces the same silent `onerror` with no status and no
  // body. Naming only the network sends an operator to check the one thing that
  // is usually fine, so both are said out loud.
  if (status === 0) {
    return "The browser could not reach the video store. Check your connection — and if that is fine, the store is refusing this site's address, so tell support.";
  }
  return "The video could not be sent to storage. Please try again in a moment.";
}

