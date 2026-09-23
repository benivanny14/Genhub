// =============================================================================
// GENHUB - TUS 1.0.0 direct upload to Bunny Stream
//
// Why this exists instead of a single PUT:
//
//   1. Bunny's management endpoint authenticates with the `AccessKey` header. A
//      browser PUT without it is a 401 (verified against the live API), and
//      shipping the key to clients would let anyone delete or replace every
//      video in the library. So the bytes do NOT go to the management API.
//   2. Bunny's TUS endpoint accepts a per-video presigned signature instead, so
//      the browser uploads directly to Bunny while the key stays on the server.
//   3. Uploads are chunked and recoverable. Genhub's audience is on mobile
//      networks: a 700 MB upload that dies at 90% must resume, not restart.
//
// The protocol surface used here is small and fixed by the TUS spec:
//   POST  endpoint  -> 201 + Location (reserve)
//   PATCH location  -> 204 + Upload-Offset (send a chunk)
//   HEAD  location  -> 200 + Upload-Offset (ask where to resume)
// =============================================================================

import type { BunnyUploadCredentials } from "./bunny";

/** Chunk size. TUS requires a multiple of 256 KiB; 32 MiB keeps requests few. */
const CHUNK_SIZE = 32 * 1024 * 1024;

/** Backoff between attempts at the SAME chunk, in ms. */
const RETRY_DELAYS = [0, 1_000, 3_000, 8_000];

export type TusErrorCode =
  | "NOT_CONFIGURED"
  | "EXPIRED"
  | "REJECTED"
  | "NETWORK"
  | "ABORTED"
  | "UNSUPPORTED";

export class TusUploadError extends Error {
  code: TusErrorCode;
  status?: number;

  constructor(code: TusErrorCode, message: string, status?: number) {
    super(message);
    this.name = "TusUploadError";
    this.code = code;
    this.status = status;
  }
}

/** UTF-8 safe base64 — titles can contain characters btoa() refuses. */
function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** `key base64value,key base64value` — the format TUS Upload-Metadata expects. */
export function encodeUploadMetadata(entries: Record<string, string>): string {
  return Object.entries(entries)
    .map(([key, value]) => `${key} ${base64(value)}`)
    .join(",");
}

/**
 * Bunny requires these on EVERY request to the TUS endpoint, not just the reserve
 * call. A plain TUS client that sends the Location alone gets
 * `400 Library ID missing or invalid.` on the first PATCH — which is exactly
 * what happened when this was wired up, so they are attached centrally here.
 */
function authHeaders(credentials: BunnyUploadCredentials): Record<string, string> {
  return {
    AuthorizationSignature: credentials.signature,
    AuthorizationExpire: String(credentials.expirationTime),
    LibraryId: credentials.libraryId,
    VideoId: credentials.videoId,
  };
}

/**
 * Turn a Bunny/socket failure into something a creator can act on. The 401 case
 * is called out by name because Bunny's own docs list an expired authorization
 * as the most common cause, and "Upload failed" sends people hunting for the
 * wrong problem.
 */
function describe(status: number, body: string): TusUploadError {
  if (status === 401 || status === 403) {
    return new TusUploadError(
      "REJECTED",
      "Bunny rejected the upload authorization (it may have expired). Please retry the upload.",
      status
    );
  }
  if (status === 413) {
    return new TusUploadError(
      "UNSUPPORTED",
      "Bunny refused the file as too large for this plan.",
      status
    );
  }
  return new TusUploadError(
    "NETWORK",
    `Upload failed (HTTP ${status})${body ? `: ${body.slice(0, 160)}` : ""}`,
    status
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new TusUploadError("ABORTED", "Upload cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Reserve the upload and return the URL the chunks are PATCHed to. */
async function createUpload(
  file: File,
  credentials: BunnyUploadCredentials
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(credentials.endpoint, {
      method: "POST",
      headers: {
        "Tus-Resumable": "1.0.0",
        "Upload-Length": String(file.size),
        "Upload-Metadata": encodeUploadMetadata({
          filetype: file.type || "video/mp4",
          title: file.name || "Untitled video",
        }),
        ...authHeaders(credentials),
      },
    });
  } catch {
    throw new TusUploadError(
      "NETWORK",
      "Could not reach the upload server. Check your connection and retry."
    );
  }

  if (res.status !== 201 && !res.ok) {
    throw describe(res.status, await res.text().catch(() => ""));
  }

  const location = res.headers.get("Location");
  if (!location) {
    throw new TusUploadError(
      "UNSUPPORTED",
      "Upload server did not return a location to upload to."
    );
  }
  // Bunny may answer with an absolute URL or a path; both must resolve.
  return new URL(location, credentials.endpoint).toString();
}

/** Ask the server how many bytes it already holds, so a retry resumes. */
async function remoteOffset(
  location: string,
  credentials: BunnyUploadCredentials
): Promise<number | null> {
  try {
    const res = await fetch(location, {
      method: "HEAD",
      headers: { "Tus-Resumable": "1.0.0", ...authHeaders(credentials) },
    });
    if (!res.ok) return null;
    const offset = res.headers.get("Upload-Offset");
    return offset === null ? null : Number(offset);
  } catch {
    return null;
  }
}

/** One PATCH of one chunk, with progress. Resolves with the new server offset. */
function sendChunk(
  location: string,
  blob: Blob,
  offset: number,
  credentials: BunnyUploadCredentials,
  onLoaded: (loadedInChunk: number) => void,
  signal?: AbortSignal
): Promise<number> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PATCH", location);
    xhr.setRequestHeader("Tus-Resumable", "1.0.0");
    xhr.setRequestHeader("Upload-Offset", String(offset));
    xhr.setRequestHeader("Content-Type", "application/offset+octet-stream");
    for (const [name, value] of Object.entries(authHeaders(credentials))) {
      xhr.setRequestHeader(name, value);
    }

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onLoaded(event.loaded);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const next = xhr.getResponseHeader("Upload-Offset");
        resolve(next === null ? offset + blob.size : Number(next));
        return;
      }
      reject(describe(xhr.status, xhr.responseText || ""));
    };
    xhr.onerror = () =>
      reject(
        new TusUploadError(
          "NETWORK",
          "The connection dropped during upload."
        )
      );
    xhr.onabort = () =>
      reject(new TusUploadError("ABORTED", "Upload cancelled"));

    if (signal) {
      if (signal.aborted) {
        reject(new TusUploadError("ABORTED", "Upload cancelled"));
        return;
      }
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }

    xhr.send(blob);
  });
}

export interface TusUploadOptions {
  onProgress?: (uploaded: number, total: number) => void;
  signal?: AbortSignal;
  /** Overridable for tests; must be a multiple of 256 KiB per the TUS spec. */
  chunkSize?: number;
}

/**
 * Stream `file` into the reserved Bunny slot.
 *
 * Resolves once the last byte is stored. Throws TusUploadError on failure — the
 * caller decides whether to keep the reserved video id or discard it.
 */
export async function uploadFileWithTus(
  file: File,
  credentials: BunnyUploadCredentials,
  options: TusUploadOptions = {}
): Promise<void> {
  const { onProgress, signal, chunkSize = CHUNK_SIZE } = options;

  if (!file.size) {
    throw new TusUploadError("UNSUPPORTED", "That file is empty.");
  }
  // Catch an expired authorization here rather than as an opaque 401 mid-upload.
  if (credentials.expirationTime <= Math.floor(Date.now() / 1000)) {
    throw new TusUploadError(
      "EXPIRED",
      "The upload authorization expired before the upload started. Please retry."
    );
  }

  const location = await createUpload(file, credentials);
  let offset = 0;

  while (offset < file.size) {
    const blob = file.slice(offset, offset + chunkSize);
    const chunkStart = offset;
    let lastError: TusUploadError | null = null;

    for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt++) {
      if (RETRY_DELAYS[attempt] > 0) await sleep(RETRY_DELAYS[attempt], signal);
      try {
        offset = await sendChunk(
          location,
          blob,
          chunkStart,
          credentials,
          (loaded) => onProgress?.(chunkStart + loaded, file.size),
          signal
        );
        lastError = null;
        break;
      } catch (error) {
        const tusError =
          error instanceof TusUploadError
            ? error
            : new TusUploadError("NETWORK", "Upload failed");

        // Cancelled or refused outright: retrying cannot help.
        if (tusError.code === "ABORTED" || tusError.code === "UNSUPPORTED") {
          throw tusError;
        }
        // An expired signature fails identically forever.
        if (tusError.status === 401 || tusError.status === 403) throw tusError;

        lastError = tusError;

        // The server may already hold part of this chunk — ask before resending
        // from the old offset, otherwise the chunk is written twice.
        const serverOffset = await remoteOffset(location, credentials);
        if (serverOffset !== null && serverOffset > chunkStart) {
          offset = serverOffset;
          lastError = null;
          break;
        }
      }
    }

    if (lastError) throw lastError;
    onProgress?.(offset, file.size);
  }
}
