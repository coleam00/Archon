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

# Regenerate bundled defaults from .archon/{commands,workflows}/defaults/ so the
# compiled binary always embeds the current on-disk contents. CI also runs
# `bun run check:bundled` to catch committed drift.
echo "Regenerating bundled defaults..."
bun run scripts/generate-bundled-defaults.ts

# Update build-time constants in source before compiling.
# Build-time rewrites are restored via an EXIT trap so the dev tree is never
# left dirty, even if `bun build --compile` fails mid-way. See GitHub issue #979.
BUNDLED_BUILD_FILE="packages/paths/src/bundled-build.ts"
cleanup_build_rewrites() {
  echo "Restoring ${BUNDLED_BUILD_FILE}..."
  git checkout -- "${BUNDLED_BUILD_FILE}" || echo "WARNING: failed to restore ${BUNDLED_BUILD_FILE} — working tree may be dirty" >&2
  bun run scripts/prepare-compiled-markit.ts --restore || echo "WARNING: failed to restore markit-ai PDF converter — run bun install to reset node_modules" >&2
}
trap cleanup_build_rewrites EXIT

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

echo "Disabling markit-ai PDF conversion for compiled binaries..."
bun run scripts/prepare-compiled-markit.ts


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

  # --bytecode disabled: Bun 1.3.11 produces broken bytecode for our module graph
  # (likely triggered by @mariozechner/pi-coding-agent's CJS/ESM interop shape) —
  # "TypeError: Expected CommonJS module to have a function wrapper" at runtime.
  # Always --minify to match release parity.
  # PDF conversion is patched out above because markit-ai reaches mupdf through
  # a CJS require of a top-level-await ESM bundle, which Bun 1.3.x cannot compile.
  bun build \
    --compile \
    --minify \
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
