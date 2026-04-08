#!/usr/bin/env bash
# scripts/build-binaries.sh
# Build standalone CLI binaries for all supported platforms.
#
# Modes:
#   - Multi-target (local dev): no env vars → builds all 4 local targets into dist/binaries/
#   - Single-target (CI):       TARGET + OUTFILE both set → builds only that target
#
# Env vars:
#   VERSION    - version string (default: from package.json)
#   GIT_COMMIT - short git commit (default: from `git rev-parse --short HEAD`)
#   TARGET     - bun target triple (e.g. bun-darwin-arm64); CI mode
#   OUTFILE    - output path for the built binary; CI mode

set -euo pipefail

VERSION="${VERSION:-$(grep '"version"' package.json | head -1 | cut -d'"' -f4)}"
GIT_COMMIT="${GIT_COMMIT:-$(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')}"
TARGET="${TARGET:-}"
OUTFILE="${OUTFILE:-}"

echo "Building Archon CLI v${VERSION} (commit: ${GIT_COMMIT})"

# Update build-time constants in source before compiling.
# The file is restored via an EXIT trap so the dev tree is never left dirty,
# even if `bun build --compile` fails mid-way. See GitHub issue #979.
BUNDLED_BUILD_FILE="packages/paths/src/bundled-build.ts"
trap 'echo "Restoring ${BUNDLED_BUILD_FILE}..."; git checkout -- "${BUNDLED_BUILD_FILE}" || echo "WARNING: failed to restore ${BUNDLED_BUILD_FILE} — working tree may be dirty" >&2' EXIT

echo "Updating build-time constants (version=${VERSION}, is_binary=true)..."
cat > "$BUNDLED_BUILD_FILE" << EOF
/**
 * Build-time constants embedded into compiled binaries.
 *
 * This file is rewritten by scripts/build-binaries.sh before \`bun build --compile\`
 * and restored afterwards via an EXIT trap. Do not edit these values by hand
 * outside the build script — the dev defaults live in the committed copy.
 */

export const BUNDLED_IS_BINARY = true;
export const BUNDLED_VERSION = '${VERSION}';
export const BUNDLED_GIT_COMMIT = '${GIT_COMMIT}';
EOF

# Determine which targets to build
if [ -n "$TARGET" ] && [ -n "$OUTFILE" ]; then
  # Single-target mode (CI): one target, caller-supplied output path
  TARGETS=("$TARGET:$OUTFILE")
elif [ -n "$TARGET" ] || [ -n "$OUTFILE" ]; then
  echo "ERROR: TARGET and OUTFILE must be set together (CI mode) or both unset (local mode)" >&2
  exit 1
else
  # Multi-target mode (local dev)
  DIST_DIR="dist/binaries"
  mkdir -p "$DIST_DIR"
  TARGETS=(
    "bun-darwin-arm64:${DIST_DIR}/archon-darwin-arm64"
    "bun-darwin-x64:${DIST_DIR}/archon-darwin-x64"
    "bun-linux-x64:${DIST_DIR}/archon-linux-x64"
    "bun-linux-arm64:${DIST_DIR}/archon-linux-arm64"
  )
fi

# Minimum expected binary size (1MB - Bun binaries are typically 50MB+)
MIN_BINARY_SIZE=1000000

# Build each target
for target_pair in "${TARGETS[@]}"; do
  IFS=':' read -r target outfile <<< "$target_pair"
  echo "Building $target → $outfile"

  # --bytecode excluded for Windows cross-compile (inconsistent Bun support)
  BYTECODE_FLAG=""
  if [[ "$target" != *windows* ]]; then
    BYTECODE_FLAG="--bytecode"
  fi

  # Always --minify to match release parity
  bun build \
    --compile \
    --minify \
    $BYTECODE_FLAG \
    --target="$target" \
    --outfile="$outfile" \
    packages/cli/src/cli.ts

  # Verify build output exists
  if [ ! -f "$outfile" ]; then
    echo "ERROR: Build failed - $outfile not created" >&2
    exit 1
  fi

  # Verify minimum reasonable size (Bun binaries are typically 50MB+)
  # Use portable stat command (works on both macOS and Linux)
  if stat -f%z "$outfile" >/dev/null 2>&1; then
    size=$(stat -f%z "$outfile")
  else
    size=$(stat --printf="%s" "$outfile")
  fi

  if [ "$size" -lt "$MIN_BINARY_SIZE" ]; then
    echo "ERROR: Build output suspiciously small ($size bytes): $outfile" >&2
    echo "Expected at least $MIN_BINARY_SIZE bytes for a Bun-compiled binary" >&2
    exit 1
  fi

  echo "  -> $outfile ($size bytes)"
done

echo ""
echo "Build complete."
