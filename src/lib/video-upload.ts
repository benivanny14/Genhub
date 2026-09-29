// =============================================================================
// GENHUB - One video upload transport
//
// Videos go straight from the creator's browser to Bunny Stream using Bunny's
// resumable TUS endpoint. The application server only creates the upload session
// and finalizes the database row; it never proxies video bytes and never moves a
// completed file through a second storage provider.
// =============================================================================

export const MAX_VIDEO_BYTES = 2_147_483_647;
export const VIDEO_UPLOAD_CHUNK_BYTES = 16 * 1024 * 1024;
export const VIDEO_UPLOAD_MAX_ATTEMPTS = 5;

/**
 * Why this file cannot be uploaded, or null when it can.
 *
 * Checked in the browser before a session is created, because the alternative is
 * a reserved Bunny slot and a round trip spent on a file that can never be sent
 * — and because the schema's own refusal ("number must be less than or equal to
 * 2147483647") is not a sentence a creator can act on.
 */
export function videoFileSizeError(file: { size: number }): string | null {
  if (!file.size) return "That file is empty";
  if (file.size > MAX_VIDEO_BYTES) return "Choose a video up to 2 GB";
  return null;
}

export interface VideoUploadSession {
  sessionToken: string;
  videoId: string;
  uploadUrl: string;
  headers: Record<string, string>;
  totalBytes: number;
  expiresAt: number;
}

export interface VideoUploadProgress {
  uploadedBytes: number;
  totalBytes: number;
  percent: number;
}

export class VideoUploadError extends Error {
  readonly code:
    | "INVALID_FILE"
    | "NETWORK"
    | "HTTP"
    | "CONFLICT"
    | "EXPIRED"
    | "ABORTED";
  readonly status?: number;

  constructor(
    code: VideoUploadError["code"],
    message: string,
    status?: number
  ) {
    super(message);
    this.name = "VideoUploadError";
    this.code = code;
    this.status = status;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function retryDelay(attempt: number): number {
  return Math.min(5_000, 500 * 2 ** Math.max(0, attempt - 1));
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();

  if (init.signal) {
    if (init.signal.aborted) controller.abort();
    else init.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (init.signal?.aborted) {
      throw new VideoUploadError("ABORTED", "Upload cancelled");
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new VideoUploadError("NETWORK", "The upload connection timed out");
    }
    throw new VideoUploadError("NETWORK", "The upload connection was interrupted");
  } finally {
    window.clearTimeout(timer);
    init.signal?.removeEventListener("abort", onAbort);
  }
}

async function readOffset(
  session: VideoUploadSession,
  signal?: AbortSignal
): Promise<number> {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      session.uploadUrl,
      {
        method: "HEAD",
        headers: { ...session.headers, "Tus-Resumable": "1.0.0" },
        cache: "no-store",
        signal,
      },
      30_000
    );
  } catch (error) {
    if (error instanceof VideoUploadError && error.code === "ABORTED") throw error;
    throw new VideoUploadError("NETWORK", "Could not check the saved upload position");
  }

  if (response.status === 401 || response.status === 403) {
    throw new VideoUploadError(
      "EXPIRED",
      "The upload session expired. Please choose the video again.",
      response.status
    );
  }
  if (response.status === 404) {
    // Bunny answers 404 — not 401 — both for an upload it no longer has and for
    // a request that reached it without the signed headers, so the sentence says
    // what is known and carries the number for whoever reads it next.
    throw new VideoUploadError(
      "EXPIRED",
      `The video service has closed this upload (HTTP ${response.status}). Please choose the video again.`,
      response.status
    );
  }
  if (!response.ok) {
    throw new VideoUploadError("HTTP", "The video service could not resume this upload", response.status);
  }

  const offset = Number(response.headers.get("upload-offset") || "0");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > session.totalBytes) {
    throw new VideoUploadError("HTTP", "The video service returned an invalid upload position");
  }
  return offset;
}

function nextOffset(response: Response, current: number, sent: number, total: number): number {
  const header = Number(response.headers.get("upload-offset") || "");
  const offset = Number.isSafeInteger(header) ? header : current + sent;
  if (offset <= current || offset > total) {
    throw new VideoUploadError("HTTP", "The video service returned an invalid upload position");
  }
  return offset;
}

/** Upload one file, resuming from the offset Bunny already has. */
export async function uploadVideoFile(
  file: File,
  session: VideoUploadSession,
  options: {
    onProgress?: (progress: VideoUploadProgress) => void;
    signal?: AbortSignal;
    /**
     * Where to start, when it is already known.
     *
     * A session the server has just created holds nothing, and that is not a
     * guess: Bunny answers a brand-new TUS resource with offset 0. Supplying it
     * removes the opening HEAD, which is one round trip off every upload and —
     * on a connection slow enough to lose it — one more way for the transfer to
     * die before it has sent a byte. Omitted for a RESUMED session, where the
     * offset is exactly the thing that has to be asked for.
     */
    offset?: number;
  } = {}
): Promise<void> {
  if (!file || !file.size) {
    throw new VideoUploadError("INVALID_FILE", "Choose a video up to 2 GB");
  }
  const sizeError = videoFileSizeError(file);
  if (sizeError) throw new VideoUploadError("INVALID_FILE", sizeError);
  if (file.size !== session.totalBytes) {
    throw new VideoUploadError(
      "INVALID_FILE",
      "The selected file is different from the upload session. Choose it again."
    );
  }

  let offset = options.offset ?? (await readOffset(session, options.signal));
  options.onProgress?.({
    uploadedBytes: offset,
    totalBytes: file.size,
    percent: Math.round((offset / file.size) * 100),
  });

  while (offset < file.size) {
    const start = offset;
    const end = Math.min(file.size, start + VIDEO_UPLOAD_CHUNK_BYTES);
    const chunk = file.slice(start, end);
    let succeeded = false;

    for (let attempt = 1; attempt <= VIDEO_UPLOAD_MAX_ATTEMPTS; attempt += 1) {
      if (options.signal?.aborted) {
        throw new VideoUploadError("ABORTED", "Upload cancelled");
      }

      try {
        const response = await fetchWithTimeout(
          session.uploadUrl,
          {
            method: "PATCH",
            headers: {
              ...session.headers,
              "Tus-Resumable": "1.0.0",
              "Upload-Offset": String(start),
              "Content-Type": "application/offset+octet-stream",
            },
            body: chunk,
            cache: "no-store",
            signal: options.signal,
          },
          120_000
        );

        if (response.status === 409 || response.status === 412) {
          offset = await readOffset(session, options.signal);
          succeeded = true;
          break;
        }
        if (response.status === 401 || response.status === 403) {
          throw new VideoUploadError(
            "EXPIRED",
            "The upload session expired. Please choose the video again.",
            response.status
          );
        }
        if (!response.ok) {
          throw new VideoUploadError(
            "HTTP",
            `The video service refused a chunk (HTTP ${response.status})`,
            response.status
          );
        }

        offset = nextOffset(response, start, chunk.size, file.size);
        succeeded = true;
        break;
      } catch (error) {
        if (error instanceof VideoUploadError && error.code === "ABORTED") throw error;
        if (
          error instanceof VideoUploadError &&
          (error.code === "EXPIRED" ||
            (error.code === "HTTP" && error.status !== undefined && error.status < 500 && error.status !== 409 && error.status !== 412))
        ) {
          throw error;
        }

        if (attempt === VIDEO_UPLOAD_MAX_ATTEMPTS) {
          throw error instanceof VideoUploadError
            ? error
            : new VideoUploadError("NETWORK", "The upload connection was interrupted");
        }

        await wait(retryDelay(attempt));
        // If the PATCH reached Bunny before the response was lost, this HEAD
        // advances us without sending the same bytes twice.
        try {
          offset = await readOffset(session, options.signal);
          if (offset >= end) {
            succeeded = true;
            break;
          }
        } catch (headError) {
          if (headError instanceof VideoUploadError && headError.code === "ABORTED") {
            throw headError;
          }
          // The next PATCH attempt can still recover if HEAD was the request
          // that lost the connection. Do not turn a temporary HEAD failure into
          // a permanent upload failure before the retry budget is spent.
        }
      }
    }

    if (!succeeded) {
      throw new VideoUploadError("NETWORK", "The video chunk could not be saved");
    }

    options.onProgress?.({
      uploadedBytes: offset,
      totalBytes: file.size,
      percent: Math.min(100, Math.round((offset / file.size) * 100)),
    });
  }
}

export async function completeVideoUpload(sessionToken: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch("/api/videos/upload-complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionToken }),
    });
  } catch {
    throw new VideoUploadError("NETWORK", "The upload finished, but Genhub could not confirm it");
  }

  const body = (await response.json().catch(() => null)) as {
    success?: boolean;
    error?: string;
    data?: { videoId?: string };
  } | null;

  if (!response.ok || !body?.success || !body.data?.videoId) {
    throw new VideoUploadError(
      response.status === 409 ? "CONFLICT" : "HTTP",
      body?.error || "Genhub could not confirm the completed upload",
      response.status
    );
  }
  return body.data.videoId;
}

export async function abortVideoUpload(sessionToken: string): Promise<void> {
  await fetch("/api/videos/upload-abort", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionToken }),
    keepalive: true,
  }).catch(() => undefined);
}
