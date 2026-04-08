#!/usr/bin/env bash
# scripts/build-binaries.sh
# Build standalone CLI binaries for all supported platforms

set -euo pipefail

# Get version from package.json or git tag
VERSION="${VERSION:-$(grep '"version"' package.json | head -1 | cut -d'"' -f4)}"
GIT_COMMIT="${GIT_COMMIT:-$(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')}"
echo "Building Archon CLI v${VERSION} (commit: ${GIT_COMMIT})"

# Update build-time constants in source before compiling.
# The file is restored via an EXIT trap so the dev tree is never left dirty,
# even if `bun build --compile` fails mid-way. See GitHub issue #979.
BUNDLED_BUILD_FILE="packages/paths/src/bundled-build.ts"
trap 'echo "Restoring ${BUNDLED_BUILD_FILE}..."; git checkout -- "${BUNDLED_BUILD_FILE}"' EXIT

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

# Output directory
DIST_DIR="dist/binaries"
mkdir -p "$DIST_DIR"

# Define build targets
# Format: bun-target:output-name
TARGETS=(
  "bun-darwin-arm64:archon-darwin-arm64"
  "bun-darwin-x64:archon-darwin-x64"
  "bun-linux-x64:archon-linux-x64"
  "bun-linux-arm64:archon-linux-arm64"
)

# Minimum expected binary size (1MB - Bun binaries are typically 50MB+)
MIN_BINARY_SIZE=1000000

# Build each target
for target_pair in "${TARGETS[@]}"; do
  IFS=':' read -r target output_name <<< "$target_pair"
  echo "Building for $target..."

  bun build \
    --compile \
    --target="$target" \
    --outfile="$DIST_DIR/$output_name" \
    packages/cli/src/cli.ts

  # Verify build output exists
  if [ ! -f "$DIST_DIR/$output_name" ]; then
    echo "ERROR: Build failed - $DIST_DIR/$output_name not created"
    exit 1
  fi

  # Verify minimum reasonable size (Bun binaries are typically 50MB+)
  # Use portable stat command (works on both macOS and Linux)
  if stat -f%z "$DIST_DIR/$output_name" >/dev/null 2>&1; then
    size=$(stat -f%z "$DIST_DIR/$output_name")
  else
    size=$(stat --printf="%s" "$DIST_DIR/$output_name")
  fi

  if [ "$size" -lt "$MIN_BINARY_SIZE" ]; then
    echo "ERROR: Build output suspiciously small ($size bytes): $DIST_DIR/$output_name"
    echo "Expected at least $MIN_BINARY_SIZE bytes for a Bun-compiled binary"
    exit 1
  fi

  echo "  -> $DIST_DIR/$output_name ($size bytes)"
done

echo ""
echo "Build complete! Binaries in $DIST_DIR:"
ls -lh "$DIST_DIR"
