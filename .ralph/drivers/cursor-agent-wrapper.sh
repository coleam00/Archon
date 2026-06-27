#!/bin/bash
# Wrap Windows .cmd execution so GNU timeout launches a bash script instead of the .cmd directly.

set -euo pipefail

cli_path=${1:-}
if [[ -z "$cli_path" ]]; then
    echo "ERROR: Missing Cursor CLI path" >&2
    exit 1
fi

shift
exec "$cli_path" "$@"
