#!/usr/bin/env bash
# Sync all workspace package versions to match the root package.json version,
# then refresh bun.lock so its workspace version fields agree.
# Called by the release skill after bumping the root version.
#
# Usage: bash scripts/sync-versions.sh   (from the repository root)

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

# Refresh bun.lock so its workspace "version" fields match the manifests above.
# Unconditional on purpose: the loop writes nothing when the manifests already
# match the root version, and "manifests synced, lockfile stale" is exactly the
# drift this repairs — a guard would make the script unable to fix it.
# --lockfile-only keeps the side effects to bun.lock; a full install would also
# run the root `prepare` script (husky) and materialize node_modules, neither of
# which is this script's business.
echo "Refreshing bun.lock..."
bun install --lockfile-only

echo "Done."
