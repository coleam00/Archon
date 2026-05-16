#!/usr/bin/env bash
# Hook: Stop — remind about git checkpoint if uncommitted changes exist
# Exit: always 0 (advisory only)

if [[ -n $(git status --porcelain 2>/dev/null) ]]; then
    echo "Uncommitted changes detected. Consider creating a git checkpoint with /checkpoint." >&2
fi

exit 0
