# Video ingest Worker

The last hop of a Genhub upload. A video goes:

```
browser ──presigned PUT──▶ Cloudflare R2 ──▶ this Worker ──PUT + AccessKey──▶ Bunny Stream
                                             (token-checked)                    (reserved slot)
```

- **The browser uploads to R2 with a presigned URL.** The server signs it
  (`src/lib/r2-sign.ts`) for one object, one method, one deadline. No credential
  of ours is in the browser, and no server of ours receives the file.
- **This Worker moves the object into Bunny.** The Next server calls
  `POST /ingest` with a token naming one object key and one video id; the Worker
  verifies that token, reads that object, and PUTs it into the Bunyy slot the
  server reserved before the upload started.

## Why the ingest is a Worker and not Bunny's own fetch API

`POST /library/{id}/videos/fetch` is the obvious tool and it does not fit:

- it **creates a video object of its own**, so it cannot fill the slot that was
  already reserved for this creator's post;
- its documented (and observed) response is
  `{"success": true, "message": "OK", "statusCode": 200}` — **no guid**, so the
  id the rest of the system is keyed on would have to be hunted for by title;
- a retry therefore creates a **second video** with a second guid holding the
  same bytes.

Moving the bytes ourselves keeps the id deterministic and makes a retry
idempotent: the same file, into the same slot, as many times as it takes.

## What it holds

| Secret / var | What it is |
| --- | --- |
| `BUNNY_STREAM_API_KEY` | secret. The library key. It can delete every video in the library, which is exactly why the browser never sees it and never talks to this Worker. |
| `VIDEO_INGEST_SECRET` | secret. HMAC secret shared with the Next deployment. Same string on both sides or every ingest answers 401. |
| `BUNNY_STREAM_LIBRARY_ID` | var. Public by design — it is in every playback URL. |
| `BUCKET` | binding. Read-only in practice: the code calls `get` and nothing else. |

## Setup, in order

### 1. Create the bucket

```bash
npx wrangler r2 bucket create genhub-uploads
```

The name must match `R2_BUCKET` on the Next deployment and `bucket_name` in
`wrangler.toml`. A mismatch produces `Uploaded file not found` on every ingest —
a true sentence about the wrong bucket.

### 2. Allow the browser to PUT to it (CORS)

The upload is a cross-origin `PUT` with `Content-Type: application/octet-stream`,
so the browser sends a preflight first and R2 refuses the upload unless the
bucket allows it. Cloudflare dashboard → **R2 → genhub-uploads → Settings →
CORS Policy**, or:

```bash
npx wrangler r2 bucket cors put genhub-uploads --file cors.json
```

```json
[
  {
    "AllowedOrigins": ["https://genhub-two.vercel.app", "http://localhost:3000"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["etag"],
    "MaxAgeSeconds": 3600
  }
]
```

Set `AllowedOrigins` to the exact origins creators upload from, including every
preview domain you test on. A missing origin is not a security hole — the
signature still authorizes — but the browser refuses the request and the upload
dies with a CORS error, which is a confusing way to learn that a domain was
forgotten.

### 3. Create an S3 API token for R2

Dashboard → **R2 → API → Manage API Tokens → Create API token**, permission
**Object Read & Write**, scoped to `genhub-uploads`. It prints an **Access Key
ID** and a **Secret Access Key** once — those are `R2_ACCESS_KEY_ID` and
`R2_SECRET_ACCESS_KEY`. They are the ones the *Next* server signs with; this
Worker does not use them, because a binding cannot be used from outside.

### 4. Set the secrets and deploy

```bash
cd worker/video-ingest
npx wrangler secret put VIDEO_INGEST_SECRET
npx wrangler secret put BUNNY_STREAM_API_KEY
npx wrangler deploy
```

The deploy prints the Worker URL. That is `VIDEO_INGEST_URL` on the Next
deployment; `VIDEO_INGEST_SECRET` must be the same string on both sides.

> **Note.** This Worker is named `genhub-video-ingest`, not
> `genhub-bunny-upload`. If you deployed the older upload proxy, that Worker is
> now unused and can be deleted (`npx wrangler delete genhub-bunny-upload`), and
> `BUNNY_UPLOAD_PROXY_URL` / `BUNNY_UPLOAD_PROXY_SECRET` can be removed from
> Vercel.

### 5. Tell Vercel, then redeploy

```
R2_ACCOUNT_ID            R2_ACCESS_KEY_ID        R2_SECRET_ACCESS_KEY
R2_BUCKET                VIDEO_INGEST_URL        VIDEO_INGEST_SECRET
```

Environment variables do not take effect until a new deployment, so **redeploy**
after setting them. Until all six are present, uploads stay on the resumable
path and nothing breaks; set half of them and `/api/health` warns.

## Verifying it

```bash
# Liveness. Says whether the bucket, the secret and Bunny are configured —
# never what any of them are.
curl -s https://genhub-video-ingest.<account>.workers.dev/health

# Authorization runs BEFORE the bucket is read, so this must be 401 and must
# not reveal whether the object exists.
curl -s -X POST "https://genhub-video-ingest.<account>.workers.dev/ingest?key=x&videoId=y&expires=1&sig=z"

# The bucket is private and reachable only through a token that expires.
curl -s https://genhub-video-ingest.<account>.workers.dev/health | grep -q '"bucketConfigured":true'
```

The end-to-end proof is one real upload: after the PUT finishes, the Bunny slot
should climb from `0 bytes` to the size of the file within seconds of the
ingest call, and the row should be created with a `bunnyVideoId` that matches.

## Failure signatures

| Where it shows | What it means |
| --- | --- |
| Upload fails immediately with a CORS error | `AllowedOrigins` on the bucket does not include the origin you are uploading from. |
| `403` part-way through a slow upload | The presigned URL expired. The page says so; a retry asks for a fresh one. |
| Ingest answers `401` | `VIDEO_INGEST_SECRET` differs between Vercel and the Worker. |
| Ingest answers `502` with `bunnyStatus: 401` | `BUNNY_STREAM_API_KEY` on the Worker is wrong. |
| Ingest answers `502` with `bunnyStatus: 404` | The reserved slot is gone (deleted from the library mid-upload). |
| Ingest answers `404` | The object is not in the bucket: the PUT never finished, or the key does not match `R2_BUCKET`. |
| Ingest answers `503` | The Next deployment has no R2 or ingest configured. |

## One assumption worth knowing about

The object is **streamed** into Bunny rather than buffered, so the outgoing
request is chunked and carries no `Content-Length` (a Worker cannot set that
header on a stream, and buffering a video in memory to obtain it would bound the
ingest to the Worker's memory rather than to the size of the file). Bunny has
accepted this in every test we could run without touching a live library, but it
is the one part of this path that only a real upload proves. If Bunny ever
answers `411 Length Required`, the fix is one line here — hand Bunny a body it
can measure — and nothing else in the system changes.
