#!/usr/bin/env bash
# Build the image in Cloud Build from the Dockerfile and deploy it to Cloud Run.
#
#   PROJECT=my-gcp-project REGION=us-central1 scripts/deploy.sh
#
# Run scripts/gcp-setup.sh once first. Nothing from .env.local is read here:
# every variable the app needs is mounted from Secret Manager at start-up,
# which is why the same image serves any environment.
set -euo pipefail

: "${PROJECT:?Set PROJECT to your Google Cloud project id}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-mockprep}"

# name-in-container=secret-name:version, one per variable the server reads.
SECRET_FLAGS=$(printf '%s=%s:latest,' \
  NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_URL \
  NEXT_PUBLIC_SUPABASE_ANON_KEY NEXT_PUBLIC_SUPABASE_ANON_KEY \
  GEMINI_API_KEY GEMINI_API_KEY \
  GROQ_API_KEY GROQ_API_KEY \
  OPENROUTER_API_KEY OPENROUTER_API_KEY)
SECRET_FLAGS="${SECRET_FLAGS%,}"

gcloud config set project "$PROJECT" >/dev/null

# --source with a Dockerfile present builds that Dockerfile in Cloud Build
# and pushes to the cloud-run-source-deploy Artifact Registry repo, which is
# created on first use. Sizing: 1 GiB because pdfjs holds a 4 MB PDF in
# memory while it reads it; concurrency 20 because the in-process LLM queue
# runs two calls at a time, so more requests per instance only wait longer.
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --cpu 1 \
  --memory 1Gi \
  --min-instances 0 \
  --max-instances 2 \
  --concurrency 20 \
  --timeout 300 \
  --set-secrets "$SECRET_FLAGS"

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
echo
echo "Live at: $URL"
echo
echo "Now add it to Supabase → Authentication → URL Configuration:"
echo "  Site URL:      $URL"
echo "  Redirect URLs: $URL/auth/callback"
echo
echo "Then: scripts/verify-deploy.sh $URL"
