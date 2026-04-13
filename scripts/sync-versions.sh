#!/usr/bin/env bash
# Sync all workspace package versions to match the root package.json version.
# Called by the release skill after bumping the root version.
#
# Usage: bash scripts/sync-versions.sh

set -euo pipefail

ROOT_VERSION=$(node -e "console.log(require('./package.json').version)")

echo "Syncing workspace packages to v${ROOT_VERSION}..."

for pkg in packages/*/package.json; do
  current=$(node -e "console.log(require('./${pkg}').version)")
  if [ "$current" != "$ROOT_VERSION" ]; then
    # Use node for cross-platform JSON editing (no sed portability issues)
    node -e "
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync('${pkg}', 'utf8'));
      pkg.version = '${ROOT_VERSION}';
      fs.writeFileSync('${pkg}', JSON.stringify(pkg, null, 2) + '\n');
    "
    echo "  ${pkg}: ${current} → ${ROOT_VERSION}"
  fi
done

echo "Done."
