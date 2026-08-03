#!/usr/bin/env bash
# scripts/update-homebrew.sh
# Update Homebrew formula with checksums from a release
#
# Usage: ./scripts/update-homebrew.sh v0.2.0

set -euo pipefail

VERSION="${1:-}"

if [ -z "$VERSION" ]; then
  echo "Usage: $0 <version>"
  echo "Example: $0 v0.2.0"
  exit 1
fi

# Remove 'v' prefix if present for formula version
FORMULA_VERSION="${VERSION#v}"

REPO="coleam00/Archon"
FORMULA_FILE="homebrew/archon.rb"

echo "Updating Homebrew formula for version $VERSION"

# Download checksums
CHECKSUMS_URL="https://github.com/${REPO}/releases/download/${VERSION}/checksums.txt"
echo "Downloading checksums from $CHECKSUMS_URL"

CHECKSUMS=$(curl -fsSL "$CHECKSUMS_URL")
echo "Checksums:"
echo "$CHECKSUMS"
echo ""

# Extract individual checksums
SHA_DARWIN_ARM64=$(echo "$CHECKSUMS" | grep "archon-darwin-arm64" | awk '{print $1}')
SHA_DARWIN_X64=$(echo "$CHECKSUMS" | grep "archon-darwin-x64" | awk '{print $1}')
SHA_LINUX_ARM64=$(echo "$CHECKSUMS" | grep "archon-linux-arm64" | awk '{print $1}')
SHA_LINUX_X64=$(echo "$CHECKSUMS" | grep "archon-linux-x64" | awk '{print $1}')

# Validate all checksums were extracted
validate_checksum() {
  local name="$1"
  local value="$2"
  if [ -z "$value" ]; then
    echo "ERROR: Could not extract checksum for $name"
    echo "Checksums content:"
    echo "$CHECKSUMS"
    exit 1
  fi
  # Validate it looks like a SHA256 hash (64 hex chars)
  if ! echo "$value" | grep -qE '^[a-f0-9]{64}$'; then
    echo "ERROR: Invalid checksum format for $name: $value"
    echo "Expected 64 hex characters"
    exit 1
  fi
}

validate_checksum "archon-darwin-arm64" "$SHA_DARWIN_ARM64"
validate_checksum "archon-darwin-x64" "$SHA_DARWIN_X64"
validate_checksum "archon-linux-arm64" "$SHA_LINUX_ARM64"
validate_checksum "archon-linux-x64" "$SHA_LINUX_X64"

echo "Extracted checksums:"
echo "  darwin-arm64: $SHA_DARWIN_ARM64"
echo "  darwin-x64:   $SHA_DARWIN_X64"
echo "  linux-arm64:  $SHA_LINUX_ARM64"
echo "  linux-x64:    $SHA_LINUX_X64"
echo ""

echo "Updating formula..."

# Update version
sed -i.bak "s/version \".*\"/version \"${FORMULA_VERSION}\"/" "$FORMULA_FILE"

# Update checksums - handles both PLACEHOLDER and existing 64-char hex hashes
# The formula structure places sha256 on its own line after url in each on_* block
# Pattern matches: sha256 "PLACEHOLDER..." or sha256 "64-hex-chars"
sed -i.bak "s/PLACEHOLDER_SHA256_DARWIN_ARM64/${SHA_DARWIN_ARM64}/" "$FORMULA_FILE"
sed -i.bak "s/PLACEHOLDER_SHA256_DARWIN_X64/${SHA_DARWIN_X64}/" "$FORMULA_FILE"
sed -i.bak "s/PLACEHOLDER_SHA256_LINUX_ARM64/${SHA_LINUX_ARM64}/" "$FORMULA_FILE"
sed -i.bak "s/PLACEHOLDER_SHA256_LINUX_X64/${SHA_LINUX_X64}/" "$FORMULA_FILE"

# For subsequent runs, match any 64-char hex hash and update based on context
# The formula has separate on_arm/on_intel blocks under on_macos/on_linux
# We need to be careful to update the right checksum for each platform

# Strategy: Use line context to identify which checksum to update
# Darwin ARM64: line after archon-darwin-arm64 URL
sed -i.bak '/archon-darwin-arm64/{n;s/sha256 "[a-f0-9]\{64\}"/sha256 "'"${SHA_DARWIN_ARM64}"'"/;}' "$FORMULA_FILE"
# Darwin x64: line after archon-darwin-x64 URL
sed -i.bak '/archon-darwin-x64/{n;s/sha256 "[a-f0-9]\{64\}"/sha256 "'"${SHA_DARWIN_X64}"'"/;}' "$FORMULA_FILE"
# Linux ARM64: line after archon-linux-arm64 URL
sed -i.bak '/archon-linux-arm64/{n;s/sha256 "[a-f0-9]\{64\}"/sha256 "'"${SHA_LINUX_ARM64}"'"/;}' "$FORMULA_FILE"
# Linux x64: line after archon-linux-x64 URL
sed -i.bak '/archon-linux-x64/{n;s/sha256 "[a-f0-9]\{64\}"/sha256 "'"${SHA_LINUX_X64}"'"/;}' "$FORMULA_FILE"

# Clean up backup files
rm -f "${FORMULA_FILE}.bak"

echo "Updated $FORMULA_FILE"
echo ""
echo "Next steps:"
echo "1. Review changes: git diff $FORMULA_FILE"
echo "2. Commit: git add $FORMULA_FILE && git commit -m 'chore: update Homebrew formula for $VERSION'"
echo "3. If you have a tap repo, copy the formula there"
