// =============================================================================
// GENHUB - Where the site's background clip is actually kept
// =============================================================================
// One row per clip, bytes included (BackgroundVideoAsset). It used to be a file
// in `public/uploads/site/`, which is the one place it could not work: the
// deployment's filesystem is read-only except for a per-instance `/tmp`, and a
// serverless function may neither receive nor return more than 4.5 MB. A 6 MB
// upload was refused by the platform before the route ran, and anything that did
// reach it answered "This server cannot store a video right now."
//
// The row is addressed by the same 24-hex token the settings row carries and the
// browser puts in `?v=`. Nothing about the stored record is ever interpolated
// into a path or a query: the token is the primary key, and it is checked with
// `isBackgroundToken` before it is used.
//
// WHY A RAW STATEMENT FOR THE SLICE
//
//   A `<video>` asks for byte ranges, and the route is expected to answer with
//   exactly the bytes that were asked for. `substring` does that inside the
//   database, so a request for the first 64 KB of a 4 MB clip transfers 64 KB
//   rather than the whole row and then throws most of it away. The unit is bytes
//   in both directions — Postgres counts `substring` from 1, the HTTP range
//   counts from 0, and the offset is converted in exactly one place below.
// =============================================================================

import prisma from "@/lib/db";

/** What a stored clip is, without its bytes. */
export interface BackgroundVideoAsset {
  mimeType: string;
  name: string;
  size: number;
}

/**
 * Store a clip under its token.
 *
 * A create rather than an upsert: the token is generated fresh for every upload,
 * so a row already existing under this key would mean two uploads were handed
 * the same token — which is the one way this table could serve the wrong clip,
 * and it should fail loudly rather than silently overwrite one operator's
 * footage with another's.
 */
export async function saveBackgroundVideoAsset(params: {
  id: string;
  mimeType: string;
  name: string;
  /** A Buffer rather than any view: this is the shape Prisma's `Bytes` takes. */
  data: Buffer;
}): Promise<void> {
  const { id, mimeType, name, data } = params;
  await prisma.backgroundVideoAsset.create({
    data: { id, mimeType, name, size: data.byteLength, data },
  });
}

/**
 * The stored clip's metadata, or null when there is no such row.
 *
 * `size` is read from the row rather than trusted from the settings entry: it is
 * the number every range decision is made from, and the row is the only place it
 * is derived from the bytes themselves.
 */
export async function readBackgroundVideoAsset(
  id: string
): Promise<BackgroundVideoAsset | null> {
  const row = await prisma.backgroundVideoAsset.findUnique({
    where: { id },
    select: { mimeType: true, name: true, size: true },
  });
  return row ?? null;
}

/**
 * The bytes between `start` and `end`, inclusive — the slice a range asks for.
 *
 * `null` means the row is gone, which the caller answers as "no clip". An empty
 * result for a row that exists means the range was past the end of the clip; the
 * caller has already decided that against the stored size, and an empty buffer
 * cannot be mistaken for a served range because the length is checked there.
 *
 * A bytea column comes back from Postgres as a Buffer (a Uint8Array view over
 * it), which is what every caller wants: `ReadableStream` and `NextResponse`
 * both accept it as a body without a copy.
 */
export async function readBackgroundVideoSlice(
  id: string,
  start: number,
  end: number
): Promise<Uint8Array | null> {
  const length = end - start + 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || length <= 0) return null;

  // The `::int` casts are load-bearing, not decoration. A number bound by the
  // client arrives as `bigint`, and Postgres has no `substring(bytea, bigint,
  // bigint)` — the only bytea slice is the four-byte integer form. Measured
  // against the real database: without the casts every range request answers
  // 500 with `function pg_catalog.substring(bytea, bigint, bigint) does not
  // exist`, while HEAD and 416 keep working, because neither reads a slice.
  const rows = await prisma.$queryRaw<Array<{ chunk: Uint8Array | null }>>`
    SELECT substring("data" FROM ${start + 1}::int FOR ${length}::int) AS chunk
    FROM "BackgroundVideoAsset"
    WHERE "id" = ${id}
  `;

  if (rows.length === 0) return null;
  return rows[0].chunk ?? new Uint8Array(0);
}

/**
 * Forget a clip.
 *
 * Missing is success in the same sense the old unlink was: the only thing that
 * calls this is a replacement, a removal, or a rollback after the settings write
 * failed, and every one of those wants "it is not there any more" rather than an
 * exception. A failure here is logged by the caller if it matters, not thrown
 * into a flow that has already succeeded.
 */
export async function deleteBackgroundVideoAsset(id: string | null): Promise<void> {
  if (!id) return;
  await prisma.backgroundVideoAsset.deleteMany({ where: { id } });
}
