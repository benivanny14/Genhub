import {
  MAX_VIDEO_BYTES,
  VideoUploadError,
  type VideoUploadProgress,
  type VideoUploadSession,
} from "@/lib/video-upload";

export interface StreamtapeBrowserUploadSession extends VideoUploadSession {
  provider: "STREAMTAPE";
  uploadUrl: string;
  headers: Record<string, string>;
}

export class StreamtapeImportFailedError extends VideoUploadError {
  constructor() {
    super("HTTP", "The video could not be processed. Upload it again.", undefined, {
      reason: "provider",
      stage: "put",
    });
    this.name = "StreamtapeImportFailedError";
  }
}

export class StreamtapeUploadNotStagedError extends VideoUploadError {
  constructor(status?: number) {
    super("CONFLICT", "The upload is not complete yet. Continue uploading and try again.", status, {
      reason: "provider",
      stage: "put",
    });
    this.name = "StreamtapeUploadNotStagedError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseStreamtapeUploadSession(value: unknown): StreamtapeBrowserUploadSession {
  if (
    !isRecord(value) ||
    value.provider !== "STREAMTAPE" ||
    typeof value.sessionToken !== "string" ||
    value.sessionToken.length < 80 ||
    typeof value.videoId !== "string" ||
    typeof value.uploadUrl !== "string" ||
    typeof value.totalBytes !== "number" ||
    !Number.isSafeInteger(value.totalBytes) ||
    value.totalBytes <= 0 ||
    value.totalBytes > MAX_VIDEO_BYTES ||
    typeof value.mimeType !== "string" ||
    typeof value.expiresAt !== "number" ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= Math.floor(Date.now() / 1000) ||
    !isRecord(value.headers) ||
    Object.entries(value.headers).some(
      ([key, headerValue]) => !key || typeof headerValue !== "string"
    )
  ) {
    throw new VideoUploadError("HTTP", "The upload session could not be started.", undefined, {
      reason: "provider",
      stage: "reserve",
    });
  }

  let uploadUrl: URL;
  try {
    uploadUrl = new URL(value.uploadUrl);
  } catch {
    throw new VideoUploadError("HTTP", "The upload session could not be started.", undefined, {
      reason: "provider",
      stage: "reserve",
    });
  }
  if (uploadUrl.protocol !== "https:") {
    throw new VideoUploadError("HTTP", "The upload session could not be started.", undefined, {
      reason: "provider",
      stage: "reserve",
    });
  }

  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value.headers)) {
    if (typeof headerValue !== "string") {
      throw new VideoUploadError("HTTP", "The upload session could not be started.", undefined, {
        reason: "provider",
        stage: "reserve",
      });
    }
    headers[key] = headerValue;
  }
  return {
    provider: "STREAMTAPE",
    sessionToken: value.sessionToken,
    videoId: value.videoId,
    uploadUrl: uploadUrl.toString(),
    headers,
    totalBytes: value.totalBytes,
    mimeType: value.mimeType,
    expiresAt: value.expiresAt,
  };
}

async function postSessionAction(path: string, sessionToken: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionToken }),
    });
  } catch {
    throw new VideoUploadError("NETWORK", "The video upload could not be confirmed. Try again.", undefined, {
      reason: "reset",
      stage: "put",
    });
  }

  let rawBody: unknown;
  try {
    rawBody = await response.json();
  } catch {
    throw new VideoUploadError("HTTP", "The video upload could not be confirmed. Try again.", response.status, {
      reason: "provider",
      stage: "put",
    });
  }

  if (!isRecord(rawBody)) {
    throw new VideoUploadError("HTTP", "The video upload could not be confirmed. Try again.", response.status, {
      reason: "provider",
      stage: "put",
    });
  }
  if (!response.ok || rawBody.success !== true || rawBody.data === undefined) {
    if (rawBody.code === "UPLOAD_INCOMPLETE") {
      throw new StreamtapeUploadNotStagedError(response.status);
    }
    throw new VideoUploadError(
      response.status === 409 ? "CONFLICT" : "HTTP",
      typeof rawBody.error === "string"
        ? rawBody.error
        : "The video upload could not be confirmed. Try again.",
      response.status,
      { reason: "provider", stage: "put" }
    );
  }
  return rawBody.data;
}

export function uploadVideoToStaging(
  file: File,
  session: StreamtapeBrowserUploadSession,
  onProgress: (progress: VideoUploadProgress) => void
): Promise<void> {
  if (file.size !== session.totalBytes) {
    throw new VideoUploadError("INVALID_FILE", "Choose the same video file to continue.", undefined, {
      reason: "unreadable",
      stage: "put",
    });
  }
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", session.uploadUrl);
    for (const [name, value] of Object.entries(session.headers)) {
      request.setRequestHeader(name, value);
    }
    request.upload.onprogress = (event) => {
      const uploadedBytes = Math.min(event.loaded, file.size);
      onProgress({
        uploadedBytes,
        totalBytes: file.size,
        percent: Math.min(100, Math.floor((uploadedBytes / file.size) * 100)),
      });
    };
    request.onerror = () =>
      reject(
        new VideoUploadError("NETWORK", "The video could not be uploaded. Check your connection and try again.", undefined, {
          reason: "reset",
          stage: "put",
        })
      );
    request.onabort = () =>
      reject(
        new VideoUploadError("ABORTED", "The video upload was cancelled.", undefined, {
          reason: "reset",
          stage: "put",
        })
      );
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress({ uploadedBytes: file.size, totalBytes: file.size, percent: 100 });
        resolve();
        return;
      }
      reject(
        new VideoUploadError(
          "HTTP",
          "The video could not be uploaded. Try again.",
          request.status,
          { reason: "provider", stage: "put", providerBody: request.responseText }
        )
      );
    };
    request.send(file);
  });
}

export async function importAndWaitForStreamtape(
  sessionToken: string,
  onPreparing?: () => void
): Promise<string> {
  await postSessionAction("/api/videos/upload-complete", sessionToken);
  onPreparing?.();

  const deadline = Date.now() + 30 * 60 * 1000;
  let consecutiveStatusFailures = 0;
  while (Date.now() < deadline) {
    let status: unknown;
    try {
      status = await postSessionAction("/api/videos/upload-status", sessionToken);
      consecutiveStatusFailures = 0;
    } catch (error) {
      const retryable =
        error instanceof VideoUploadError &&
        (error.code === "NETWORK" ||
          error.status === 408 ||
          error.status === 429 ||
          (error.status !== undefined && error.status >= 500));
      if (!retryable || Date.now() >= deadline) throw error;

      consecutiveStatusFailures += 1;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(consecutiveStatusFailures - 1, 5));
      await new Promise((resolve) => window.setTimeout(resolve, delay));
      continue;
    }

    if (!isRecord(status) || typeof status.state !== "string") {
      throw new VideoUploadError("HTTP", "The video status could not be checked. Try again.", undefined, {
        reason: "provider",
        stage: "put",
      });
    }
    if (status.state === "READY") {
      if (
        typeof status.fileId === "string" &&
        /^[A-Za-z0-9_-]{4,128}$/.test(status.fileId)
      ) {
        return status.fileId;
      }
      throw new VideoUploadError("HTTP", "The video could not be processed. Upload it again.", undefined, {
        reason: "provider",
        stage: "put",
      });
    }
    if (status.state === "FAILED") {
      throw new StreamtapeImportFailedError();
    }
    if (status.state !== "IMPORTING") {
      throw new VideoUploadError("HTTP", "The video status could not be checked. Try again.", undefined, {
        reason: "provider",
        stage: "put",
      });
    }
    await new Promise((resolve) => window.setTimeout(resolve, 4_000));
  }

  throw new VideoUploadError("NETWORK", "The video is still being prepared. Try again shortly.", undefined, {
    reason: "reset",
    stage: "put",
  });
}

export async function cancelStreamtapeUpload(sessionToken: string): Promise<void> {
  await postSessionAction("/api/videos/upload-abort", sessionToken);
}
