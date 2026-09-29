// =============================================================================
// GENHUB - Where an interrupted upload remembers what already arrived
//
// A part is 8 MiB and a 2 GiB video is 256 of them. On the connection this was
// built for — 1.55 Mbps, measured from this application's own failure records —
// that is two hours of transfer, and a phone will reload the tab, switch apps or
// lose signal long before then. Without a record of which parts the bucket
// already holds, every one of those events starts again from nothing, which is
// exactly the fault the parts exist to end.
//
// STORAGE: localStorage, one record.
//
//   * Not IndexedDB. The payload is a list of part numbers and ETags — a 2 GiB
//     file is about 20 KB of JSON — written a few hundred times at most. An
//     asynchronous store with transactions is a great deal more code than this
//     needs, and this module is on the one path where an exception must never
//     escape.
//   * Not the server. The server keeps no multipart state on purpose (the bucket
//     does), and a table would put a migration in the way of a transport change.
//   * Not nothing. A resume that only works while the tab stays open does not
//     cover the case that caused this work: a creator on a phone.
//
// THE RECORD IS TIED TO THE FILE, not to the slot. A browser cannot re-open the
// file it was given — only a fresh pick produces a File — so a resume is only
// ever offered when the creator picks the SAME file again: same name, same size,
// same last-modified. That triple is what `uploadIdentity` is, and it is
// deliberately conservative: resuming into a different file would assemble a
// video out of two of them.
//
// THE RECORD EXPIRES. An upload id the bucket has abandoned — R2 cleans up
// unfinished multipart uploads on its own schedule — can only fail every part, so
// a day-old record is dropped rather than offered. The window is generous because
// the failure it guards against (an abandoned id) is reported clearly by the
// bucket, while the failure of dropping a good record (resending everything) is
// silent and expensive.
// =============================================================================

import type { CompletedPart } from "./upload-target";

const KEY = "genhub.multipart.resume";

/** How long a record stays worth offering (ms). */
const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface MultipartResume {
  /** `name|size|lastModified` — see the header. */
  identity: string;
  videoId: string;
  uploadId: string;
  key: string;
  partSizeBytes: number;
  partCount: number;
  fileSize: number;
  fileName: string;
  /** Parts the bucket has acknowledged, in no particular order. */
  parts: CompletedPart[];
  /** When it was last written, ms since epoch. */
  at: number;
}

function storage(): Storage | null {
  try {
    // Absent on the server, and absent again in a browser with site data
    // blocked. Both are ordinary, and neither should stop an upload.
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * What makes two picks the same file.
 *
 * `lastModified` is included because name and size together are not unique (two
 * exports of the same clip, a re-encoded file of the same length), and a resume
 * that assembles a video from two different files is worse than a resume that
 * never happens.
 */
export function uploadIdentity(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

/** Write the record. Never throws: a browser that refuses storage is not a fault. */
export function saveMultipartResume(state: Omit<MultipartResume, "at">): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(KEY, JSON.stringify({ ...state, at: Date.now() }));
  } catch {
    // Full, or blocked, or private mode. See the header — this is a debugging
    // aid for one upload, not a record anything depends on.
  }
}

/**
 * The record for this file, when there is one worth using.
 *
 * Returns null for anything it cannot fully trust — a different file, an expired
 * record, a shape written by an older build — because every one of those would
 * resume into an upload that cannot be completed.
 */
export function loadMultipartResume(identity: string): MultipartResume | null {
  const store = storage();
  if (!store) return null;

  try {
    const raw = store.getItem(KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<MultipartResume> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.identity !== identity) return null;
    if (typeof parsed.uploadId !== "string" || !parsed.uploadId) return null;
    if (typeof parsed.videoId !== "string" || !parsed.videoId) return null;
    if (typeof parsed.partCount !== "number" || parsed.partCount < 1) return null;
    if (typeof parsed.partSizeBytes !== "number" || parsed.partSizeBytes < 1) return null;
    if (typeof parsed.fileSize !== "number" || parsed.fileSize < 1) return null;
    if (typeof parsed.at !== "number" || Date.now() - parsed.at > RESUME_WINDOW_MS) return null;

    const parts = Array.isArray(parsed.parts)
      ? parsed.parts.filter(
          (part): part is CompletedPart =>
            !!part &&
            typeof part === "object" &&
            Number.isInteger((part as CompletedPart).partNumber) &&
            typeof (part as CompletedPart).etag === "string" &&
            (part as CompletedPart).etag.length > 0
        )
      : [];

    return {
      identity: parsed.identity,
      videoId: parsed.videoId,
      uploadId: parsed.uploadId,
      key: typeof parsed.key === "string" ? parsed.key : "",
      partSizeBytes: parsed.partSizeBytes,
      partCount: parsed.partCount,
      fileSize: parsed.fileSize,
      fileName: typeof parsed.fileName === "string" ? parsed.fileName : "",
      parts,
      at: parsed.at,
    };
  } catch {
    return null;
  }
}

/** Forget the record — after a completed upload, or after a cancel. */
export function clearMultipartResume(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(KEY);
  } catch {
    /* see saveMultipartResume */
  }
}
