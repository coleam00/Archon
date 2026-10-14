#!/bin/sh
# `gh` shim for Archon workflow runs in GitHub App mode.
#
# Archon puts this script's directory first on PATH only for runs whose
# GH_TOKEN is the App installation token, and sets:
#   ARCHON_PORT             the App-mode server serving /internal/git-credential
#   ARCHON_GITHUB_APP_REPO  owner/repo the run's dispatch token was minted for
#
# Each call asks that loopback endpoint for a current installation token and
# execs the real `gh` with it in GH_TOKEN/GITHUB_TOKEN, so a run outlives its
# dispatch-time token. A GH_TOKEN that is not an installation token (`ghs_`
# prefix, e.g. one a step set itself) passes through unchanged. When a refresh
# is due but fails, the shim exits 1 without running `gh`: a stale token would
# only turn the failure into a later 401. The token travels in the environment
# only, never in argv or output.

self="$0"
real_gh=""
saved_ifs=$IFS
IFS=:
set -f
for dir in $PATH; do
  [ -n "$dir" ] || continue
  candidate="$dir/gh"
  if [ -f "$candidate" ] && [ -x "$candidate" ] && ! [ "$candidate" -ef "$self" ]; then
    real_gh="$candidate"
    break
  fi
done
set +f
IFS=$saved_ifs

if [ -z "$real_gh" ]; then
  printf 'gh (archon shim): no gh executable found on PATH\n' >&2
  exit 127
fi

case "${GH_TOKEN:-}" in
  ghs_*) ;;
  *) exec "$real_gh" "$@" ;;
esac

fail() {
  printf 'gh (archon shim): cannot refresh the GitHub App token: %s\n' "$1" >&2
  exit 1
}

repo="${ARCHON_GITHUB_APP_REPO:-}"
case "$repo" in
  *[!a-zA-Z0-9_./-]* | */*/* | /* | */) fail 'ARCHON_GITHUB_APP_REPO is not owner/repo' ;;
  ?*/?*) ;;
  *) fail 'ARCHON_GITHUB_APP_REPO is not owner/repo' ;;
esac

port="${ARCHON_PORT:-}"
case "$port" in
  ''|*[!0-9]*|??????*) fail 'missing or invalid ARCHON_PORT' ;;
esac
if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
  fail 'missing or invalid ARCHON_PORT'
fi
url="http://127.0.0.1:$port/internal/git-credential"

# Same request and response shape as git-credential-archon. GitHub names contain
# no JSON metacharacters, so interpolation preserves the literal repository.
resp=$(curl -fsS --connect-timeout 2 --max-time 5 -X POST \
  -H 'Content-Type: application/json' \
  -d "{\"host\":\"github.com\",\"path\":\"$repo\"}" "$url" 2>/dev/null)
curl_status=$?
if [ "$curl_status" -ne 0 ]; then
  fail "curl to $url failed (exit $curl_status)"
fi

token=$(printf '%s' "$resp" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
if [ -z "$token" ]; then
  fail "server returned no token (resp len=$(printf '%s' "$resp" | wc -c | tr -d ' '))"
fi

GH_TOKEN=$token
GITHUB_TOKEN=$token
export GH_TOKEN GITHUB_TOKEN
exec "$real_gh" "$@"
