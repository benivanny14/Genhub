import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import prisma from "@/lib/db";
import config from "@/lib/config";
import {
  isSafeR2Key,
  presignR2Url,
  r2DeleteObject,
  r2HeadObject,
} from "@/lib/r2";
import {
  deleteStreamtapeFile,
  getStreamtapeUploadStatus,
  isStreamtapeConfigured,
  removeStreamtapeRemoteUpload,
  startStreamtapeRemoteUpload,
  type StreamtapeUploadStatus,
} from "@/lib/streamtape";
import type { VideoUploadSession } from "@/lib/video-upload";

const ISSUER = "genhub";
const AUDIENCE = "streamtape-upload";
const UPLOAD_TTL_SECONDS = 12 * 60 * 60;
const REMOTE_URL_TTL_SECONDS = 24 * 60 * 60;
const R2_VIDEO_STAGING_PREFIX = "video-staging/";

function isUploadSessionConfigured(): boolean {
  return Boolean(config.jwtSecret) && config.jwtSecret !== "dev-secret-change-in-production";
}

export interface StreamtapeVideoUploadSession extends VideoUploadSession {
  provider: "STREAMTAPE";
  uploadUrl: string;
  headers: Record<string, string>;
}

export interface VerifiedStreamtapeVideoUploadSession {
  uploadId: string;
  userId: string;
  objectKey: string;
  fileName: string;
  totalBytes: number;
  mimeType: string;
  expiresAt: number;
}

export function isStreamtapeUploadConfigured(): boolean {
  return (
    isUploadSessionConfigured() &&
    isStreamtapeConfigured() &&
    Boolean(config.r2.accountId && config.r2.accessKeyId && config.r2.secretAccessKey && config.r2.bucket)
  );
}

function signingSecret(): Uint8Array {
  if (!isUploadSessionConfigured()) {
    throw new Error("JWT_SECRET must be configured before video uploads can start");
  }
  return new TextEncoder().encode(config.jwtSecret);
}

function safeFileName(fileName: string): string {
  const clean = fileName
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 120);
  return clean || "video.mp4";
}

export async function createStreamtapeUploadSession(params: {
  userId: string;
  fileName: string;
  totalBytes: number;
  mimeType?: string;
}): Promise<StreamtapeVideoUploadSession> {
  if (!isStreamtapeUploadConfigured()) {
    throw new Error("Streamtape, R2 and upload-session signing must all be configured");
  }

  const mimeType = /^video\//i.test(params.mimeType || "") ? params.mimeType! : "video/mp4";
  const fileName = safeFileName(params.fileName);
  const objectKey = `${R2_VIDEO_STAGING_PREFIX}${params.userId}/${randomUUID()}`;
  if (!isSafeR2Key(objectKey)) throw new Error("Could not create a safe staging key");

  const expiresAt = Math.floor(Date.now() / 1000) + UPLOAD_TTL_SECONDS;
  const uploadUrl = presignR2Url({
    method: "PUT",
    key: objectKey,
    expiresInSeconds: UPLOAD_TTL_SECONDS,
    contentType: mimeType,
  });
  const upload = await prisma.streamtapeUpload.create({
    data: {
      userId: params.userId,
      objectKey,
      fileName,
      totalBytes: params.totalBytes,
      mimeType,
      expiresAt: new Date(expiresAt * 1000),
    },
    select: { id: true },
  });

  const tokenPayload = {
    uploadId: upload.id,
    userId: params.userId,
    objectKey,
    fileName,
    totalBytes: params.totalBytes,
    mimeType,
    expiresAt,
  };
  const sessionToken = await new SignJWT(tokenPayload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(signingSecret());

  return {
    provider: "STREAMTAPE",
    sessionToken,
    videoId: upload.id,
    uploadUrl: uploadUrl.url,
    headers: uploadUrl.headers,
    totalBytes: params.totalBytes,
    mimeType,
    expiresAt,
  };
}

export async function verifyStreamtapeUploadSession(
  sessionToken: string,
  userId: string
): Promise<VerifiedStreamtapeVideoUploadSession | null> {
  try {
    const verified = await jwtVerify(sessionToken, signingSecret(), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    const payload = verified.payload;
    if (
      payload.userId !== userId ||
      typeof payload.uploadId !== "string" ||
      typeof payload.objectKey !== "string" ||
      typeof payload.fileName !== "string" ||
      typeof payload.mimeType !== "string" ||
      typeof payload.totalBytes !== "number" ||
      !Number.isSafeInteger(payload.totalBytes) ||
      payload.totalBytes <= 0 ||
      typeof payload.expiresAt !== "number" ||
      !Number.isSafeInteger(payload.expiresAt) ||
      payload.expiresAt <= Math.floor(Date.now() / 1000) ||
      !payload.objectKey.startsWith(R2_VIDEO_STAGING_PREFIX) ||
      !isSafeR2Key(payload.objectKey)
    ) {
      return null;
    }

    const upload = await prisma.streamtapeUpload.findUnique({
      where: { id: payload.uploadId },
      select: {
        id: true,
        userId: true,
        objectKey: true,
        fileName: true,
        totalBytes: true,
        mimeType: true,
        expiresAt: true,
      },
    });
    if (
      !upload ||
      upload.userId !== userId ||
      upload.objectKey !== payload.objectKey ||
      upload.fileName !== payload.fileName ||
      upload.totalBytes !== payload.totalBytes ||
      upload.mimeType !== payload.mimeType ||
      upload.expiresAt.getTime() !== payload.expiresAt * 1000
    ) {
      return null;
    }

    return {
      uploadId: upload.id,
      userId,
      objectKey: upload.objectKey,
      fileName: upload.fileName,
      totalBytes: upload.totalBytes,
      mimeType: upload.mimeType,
      expiresAt: payload.expiresAt,
    };
  } catch {
    return null;
  }
}

export async function startOrResumeStreamtapeImport(
  session: VerifiedStreamtapeVideoUploadSession
): Promise<{ state: string }> {
  const current = await prisma.streamtapeUpload.findUnique({
    where: { id: session.uploadId },
    select: { state: true, remoteUploadId: true },
  });
  if (!current) throw new Error("Streamtape upload session was not found");
  if (current.state !== "UPLOADING") return { state: current.state };

  const object = await r2HeadObject(session.objectKey);
  if (!object || object.size !== session.totalBytes) {
    throw new Error("The staged video is missing or its size does not match the upload");
  }

  const claimed = await prisma.streamtapeUpload.updateMany({
    where: { id: session.uploadId, state: "UPLOADING" },
    data: { state: "STARTING" },
  });
  if (claimed.count === 0) {
    const latest = await prisma.streamtapeUpload.findUnique({
      where: { id: session.uploadId },
      select: { state: true },
    });
    return { state: latest?.state || "FAILED" };
  }

  try {
    const sourceUrl = presignR2Url({
      method: "GET",
      key: session.objectKey,
      expiresInSeconds: REMOTE_URL_TTL_SECONDS,
    });
    const remoteUploadId = await startStreamtapeRemoteUpload({
      url: sourceUrl.url,
      name: session.fileName,
    });
    await prisma.streamtapeUpload.update({
      where: { id: session.uploadId },
      data: { state: "IMPORTING", remoteUploadId },
    });
    return { state: "IMPORTING" };
  } catch (error) {
    await prisma.streamtapeUpload.update({
      where: { id: session.uploadId },
      data: { state: "FAILED" },
    });
    throw error;
  }
}

export async function pollStreamtapeImport(
  session: VerifiedStreamtapeVideoUploadSession
): Promise<StreamtapeUploadStatus> {
  const upload = await prisma.streamtapeUpload.findUnique({
    where: { id: session.uploadId },
    select: { state: true, remoteUploadId: true, streamtapeFileId: true, objectKey: true },
  });
  if (!upload) throw new Error("Streamtape upload session was not found");
  if (upload.state === "READY" && upload.streamtapeFileId) {
    return { state: "READY", fileId: upload.streamtapeFileId, progress: 100 };
  }
  if (upload.state === "FAILED" || upload.state === "CANCELLED") {
    return { state: "FAILED", progress: 0 };
  }
  if (upload.state === "STARTING" || !upload.remoteUploadId) {
    return { state: "IMPORTING", progress: 0 };
  }

  const status = await getStreamtapeUploadStatus(upload.remoteUploadId);
  if (status.state === "FAILED") {
    await prisma.streamtapeUpload.update({
      where: { id: session.uploadId },
      data: { state: "FAILED" },
    });
    await prisma.video.updateMany({
      where: { streamtapeFileId: `pending_${session.uploadId}` },
      data: { encodingStatus: 5, encodeProgress: 0, encodingError: "Streamtape could not process this video. Upload it again." },
    });
    return status;
  }
  if (status.state === "READY") {
    await prisma.streamtapeUpload.update({
      where: { id: session.uploadId },
      data: { state: upload.state === "LINKED" ? "LINKED" : "READY", streamtapeFileId: status.fileId },
    });
    await r2DeleteObject(upload.objectKey);
  }
  return status;
}

export async function getReadyStreamtapeFile(
  uploadId: string,
  userId: string,
  fileId: string
): Promise<boolean> {
  const upload = await prisma.streamtapeUpload.findFirst({
    where: { id: uploadId, userId, state: "READY", streamtapeFileId: fileId },
    select: { id: true },
  });
  return upload !== null;
}

export async function getStreamtapeUploadForCreator(
  uploadId: string,
  userId: string
): Promise<{ state: string; fileId: string | null } | null> {
  return prisma.streamtapeUpload.findFirst({
    where: { id: uploadId, userId },
    select: { state: true, streamtapeFileId: true },
  }).then((upload) => upload ? { state: upload.state, fileId: upload.streamtapeFileId } : null);
}

export async function refreshLinkedStreamtapeUpload(
  uploadId: string,
  userId: string
): Promise<StreamtapeUploadStatus | null> {
  const upload = await prisma.streamtapeUpload.findFirst({
    where: { id: uploadId, userId },
    select: { id: true, userId: true, objectKey: true, fileName: true, totalBytes: true, mimeType: true, expiresAt: true },
  });
  if (!upload) return null;
  return pollStreamtapeImport({
    uploadId: upload.id,
    userId: upload.userId,
    objectKey: upload.objectKey,
    fileName: upload.fileName,
    totalBytes: upload.totalBytes,
    mimeType: upload.mimeType,
    expiresAt: Math.floor(upload.expiresAt.getTime() / 1000),
  });
}

export async function cancelStreamtapeUpload(
  session: VerifiedStreamtapeVideoUploadSession
): Promise<void> {
  const upload = await prisma.streamtapeUpload.findUnique({
    where: { id: session.uploadId },
    select: { state: true, objectKey: true, remoteUploadId: true, streamtapeFileId: true },
  });
  if (!upload || upload.state === "LINKED") return;
  if (upload.remoteUploadId) await removeStreamtapeRemoteUpload(upload.remoteUploadId);
  if (upload.streamtapeFileId) await deleteStreamtapeFile(upload.streamtapeFileId);
  await r2DeleteObject(upload.objectKey);
  await prisma.streamtapeUpload.update({
    where: { id: session.uploadId },
    data: { state: "CANCELLED" },
  });
}
