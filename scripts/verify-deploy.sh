#!/usr/bin/env bash
# Black-box checks against a deployed URL. Exit code is the number of failures.
#
#   scripts/verify-deploy.sh https://mockprep-xxxx.run.app
#
# What it proves from outside: the landing page serves, the proxy gates every
# private route, the API refuses unauthenticated calls with JSON not HTML,
# the screenshots and the image optimiser work, and the app is not served
# over plain HTTP. What it cannot prove: the quota cap, which needs a signed-in
# round — see DEPLOY.md for that check.
set -uo pipefail

URL="${1:?Pass the service URL}"
URL="${URL%/}"
fail=0

check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    printf '  ✓ %-46s %s\n' "$label" "$actual"
  else
    printf '  ✗ %-46s got %s, wanted %s\n' "$label" "$actual" "$expected"
    fail=$((fail + 1))
  fi
}

status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
redirect() { curl -s -o /dev/null -w '%{redirect_url}' "$@" | sed "s#^$URL##"; }

echo "Checking $URL"
check "GET /  (landing)"                 200 "$(status "$URL/")"
check "GET /  says the headline"         yes "$(curl -s "$URL/" | grep -q 'Go again' && echo yes || echo no)"
check "GET /dashboard → sign-in"         "/sign-in?next=%2Fdashboard" "$(redirect "$URL/dashboard")"
check "GET /sessions  → sign-in"         "/sign-in?next=%2Fsessions"  "$(redirect "$URL/sessions")"
check "GET /resume    → sign-in"         "/sign-in?next=%2Fresume"    "$(redirect "$URL/resume")"
check "GET /report/x  → sign-in"         "/sign-in?next=%2Freport%2Fx" "$(redirect "$URL/report/x")"
check "POST /api/voice/turn (no session)" 401 "$(status -X POST "$URL/api/voice/turn")"
check "  …as JSON, not a sign-in page"   yes "$(curl -s -X POST "$URL/api/voice/turn" | grep -q '"error"' && echo yes || echo no)"
check "GET /sign-in"                     200 "$(status "$URL/sign-in")"
check "GET /landing/session.png"         200 "$(status "$URL/landing/session.png")"
check "GET /_next/image (optimiser)"     200 "$(status "$URL/_next/image?url=%2Flanding%2Fsession.png&w=1920&q=75")"
# Vercel answers 308, Cloud Run's front end 301; both are a permanent redirect.
http_status="$(status "${URL/https:/http:}/")"
check "HTTP → HTTPS (301 or 308)"          "redirect" "$([[ "$http_status" == 301 || "$http_status" == 308 ]] && echo redirect || echo "$http_status")"

echo
if [[ $fail -eq 0 ]]; then echo "All checks passed."; else echo "$fail check(s) failed."; fi
exit $fail
