# Deploying MockPrep to Cloud Run — from the console

Cloud Run watches the GitHub repo, Cloud Build builds the `Dockerfile` on
every push to `main`, and the service reads its five variables from Secret
Manager at start-up. The image carries no environment: `.dockerignore` keeps
every `.env*` out of the build context and nothing in the app reads a
variable at build time, so the same image serves any project. `/` is forced
dynamic for the same reason — with no env at build time Next would otherwise
prerender it and skip the signed-in redirect.

**A local `next build` is not the production shape.** Next inlines every
`NEXT_PUBLIC_*` variable it can see at build time, and a build run in this
checkout sees `.env.local`, so the server bundle it produces carries those
values and ignores the runtime environment. The Docker build never sees a
`.env*` file (`.dockerignore`), which is why the image reads them at start-up.
Found while trying to point a local build at a dead Supabase: it kept talking
to the real one. To test anything that depends on the runtime environment,
build from a copy of the tree with no `.env.local` in it.

Nothing below needs the `gcloud` CLI. `scripts/gcp-setup.sh` and
`scripts/deploy.sh` do the same from a terminal that has the SDK, if one
ever exists; `scripts/verify-deploy.sh` is plain curl and works anywhere.

The five values you will paste come from `.env.local`:

| Secret name | From `.env.local` |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | the `https://….supabase.co` URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the publishable key |
| `GEMINI_API_KEY` | Google AI Studio key |
| `GROQ_API_KEY` | Groq key |
| `OPENROUTER_API_KEY` | OpenRouter key |

The first two are publishable, not secret, but they live in Secret Manager
too so there is exactly one mechanism and nothing to bake into the image.

## 1. Project and billing

console.cloud.google.com → project picker in the top bar → **New project**
→ name it → **Create**. Then ☰ → **Billing** → **Link a billing account**.
Cloud Run will not create a service without one, even inside the free tier.

## 2. Secrets — five times

☰ → **Security** → **Secret Manager** → **Enable** the API if prompted →
**Create secret**. For each row of the table:

- **Name**: exactly the secret name from the table. The service maps each
  one to the environment variable of the same name.
- **Secret value**: paste the value from `.env.local` — the value only, no
  quotes, no trailing newline.
- Leave replication, rotation and expiry alone. **Create secret**.

## 3. The service

☰ → **Cloud Run** → **Create service**. Enable the API if prompted.

Under **Source**, choose **Continuously deploy from a repository (source or
function)** → **Set up with Cloud Build**:

- **Repository provider**: GitHub. **Authenticate** in the popup; install
  the *Google Cloud Build* GitHub app when asked and grant it
  `JaiKukreja-7/MockPrep`. If the repo is not in the list, **Manage
  connected repositories** and add it. Select it, tick the consent box,
  **Next**.
- **Branch**: `^main$` (the default).
- **Build Type**: **Dockerfile**.
- **Source location**: `/Dockerfile`. Leave the build context at `/`.
- **Save**.

Back on the form:

- **Service name**: `mockprep`.
- **Region**: the one nearest your Supabase project (Supabase dashboard →
  Project Settings → General shows its region).
- **Authentication**: **Allow unauthenticated invocations**. The app does
  its own auth; Cloud Run has to let the public in.
- **Billing**: Request-based.
- **Service scaling**: minimum instances `0`; expand it and set maximum
  instances `2`.
- **Ingress**: All.

Expand **Container(s), volumes, networking, security**:

- **Container port**: `8080`. The Dockerfile sets `PORT=8080` and Cloud Run
  sends the same value, so the server binds the right port either way.
- **Resources**: Memory `1 GiB`, CPU `1`. pdfjs holds a 4 MB PDF in memory
  while it reads it; 512 MiB is too tight.
- **Requests**: Request timeout `300` seconds. Maximum concurrent requests
  per instance `20` — the in-process LLM queue runs two provider calls at
  a time, so more requests per instance would only wait longer.
- **Variables & Secrets** tab → **Reference a secret**, five times:
  - **Secret**: pick it from the list.
  - **Reference method**: **Exposed as environment variable**.
  - **Name**: the same name as the secret, e.g. `GEMINI_API_KEY`.
  - **Version**: `latest`.
  - If a yellow bar says the service account lacks access, click **Grant**
    on it. That gives the Compute Engine default service account — what the
    service runs as — *Secret Manager Secret Accessor*. Without it the
    first revision fails to start with a permissions error on the secret.
- Security and Networking stay default.

**Create**. The first build takes a few minutes; watch it on the service's
**Revisions** tab or ☰ → **Cloud Build** → **History**. When the revision
goes green the URL is at the top of the service page:
`https://mockprep-<number>.<region>.run.app`.

From now on every push to `main` builds and deploys. That is the whole
release process. The image build runs the unit test project before
`next build` (`npm run build` is `npm run test:unit && next build`), so a
red invariant fails the deploy; the integration and design-audit projects
run in GitHub Actions (`.github/workflows/ci.yml`) and need the two public
Supabase variables as repository secrets.

## 4. Supabase — tell it about the new origin

Magic links and the auth callback land on the production origin, and
Supabase only follows redirects it has been told about. Supabase dashboard
→ **Authentication** → **URL Configuration**:

- **Site URL**: the service URL.
- **Redirect URLs** → **Add URL**: `https://<service-url>/auth/callback`.
  Keep `http://localhost:3000/auth/callback` for development.

Until this is done, sign-in emails link back to localhost.

## 5. Verify

Plain bash and curl:

```bash
scripts/verify-deploy.sh https://mockprep-<number>.<region>.run.app
```

Twelve checks from outside: the landing page serves, every private route
redirects to sign-in, the API returns a JSON 401 without a session, the
screenshots and the image optimiser work, HTTP redirects to HTTPS.

**The quota cap** cannot be checked from outside — it needs a signed-in
round. On the live URL, sign in (or *Try a round as a guest*), start a text
round, then open **Settings**: the usage line should read one used against
the cap. The cap is `consume_llm_quota` in Postgres under a row lock, so it
holds across instances by construction; this confirms the deployed instance
is calling it. If the function were missing the round would fail with a 500
rather than run uncapped — `lib/llm/quota.ts` throws in production.

**Fail-closed on the real service** (optional): on the service page, **Edit
& deploy new revision** → **Variables & Secrets** → remove all five secret
references → untick **Serve this revision immediately** → **Deploy**. Live
traffic stays on the good revision. On the **Revisions** tab open the new
revision; its own address is shown there
(`https://<revision>---mockprep-<…>.run.app`). Every route on it should be a
500 and its **Logs** should show *Supabase environment variables are
missing in production*. Then delete that revision from the Revisions tab
(⋮ → **Delete**). Traffic was never on it.

## Sizing, and what is not yet production-grade

- 1 vCPU, 1 GiB, concurrency 20, 0–2 instances, 300 s timeout. Scale to
  zero means the first request after a quiet spell takes a few seconds.
- The LLM queue (`lib/llm/queue.ts`, two calls at a time with backoff) is
  per instance. Two instances means up to four concurrent provider calls,
  inside every free tier's rate limit. Raise the maximum only with that in
  mind.
- The stale-round sweep runs on read, not on a schedule; nothing here needs
  Cloud Scheduler yet.
- Logs: the service page → **Logs** tab.
