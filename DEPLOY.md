# Deploying MockPrep to Cloud Run

One container image, built by Cloud Build from the `Dockerfile`, run by Cloud
Run, configured entirely from Secret Manager at start-up. The image carries no
environment: `.dockerignore` keeps every `.env*` out of the build context, and
nothing in the app reads a variable at build time, so the same image serves
any project. `/` is forced dynamic for the same reason — with no env at build
time Next would otherwise prerender it and skip the signed-in redirect.

## What you do once, in the console

1. **Project and billing.** Pick or create a project at
   console.cloud.google.com, then enable billing on it (Billing → Link a
   billing account). Cloud Run will not deploy without a billing account even
   inside the free tier.
2. **Install the CLI and sign in.** This is the only interactive step; it
   opens a browser for your Google account.

   ```bash
   brew install --cask google-cloud-sdk
   ```

   ```bash
   gcloud auth login
   ```

3. **APIs and secrets.** Enables Cloud Run, Cloud Build, Artifact Registry and
   Secret Manager, then prompts for each of the five values — copy them from
   `.env.local`. Values are read silently and piped in; they never appear on a
   command line. Pick the region closest to your Supabase project.

   ```bash
   PROJECT=your-project-id REGION=us-central1 scripts/gcp-setup.sh
   ```

## Deploy

```bash
PROJECT=your-project-id REGION=us-central1 scripts/deploy.sh
```

Builds remotely (a few minutes the first time), deploys, and prints the
service URL — `https://mockprep-<number>.<region>.run.app`. Re-run to ship a
new version; it is the whole release process.

## After the first deploy: Supabase

Magic links and the auth callback land on the production origin, which
Supabase has to be told about. Supabase dashboard → Authentication → URL
Configuration:

- **Site URL**: the service URL.
- **Redirect URLs**: add `https://<service-url>/auth/callback`. Keep
  `http://localhost:3000/auth/callback` for development.

Until this is done, sign-in emails will link back to localhost.

## Verify

```bash
scripts/verify-deploy.sh https://mockprep-<number>.<region>.run.app
```

Twelve checks from outside: landing serves, every private route redirects to
sign-in, the API returns a JSON 401 without a session, the screenshots and
image optimiser work, HTTP redirects to HTTPS.

**The quota cap** cannot be checked from outside — it needs a signed-in round.
On the live URL, sign in (or "Try a round as a guest"), start a text round,
then open Settings: the usage line should read one used against the cap.
The cap is enforced by `consume_llm_quota` inside Postgres with a row lock,
so it holds across instances by construction; this check confirms the
deployed instance is calling it. If the function were missing, the round
would fail with a 500 rather than run uncapped — `lib/llm/quota.ts` throws in
production.

**Fail-closed on the real service** (optional, one minute): deploy a
no-traffic revision with the secrets removed, hit its tagged URL, expect 500
on every route, then remove it. Live traffic stays on the good revision
throughout — `--no-traffic` leaves it pinned there.

```bash
gcloud run deploy mockprep --region us-central1 --image "$(gcloud run services describe mockprep --region us-central1 --format='value(spec.template.spec.containers[0].image)')" --clear-secrets --no-traffic --tag noenv
```

It prints the tag URL, `https://noenv---mockprep-<…>.run.app`. Expect `500`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://noenv---mockprep-<…>.run.app/
```

Then drop the tag, delete the revision (the newest, so `--limit 1`), and
un-pin traffic. Order matters: `--no-traffic` pins the service to the good
revision, and until `--to-latest` is restored every future deploy would
receive 0% — but `--to-latest` must run only once the broken revision is
gone, or it would be the latest.

```bash
gcloud run services update-traffic mockprep --region us-central1 --remove-tags noenv && gcloud run revisions delete "$(gcloud run revisions list --service mockprep --region us-central1 --limit 1 --format='value(metadata.name)')" --region us-central1 --quiet && gcloud run services update-traffic mockprep --region us-central1 --to-latest
```

## Sizing, and what is not yet production-grade

- 1 vCPU, 1 GiB (pdfjs holds a 4 MB PDF in memory), concurrency 20, 0–2
  instances, 300 s timeout. Scale to zero means the first request after a
  quiet spell takes a few seconds.
- The LLM queue (`lib/llm/queue.ts`, two calls at a time with backoff) is
  per instance. Two instances means up to four concurrent provider calls,
  which is inside every free tier's rate limit. Raise `--max-instances`
  only with that in mind.
- The stale-round sweep runs on read, not on a schedule; nothing here needs
  Cloud Scheduler yet.
- Logs: `gcloud run services logs read mockprep --region us-central1`.
