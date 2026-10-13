import config from "@/lib/config";

const STREAMTAPE_API = "https://api.streamtape.com";

type StreamtapeEnvelope<T> = {
  status: number;
  msg?: string;
  result: T;
};

type RemoteStatus = {
  id?: string;
  status?: string;
  extid?: string | boolean | null;
  bytes_loaded?: number | string;
  bytes_total?: number | string;
};

type StreamtapeFileInfo = {
  id?: string;
  converted?: boolean;
  status?: number;
};

export type StreamtapeUploadStatus =
  | { state: "IMPORTING"; progress: number }
  | { state: "FAILED"; progress: number }
  | { state: "READY"; fileId: string; progress: 100 };

export function isStreamtapeConfigured(): boolean {
  return Boolean(config.streamtape.login && config.streamtape.apiKey);
}

export function streamtapeEmbedUrl(fileId: string): string | null {
  if (!/^[A-Za-z0-9_-]{4,128}$/.test(fileId)) return null;
  return `https://streamtape.com/e/${encodeURIComponent(fileId)}`;
}

async function streamtapeRequest<T>(
  endpoint: string,
  params: Record<string, string>
): Promise<T> {
  if (!isStreamtapeConfigured()) throw new Error("Streamtape credentials are not configured");

  const url = new URL(endpoint, STREAMTAPE_API);
  url.searchParams.set("login", config.streamtape.login);
  url.searchParams.set("key", config.streamtape.apiKey);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    method: "GET",
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`Streamtape ${endpoint} returned HTTP ${response.status}`);
  }

  const body = (await response.json()) as Partial<StreamtapeEnvelope<T>>;
  if (body.status !== 200 || body.result === undefined || body.result === null) {
    const message = typeof body.msg === "string" ? body.msg.slice(0, 160) : "invalid response";
    throw new Error(`Streamtape ${endpoint} failed: ${message}`);
  }
  return body.result;
}

export async function startStreamtapeRemoteUpload(params: {
  url: string;
  name: string;
}): Promise<string> {
  const result = await streamtapeRequest<{ id?: string }>("/remotedl/add", {
    url: params.url,
    name: params.name,
    folder: config.streamtape.folderId,
  });
  if (!result.id || !/^[A-Za-z0-9_-]{1,128}$/.test(result.id)) {
    throw new Error("Streamtape did not return a valid remote upload ID");
  }
  return result.id;
}

export async function getStreamtapeUploadStatus(
  remoteUploadId: string
): Promise<StreamtapeUploadStatus> {
  const remoteResult = await streamtapeRequest<Record<string, RemoteStatus>>(
    "/remotedl/status",
    { id: remoteUploadId }
  );
  const remote = remoteResult[remoteUploadId];
  if (!remote) throw new Error("Streamtape remote upload was not found");

  const loaded = Number(remote.bytes_loaded);
  const total = Number(remote.bytes_total);
  const progress =
    Number.isFinite(loaded) && Number.isFinite(total) && total > 0
      ? Math.max(0, Math.min(99, Math.floor((loaded / total) * 100)))
      : 0;
  const remoteState = (remote.status || "").toLowerCase();

  if (remoteState === "error" || remoteState === "failed") {
    return { state: "FAILED", progress };
  }
  if (remoteState !== "finished" || typeof remote.extid !== "string") {
    return { state: "IMPORTING", progress };
  }

  const fileId = remote.extid;
  if (!streamtapeEmbedUrl(fileId)) throw new Error("Streamtape returned an invalid file ID");

  const fileInfo = await streamtapeRequest<Record<string, StreamtapeFileInfo>>("/file/info", {
    file: fileId,
  });
  const file = fileInfo[fileId];
  if (!file || file.id !== fileId) throw new Error("Streamtape file information was incomplete");
  if (file.converted !== true) return { state: "IMPORTING", progress: 99 };

  return { state: "READY", fileId, progress: 100 };
}

export async function removeStreamtapeRemoteUpload(remoteUploadId: string): Promise<void> {
  await streamtapeRequest<unknown>("/remotedl/remove", { id: remoteUploadId });
}

export async function deleteStreamtapeFile(fileId: string): Promise<void> {
  if (!streamtapeEmbedUrl(fileId)) throw new Error("Invalid Streamtape file ID");
  await streamtapeRequest<unknown>("/file/delete", { file: fileId });
}
