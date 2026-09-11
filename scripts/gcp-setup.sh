#!/usr/bin/env bash
# One-time project setup for Cloud Run. Idempotent — safe to re-run.
#
#   PROJECT=my-gcp-project REGION=us-central1 scripts/gcp-setup.sh
#
# Enables the four APIs the deploy needs, creates one Secret Manager secret
# per variable the app reads (prompting for each value — nothing is passed
# on the command line, so nothing lands in shell history), and lets the
# Cloud Run runtime account read them. Billing must already be on: Cloud Run
# refuses to deploy without it, and that is a console step (see DEPLOY.md).
set -euo pipefail

: "${PROJECT:?Set PROJECT to your Google Cloud project id}"
REGION="${REGION:-us-central1}"

# Everything the server reads from process.env, in one place. The two
# NEXT_PUBLIC_ values are publishable, not secret, but they live here too so
# there is exactly one mechanism and nothing is baked into the image.
SECRETS=(
  NEXT_PUBLIC_SUPABASE_URL
  NEXT_PUBLIC_SUPABASE_ANON_KEY
  GEMINI_API_KEY
  GROQ_API_KEY
  OPENROUTER_API_KEY
)

gcloud config set project "$PROJECT" >/dev/null

echo "Enabling APIs (Cloud Run, Cloud Build, Artifact Registry, Secret Manager)…"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

for name in "${SECRETS[@]}"; do
  if gcloud secrets describe "$name" >/dev/null 2>&1; then
    read -r -p "$name exists. Add a new version? [y/N] " answer
    [[ "$answer" =~ ^[Yy]$ ]] || continue
  else
    gcloud secrets create "$name" --replication-policy=automatic >/dev/null
  fi
  # -s: the value is not echoed. Piped straight in; never an argument.
  read -r -s -p "Value for $name: " value
  echo
  printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- >/dev/null
  unset value
  # The runtime account is what the service runs as; without this the
  # revision fails to start with a permission error on the secret.
  gcloud secrets add-iam-policy-binding "$name" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role="roles/secretmanager.secretAccessor" >/dev/null
  echo "  $name ✓"
done

echo
echo "Done. Deploy with: PROJECT=$PROJECT REGION=$REGION scripts/deploy.sh"
