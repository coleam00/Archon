#!/bin/sh
# Git credential helper for the Archon GitHub App.
#
# Called by git when authenticating against github.com on a worktree where
# this helper is configured via `git config credential.helper`.
#
# Protocol (https://git-scm.com/docs/gitcredentials):
#   stdin (helper get):
#     protocol=https
#     host=github.com
#     path=owner/repo.git
#     (blank line)
#   stdout:
#     username=x-access-token
#     password=<fresh installation token>
#
# Talks to Archon over loopback only; the endpoint is documented as requiring
# 127.0.0.1 binding. On any fall-through (non-github host, malformed path,
# server unreachable, empty response) the script exits 0 with no stdout AND
# a one-line stderr diagnostic so git falls through to the next helper /
# surfaces a clear failure to an unattended workflow without losing the
# root cause.

action="$1"
[ "$action" = "get" ] || exit 0

host=""
path=""
while IFS='=' read -r key value; do
  [ -z "$key" ] && break
  case "$key" in
    host) host="$value" ;;
    path) path="$value" ;;
  esac
done

if [ "$host" != "github.com" ]; then
  printf 'git-credential-archon: ignoring non-github host (%s)\n' "$host" >&2
  exit 0
fi

# Path must look like "owner/repo" or "owner/repo.git". Defence-in-depth —
# the server's regex blocks bad paths at the API layer too, but mirroring
# the contract here keeps the credential helper safe even if someone wires
# it up against a different (or older) Archon server.
case "$path" in
  */*) ;;
  *)
    printf 'git-credential-archon: malformed path (%s); expected owner/repo[.git]\n' "$path" >&2
    exit 0
    ;;
esac

port="${ARCHON_PORT:-3090}"
url="http://127.0.0.1:$port/internal/git-credential"

# Capture stderr separately so a curl failure (server unreachable, 5xx) can
# be surfaced to the workflow without leaking through git's interactive
# prompt path. --connect-timeout / --max-time keep git from blocking
# indefinitely when Archon isn't listening on the expected port.
resp=$(curl -fsS --connect-timeout 2 --max-time 5 -X POST \
  -H 'Content-Type: application/json' \
  -d "{\"host\":\"$host\",\"path\":\"$path\"}" "$url" 2>/tmp/git-credential-archon.curlerr)
curl_status=$?
if [ "$curl_status" -ne 0 ]; then
  printf 'git-credential-archon: curl to %s failed (exit %d): %s\n' \
    "$url" "$curl_status" "$(cat /tmp/git-credential-archon.curlerr 2>/dev/null)" >&2
  rm -f /tmp/git-credential-archon.curlerr
  exit 0
fi
rm -f /tmp/git-credential-archon.curlerr

# Minimal JSON extract: only `{"token":"..."}` is supported. If the response
# shape grows we should switch to a small Node/Bun script.
token=$(printf '%s' "$resp" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
if [ -z "$token" ]; then
  printf 'git-credential-archon: server returned no token (resp len=%d)\n' \
    "$(printf '%s' "$resp" | wc -c)" >&2
  exit 0
fi

printf 'username=x-access-token\npassword=%s\n' "$token"
