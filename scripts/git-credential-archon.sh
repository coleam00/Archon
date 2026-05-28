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
# 127.0.0.1 binding. Exits 0 on non-github hosts or on resolution failure so
# git falls through to the next configured helper / prompts the user (which
# inside an unattended workflow surfaces a clear "Authentication failed").

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

[ "$host" = "github.com" ] || exit 0

port="${ARCHON_PORT:-3090}"
url="http://127.0.0.1:$port/internal/git-credential"
resp=$(curl -fsS -X POST -H 'Content-Type: application/json' \
  -d "{\"host\":\"$host\",\"path\":\"$path\"}" "$url") || exit 0

# Minimal JSON extract: only `{"token":"..."}` is supported. If the response
# shape grows we should switch to a small Node/Bun script.
token=$(printf '%s' "$resp" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$token" ] || exit 0

printf 'username=x-access-token\npassword=%s\n' "$token"
