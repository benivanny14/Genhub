# Bunny upload proxy (Cloudflare Worker)

One job: accept a `PUT` from a creator's browser, verify the token Genhub's server
signed for **that one video id**, and stream the body on to Bunny with the library
`AccessKey` attached. The key never leaves this Worker.

```
browser ──PUT (token in query string)──▶ this Worker ──PUT (AccessKey)──▶ video.bunnycdn.com
```

## Why it exists

Bunny's one-shot upload endpoint (`PUT /library/{id}/videos/{guid}`) authenticates
with the library **API key**, and that key can upload, rename and *delete every
video in the library*. Putting it in a browser means anyone who opens DevTools can
empty Genhub.

Bunny's own answer for browsers is its signed resumable endpoint, which the app
already uses (`src/lib/tus-upload.ts`). This Worker is the second answer, for the
single-`PUT` transport (`src/lib/upload-put.ts`) — one request, one progress bar,
no chunk bookkeeping, and no dependency on the resumable endpoint.

The app **only** takes this path when `BUNNY_UPLOAD_PROXY_URL` and
`BUNNY_UPLOAD_PROXY_SECRET` are both set **and** the file fits in one request.
With nothing configured, uploads run on the resumable path exactly as before —
which is why the Next side can be deployed before or after this Worker.

## What the token can and cannot do

The Next server (`src/lib/upload-proxy-token.ts`) signs `v1:{videoId}:{expiresAt}`
with HMAC-SHA256 keyed on `BUNNY_UPLOAD_PROXY_SECRET`, and hands the browser the
result in the URL. It authorizes:

* **one** video id, which the server already reserved in the library, and
* until **one** deadline (one hour).

It cannot list, read, rename or delete anything, and it cannot create a video
object. That is the same deliberate limit as the TUS authorization, for the same
reason: a credential that reaches a browser must be worth as little as possible.

The token rides in the **query string** rather than a header so the Worker can
authorize *before* reading a body it would otherwise have to buffer — an
unauthorized request is refused without transferring a byte of the file. The cost
is that the URL lands in proxy logs, which is why the token fills only a slot that
was already reserved and why it expires.

## Deploy

From this directory (`worker/bunny-upload`):

```bash
npx wrangler login

# Secrets — never in wrangler.toml, never in git.
npx wrangler secret put BUNNY_STREAM_API_KEY        # the Stream library API key
npx wrangler secret put BUNNY_UPLOAD_PROXY_SECRET   # openssl rand -hex 32

npx wrangler deploy
```

Edit `[vars]` in `wrangler.toml` first: `BUNNY_STREAM_LIBRARY_ID` and
`ALLOWED_ORIGINS` (every origin creators upload from — the production domain and
`http://localhost:3000` while developing). `ALLOWED_ORIGINS` is matched exactly;
a forgotten origin fails as a CORS error in the browser.

Then, on the **Next** deployment (Vercel → Settings → Environment Variables):

| Variable | Value |
| --- | --- |
| `BUNNY_UPLOAD_PROXY_URL` | the deployed Worker URL, e.g. `https://genhub-bunny-upload.<account>.workers.dev` |
| `BUNNY_UPLOAD_PROXY_SECRET` | **the same string** you gave `wrangler secret put` |
| `BUNNY_UPLOAD_PROXY_MAX_BYTES` | optional; defaults to `104857600` (100 MB) |

`/api/health` and the production config audit warn when only one of the two is
set — a half-configured proxy is worse than none, because the browser would be
sent to a Worker that cannot verify a token this server never signed.

## Verify it is actually working

These are the checks that distinguish "deployed" from "working". In order:

```bash
# 1. Liveness. Reveals only whether each value is present, never the value.
curl -s https://<worker-url> | jq
#    → {"ok":true,"libraryConfigured":true,"secretConfigured":true}

# 2. CORS, which is where a forgotten origin shows up.
curl -s -o /dev/null -D - -X OPTIONS https://<worker-url> \
  -H "Origin: https://genhub-two.vercel.app" \
  -H "Access-Control-Request-Method: PUT"
#    → 204, access-control-allow-origin echoing that origin

# 3. It refuses an unsigned request WITHOUT reading a body.
curl -s -o /dev/null -w '%{http_code}\n' -X PUT https://<worker-url>?videoId=abc
#    → 401
```

Then the real test, which is the only one that proves the bytes arrive: **upload a
file from the creator page** on a phone and confirm in the Bunny dashboard that
the video object goes from `0 bytes` to the file's size and starts encoding.

Two failures worth knowing by sight:

* **413** — the file is larger than `MAX_UPLOAD_BYTES`. The client is supposed to
  have checked the size and taken the resumable path; a 413 in the log means the
  two ceilings disagree (`BUNNY_UPLOAD_PROXY_MAX_BYTES` on Next above
  `MAX_UPLOAD_BYTES` here).
* **401** — the tokens do not match. Almost always `BUNNY_UPLOAD_PROXY_SECRET`
  differing between the Worker and the Next deployment (a redeploy with the
  secret changed on one side only), or a clock skewed far enough that the one-hour
  window had passed.
* **400 from Bunny on a body of a perfectly reasonable size** — the one part of
  this path that cannot be checked without a deployment. The body is streamed on
  rather than buffered, so the upstream request to Bunny may be chunked rather
  than length-delimited. If Bunny ever refuses that shape, the fix is here and
  nowhere else: pass the request's own `Content-Length` through to the upstream
  `fetch` when it has one, instead of relying on the runtime to describe the
  stream.

## Costs and limits

* **100 MB** per request on the Free and Pro plans (Cloudflare refuses the body
  before this Worker runs); 200 MB on Business, 500 MB on Enterprise. Larger files
  stay on the resumable path, which is deliberate: a whole-file `PUT` that dies at
  90% has no offset to resume from, so re-sending it costs the creator everything
  already sent.
* **No resume**, by construction — see `src/lib/upload-put.ts` for the short retry
  ladder that is short *because* there is nothing to resume.
* **CPU** is negligible: the body is streamed, not buffered, so a 90 MB upload
  costs a few kilobytes of memory rather than 90.
