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
// They are a row in the database (BackgroundVideoAsset), not a file. The clip
// used to be written to `public/uploads/site/` and streamed back off the disk,
// which is the one place it cannot survive: the deployment's filesystem is
// read-only apart from a per-instance /tmp, and a function's request and
// response bodies are both capped at 4.5 MB. That is also why the ceiling here
// is a few megabytes and not the hundreds it once was — see
// MAX_BACKGROUND_VIDEO_BYTES.
//
// The token is the whole security boundary on the bytes. It is generated as 24
// hex characters on upload and re-checked against that pattern on every read,
// and the MIME type is checked against an allowlist this file owns rather than
// trusted from anything the caller sent. The token is the key bytes are read
// from, so a row naming a path, a host, or a token of the wrong shape resolves
// to "no clip" instead of to bytes of its choosing.
// =============================================================================

/**
 * The ceiling on an upload, in bytes.
 *
 * 4 MB, and the number is not a preference — it is the deployment's own limit
 * with room to spare. The clip is carried through a serverless function in both
 * directions (the browser posts it, the layer downloads it), and that payload is
 * capped at 4.5 MB whichever way it is going. 4 MB keeps a margin for headers
 * and for the JSON answer that follows a rejected upload, on a platform that
 * refuses an oversized body with a 413 whose body is not even JSON.
 *
 * It is also the right size for what this is. A backdrop loops behind a page a
 * visitor is reading; ten to twenty seconds of 720p footage is one to three
 * megabytes, and every megabyte past that is spent on somebody's phone to
 * decorate a page they did not come here to look at.
 */
export const MAX_BACKGROUND_VIDEO_BYTES = 4 * 1024 * 1024; // 4 MB

/** The same ceiling, written the way the interface says it. */
export const MAX_BACKGROUND_VIDEO_LABEL = "4 MB";

/**
 * The most bytes one RANGED response may carry.
 *
 * The serving route hands out a clip a range at a time, and a range may ask for
 * all of it (`bytes=0-`, which is the first request every `<video>` makes). The
 * platform caps a function's RESPONSE at 4.5 MB, so a clip at the ceiling could
 * be answered in one piece only while the ceiling stays below that — a margin
 * nobody would remember when raising it. This is that margin, written down.
 *
 * A request that carried no Range at all is answered whole, and is safe for the
 * same reason: the ceiling itself is already below the platform's limit.
 *
 * Answering with a SHORTER range than was asked for is ordinary HTTP: the 206
 * carries the range actually sent, and the browser asks for the rest from that
 * offset, which is the same mechanism it uses for a clip it has not finished
 * downloading. For a 4 MB backdrop this splits the first play into two requests
 * and changes nothing else.
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
 * Where the clip is read from, or null if this row cannot name one.
 *
 * Pure string work on purpose — see the header. The caller looks the token up
 * as a primary key; nothing else about the row reaches the query, so a row
 * carrying a path, a script or a token of the wrong length cannot address
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
 * Does the head of the file look like one of the containers we claimed?
 *
 * A MIME type and an extension are both claims the sender makes; these are the
 * bytes. Every accepted container starts with a marker that is hard to
 * accidentally produce: `ftyp` at offset 4 for MP4/MOV, the EBML magic for the
 * Matroska family (WebM is Matroska). Checked once, on the first bytes read,
 * which costs nothing and means an executable wearing a .mp4 name is never
 * stored under a video's content type.
 */
export function looksLikeBackgroundVideo(head: Uint8Array, extension: string): boolean {
  if (extension === ".mp4" || extension === ".mov") {
    // 4 bytes of box length, then the box type. Needs the first 8 bytes.
    return (
      head.length >= 8 &&
      head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70
    );
  }

  if (extension === ".webm" || extension === ".mkv") {
    // 1A 45 DF A3 — the EBML header every Matroska container opens with.
    return (
      head.length >= 4 &&
      head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3
    );
  }

  return false;
}
