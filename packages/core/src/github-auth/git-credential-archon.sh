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
  printf 'git-credential-archon: ignoring non-github host\n' >&2
  exit 0
fi

# GitHub names contain no JSON metacharacters, so interpolation preserves the literal path.
# The server owns the owner/repo shape check; a path it rejects gets no token.
case "$path" in
  *[!a-zA-Z0-9_./-]*)
    printf 'git-credential-archon: malformed path; expected owner/repo[.git]\n' >&2
    exit 0
    ;;
  */*) ;;
  *)
    printf 'git-credential-archon: malformed path; expected owner/repo[.git]\n' >&2
    exit 0
    ;;
esac

# The server publishes its actual bound port before starting child work.
port="${ARCHON_PORT:-}"
case "$port" in
  ''|*[!0-9]*|??????*)
    printf 'git-credential-archon: missing or invalid server port\n' >&2
    exit 0
    ;;
esac
if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
  printf 'git-credential-archon: missing or invalid server port\n' >&2
  exit 0
fi
url="http://127.0.0.1:$port/internal/git-credential"

# Bound curl's wait without forwarding server or transport text into diagnostics.
resp=$(curl -fsS --connect-timeout 2 --max-time 5 -X POST \
  -H 'Content-Type: application/json' \
  -d "{\"host\":\"$host\",\"path\":\"$path\"}" "$url" 2>/dev/null)
curl_status=$?
if [ "$curl_status" -ne 0 ]; then
  printf 'git-credential-archon: curl to %s failed (exit %d)\n' \
    "$url" "$curl_status" >&2
  exit 0
fi

# Minimal JSON extract: only `{"token":"..."}` is supported. If the response
# shape grows we should switch to a small Node/Bun script.
token=$(printf '%s' "$resp" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
if [ -z "$token" ]; then
  printf 'git-credential-archon: server returned no token (resp len=%d)\n' \
    "$(printf '%s' "$resp" | wc -c)" >&2
  exit 0
fi

printf 'username=x-access-token\npassword=%s\n' "$token"
