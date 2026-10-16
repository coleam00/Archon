#!/bin/sh
# `gh` shim for Archon workflow runs in GitHub App mode.
#
# Archon puts this script's directory first on PATH only for runs whose
# GH_TOKEN is the App installation token, and sets:
#   ARCHON_PORT             the App-mode server serving /internal/git-credential
#   ARCHON_GITHUB_APP_REPO  owner/repo the run's dispatch token was minted for
#
# Each call asks that loopback endpoint, through git-credential-archon in the
# parent directory, for a current installation token and execs the real `gh`
# with it in GH_TOKEN/GITHUB_TOKEN, so a run outlives its dispatch-time token.
# A GH_TOKEN that is not an installation token (`ghs_` prefix, e.g. one a step
# set itself) passes through unchanged. When a refresh is due but fails, the
# shim exits 1 without running `gh`: a stale token would only turn the failure
# into a later 401. The token travels in the environment only, never in argv
# or output, except for the explicit `gh auth token` credential request.

fail() {
  printf 'gh (archon shim): cannot refresh the GitHub App token: %s\n' "$1" >&2
  exit 1
}

self="$0"
exec_real_gh() {
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
  exec "$real_gh" "$@"
}

case "${GH_TOKEN:-}" in
  ghs_*) ;;
  *) exec_real_gh "$@" ;;
esac

# git-credential-archon owns the loopback request and the repository check. It
# exits 0 with no password on failure, after printing its own diagnostic.
helper="$(dirname "$self")/../git-credential-archon"
[ -x "$helper" ] || fail "credential helper not found at $helper"
token=$(printf 'host=github.com\npath=%s\n\n' "${ARCHON_GITHUB_APP_REPO:-}" \
  | "$helper" get | sed -n 's/^password=//p')
if [ -z "$token" ]; then
  fail 'credential helper returned no token'
fi

# Forge operations use this credential request without needing the real CLI.
if [ "$#" -eq 4 ] && [ "$1" = auth ] && [ "$2" = token ] && \
  [ "$3" = --hostname ] && [ "$4" = github.com ]; then
  printf '%s\n' "$token"
  exit 0
fi

GH_TOKEN=$token
GITHUB_TOKEN=$token
export GH_TOKEN GITHUB_TOKEN
exec_real_gh "$@"
