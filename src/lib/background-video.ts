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
// a filesystem shim in the browser bundle. Path building is plain string work
// for exactly that reason; only the routes touch the disk.
//
// The token is the whole security boundary on the path. It is generated as 24
// hex characters on upload, re-checked against that pattern on every read, and
// the extension is looked up from a MIME type this file allowlists rather than
// taken from anything the caller sent. So the stored path can only ever be
// `public/uploads/site/background-<24 hex><known extension>` — a filename
// arriving from a database row cannot walk out of the directory.
// =============================================================================

/**
 * The ceiling on an upload, in bytes.
 *
 * 800 MB is what the operator asked for, and it is a deliberately generous
 * ceiling rather than a suggestion: the route enforces it while streaming, so a
 * client that ignores this number still cannot fill the disk. It is a
 * background layer, not a catalogue — the file is a few minutes of looping
 * footage at most, and anything near this cap is already far past what a phone
 * should be downloading to paint a page.
 */
export const MAX_BACKGROUND_VIDEO_BYTES = 800 * 1024 * 1024; // 800 MB

/** The same ceiling, written the way the interface says it. */
export const MAX_BACKGROUND_VIDEO_LABEL = "800 MB";

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
 * cache-buster in the URL and the id of the file on disk, and it changes
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
  /** Bytes on disk. */
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
 * Called on every read of a stored row and on every range request, because the
 * token is interpolated into the path the file is opened from. A row that was
 * hand-edited, truncated or written by something else must resolve to "no file"
 * rather than to a path of the editor's choosing.
 */
export function isBackgroundToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

/**
 * The URL the browser plays, or "" when there is nothing to play.
 *
 * The version query is what makes a replacement take effect: the path never
 * changes, so a cached copy of the old clip would otherwise outlive the admin
 * who replaced it. With the token in the URL, a new file is a new address and
 * the old one can be cached forever.
 */
export function backgroundVideoUrl(video: BackgroundVideo | null | undefined): string {
  if (!video?.active || !isBackgroundToken(video.token)) return "";
  if (!BACKGROUND_VIDEO_TYPES[video.mimeType]) return "";
  return `/api/site/background-video?v=${video.token}`;
}

/**
 * Where the file lives, relative to the project root, or null if this row
 * cannot name a file this app would have written.
 *
 * Pure string building on purpose — see the header. The caller joins it onto
 * the project root and opens it; nothing else about the row reaches the disk.
 */
export function backgroundVideoRelativePath(
  video: Pick<BackgroundVideo, "token" | "mimeType"> | null | undefined
): string | null {
  if (!video) return null;
  if (!isBackgroundToken(video.token)) return null;
  const extension = BACKGROUND_VIDEO_TYPES[video.mimeType];
  if (!extension) return null;
  return `public/uploads/site/background-${video.token}${extension}`;
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
 * The reason this file cannot be uploaded, or null if it can.
 *
 * Checked in the browser before a single byte leaves the device — the server
 * enforces the same two rules again, but a person who is told now has not just
 * waited out an 800 MB transfer to be told no.
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
