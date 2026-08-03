#!/usr/bin/env bash
# scripts/checksums.sh
# Generate SHA256 checksums for release binaries

set -euo pipefail

DIST_DIR="${1:-dist/binaries}"
CHECKSUM_FILE="$DIST_DIR/checksums.txt"

# Expected binaries
EXPECTED_BINARIES=(
  "archon-darwin-arm64"
  "archon-darwin-x64"
  "archon-linux-arm64"
  "archon-linux-x64"
)

echo "Generating checksums for binaries in $DIST_DIR"

cd "$DIST_DIR"

# Verify at least one binary exists
if ! ls archon-* 1>/dev/null 2>&1; then
  echo "ERROR: No archon-* binaries found in $DIST_DIR"
  echo "Expected files: ${EXPECTED_BINARIES[*]}"
  exit 1
fi

# Verify all expected binaries exist
missing=()
for binary in "${EXPECTED_BINARIES[@]}"; do
  if [ ! -f "$binary" ]; then
    missing+=("$binary")
  fi
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "ERROR: Missing expected binaries: ${missing[*]}"
  echo "Found binaries:"
  ls -la archon-* 2>/dev/null || echo "  (none)"
  exit 1
fi

# Generate checksums
shasum -a 256 archon-* > checksums.txt

echo "Checksums written to $CHECKSUM_FILE:"
cat checksums.txt
