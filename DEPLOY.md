# Deploying MockPrep to Vercel

Vercel imports the GitHub repo, builds it with `npm run build` on every push
to `main` (which runs the unit test project before `next build`, so a red
invariant fails the deploy), and turns each route into a function sized by
that route's `maxDuration`. The five environment variables live in the
project's settings.

## What you do once, in the Vercel dashboard

1. **Import the repo.** vercel.com/new → *Import Git Repository* → connect
   GitHub if asked → pick `JaiKukreja-7/MockPrep`. Framework preset is
   detected as Next.js; leave the root directory and build command alone.
2. **Environment variables** (on the import screen, or later under Project
   → Settings → Environment Variables). All five, for *Production* — and for
   *Preview* too if you want preview deployments to work:

   | Name | From `.env.local` |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | the `https://….supabase.co` URL |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the publishable key |
   | `GEMINI_API_KEY` | Google AI Studio key |
   | `GROQ_API_KEY` | Groq key |
   | `OPENROUTER_API_KEY` | OpenRouter key |

   The two `NEXT_PUBLIC_` values are inlined into the build. On Vercel that
   is fine: each environment builds with its own values, so production and
   preview cannot cross. (This is the same fact that makes a *local* build
   carry `.env.local` — see the note at the end.)
3. **Deploy.** The first build takes a few minutes. The URL is on the
   project page: `https://mockprep-<hash>.vercel.app`, plus the stable
   `https://<project-name>.vercel.app`.
4. **Node version** — Settings → General → Node.js Version. The project is
   developed and tested on 24; pick 24.x if offered, otherwise 22.x runs it
   (nothing in the app needs 24-only APIs; only the local scripts do).
5. **Function region** — Settings → Functions → Function Region: the one
   nearest your Supabase project. Every request talks to Supabase; the
   round trip is the latency you will feel.
6. **Fluid compute** is on by default for new projects; leave it on. The
   `maxDuration` values below need it — without it the Hobby plan caps
   functions at 60 seconds and the deploy is refused.

From now on every push to `main` builds and deploys; pull requests get
preview deployments.

## Function durations

A server action runs under the segment config of the page that posts it, so
the limits are on the pages, not in the actions:

| Route | `maxDuration` | Why |
|---|---|---|
| `/dashboard` | 120 s | `startRound` — question generation can walk the 1/2/4/8 s backoff ladder on one provider, then fail over |
| `/session/[id]` | 120 s | `submitAnswer` / `scoreRound` — scoring and flag extraction in parallel, each with the ladder; 30 s has been seen |
| `/report/[id]` | 120 s | `scoreRound` from the unscored report |
| `/resume` | 120 s | extraction of a 4 MB PDF plus the audit |
| `/api/voice/turn` | 300 s | Whisper, the bridge line, and on the last turn the whole scoring pipeline |

300 s is the ceiling on Hobby and Pro with Fluid compute. Everything else
stays on the default.

## pdfjs on Vercel — confirmed by trace

`pdfjs-dist` and `mammoth` are `serverExternalPackages`, so they are loaded
from `node_modules` at runtime rather than bundled. Vercel builds each
function from Next's output file trace, and the trace for `/resume` did
**not** include `pdf.worker.mjs`: in Node, pdfjs loads its worker with a
runtime `import("./pdf.worker.mjs")` the tracer cannot see, so every upload
would have failed with *Setting up fake worker failed*. `next.config.ts`
pins the file with `outputFileTracingIncludes` for `/resume`. Verified two
ways: the `.nft.json` for the route now lists the worker, and a PDF parsed
from the standalone output's `node_modules` alone — assembled from those
same traces — reads correctly. (The same fix applies to the Docker path,
which had the latent gap too.)

## After the first deploy: Supabase

Supabase dashboard → **Authentication** → **URL Configuration**:

- **Site URL**: the production URL.
- **Redirect URLs** → add `https://<production-domain>/auth/callback`. Keep
  `http://localhost:3000/auth/callback` for development. For preview
  deployments add the wildcard
  `https://*-<your-vercel-team>.vercel.app/auth/callback` (the team slug is
  in every preview URL).

Until this is done, sign-in emails link back to localhost.

## Verify

```bash
scripts/verify-deploy.sh https://<production-domain>
```

Twelve checks from outside: the landing page serves, every private route
redirects to sign-in, the API answers a JSON 401 without a session, the
screenshots and the image optimiser work, HTTP redirects to HTTPS (Vercel
answers 308).

**The quota cap** needs a signed-in round: sign in (or *Try a round as a
guest*), start a text round, open **Settings** — one used against the cap.
The cap is `consume_llm_quota` in Postgres under a row lock, so it holds
across function instances by construction.

**Fail-closed**: with the two Supabase variables removed from an
environment, every route answers 500 with *Supabase environment variables
are missing in production* (the proxy refuses to serve). Test it on a
preview environment, never production.

**During a Supabase outage** the proxy serves `/unavailable` for private
pages, a JSON 503 for the API, and sets `x-mockprep-outage: 1` on every
response, so monitoring can tell "MockPrep is down" from "MockPrep cannot
reach its database".

## What is not yet production-grade

- The LLM queue (`lib/llm/queue.ts`, two calls at a time with backoff) is
  per function instance. Vercel scales instances freely, so the effective
  concurrency against each free tier is unbounded under load. A shared
  limiter (Upstash, or the providers' own quotas) is the fix if that ever
  bites.
- The stale-round sweep runs on read, not on a schedule. Vercel Cron could
  call a route for it; nothing needs it yet.
- Logs: the project's **Logs** tab; the proxy's outage line and every
  `[mockprep]` line from `describeLlmFailure` land there.

## A local `next build` is not the production shape

Next inlines every `NEXT_PUBLIC_*` variable it can see at build time, and a
build run in this checkout sees `.env.local`, so the server bundle it
produces carries those values and ignores the runtime environment. Found
while trying to point a local build at a dead Supabase: it kept talking to
the real one. To test anything that depends on the runtime environment,
build from a copy of the tree with no `.env.local` in it.

## The previous path: Cloud Run

`Dockerfile`, `.dockerignore`, `scripts/gcp-setup.sh` and `scripts/deploy.sh`
still describe a working Cloud Run deployment (secrets from Secret Manager
at start-up, nothing baked). `output: "standalone"` in `next.config.ts` is
for that path only: it is set when `VERCEL` is not in the environment.
On Vercel it must be off — the adapter packages functions itself and does
not write `.next/next-server.js.nft.json`, and Next's standalone copy step
runs right after the adapter hook and opens that file, so the first Vercel
build failed with ENOENT there. The pdfjs `outputFileTracingIncludes` is
independent of `output`: it lands in the per-route `.nft.json` files, which
are exactly what the Vercel adapter reads (verified with a `VERCEL=1`
build).
