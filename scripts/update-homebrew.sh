#!/usr/bin/env bash
# scripts/update-homebrew.sh
# Update Homebrew formula with checksums from a release
#
# Usage: ./scripts/update-homebrew.sh v0.1.0
#
# Env vars:
#   REPO         - GitHub repo containing release assets (default: current origin/GITHUB_REPOSITORY)
#   FORMULA_FILE - Homebrew formula to update (default: homebrew/archon.rb)
#   CHECKSUMS_FILE - Local checksums.txt path for offline validation

set -euo pipefail

VERSION="${1:-}"

if [ -z "$VERSION" ]; then
  echo "Usage: $0 <version>"
  echo "Example: $0 v0.1.0"
  exit 1
fi

derive_repo_from_origin() {
  local origin
  origin="$(git remote get-url origin 2>/dev/null || true)"
  if [ -z "$origin" ]; then
    return 1
  fi

  origin="${origin%.git}"
  origin="${origin#https://github.com/}"
  origin="${origin#git@github.com:}"

  if echo "$origin" | grep -qE '^[^/]+/[^/]+$'; then
    echo "$origin"
    return 0
  fi

  return 1
}

RELEASE_TAG="$VERSION"
if [[ "$RELEASE_TAG" != v* ]]; then
  RELEASE_TAG="v${RELEASE_TAG}"
fi

# Remove 'v' prefix for formula version because Homebrew adds it in URLs.
FORMULA_VERSION="${RELEASE_TAG#v}"
REPO="${REPO:-${GITHUB_REPOSITORY:-$(derive_repo_from_origin || echo 'NewTurn2017/Archon')}}"
FORMULA_FILE="${FORMULA_FILE:-homebrew/archon.rb}"

if [ ! -f "$FORMULA_FILE" ]; then
  echo "ERROR: Formula file not found: $FORMULA_FILE" >&2
  exit 1
fi

echo "Updating Homebrew formula for $REPO $RELEASE_TAG"

if [ -n "${CHECKSUMS_FILE:-}" ]; then
  echo "Reading checksums from $CHECKSUMS_FILE"
  CHECKSUMS="$(cat "$CHECKSUMS_FILE")"
else
  CHECKSUMS_URL="https://github.com/${REPO}/releases/download/${RELEASE_TAG}/checksums.txt"
  echo "Downloading checksums from $CHECKSUMS_URL"
  CHECKSUMS="$(curl -fsSL "$CHECKSUMS_URL")"
fi
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

# Update repository metadata and release asset URLs.
export REPO
perl -0pi.bak -e 's~homepage "[^"]+"~homepage "https://github.com/$ENV{REPO}"~g' "$FORMULA_FILE"
perl -0pi.bak -e 's~url "https://github.com/[^"]+/archon-darwin-arm64"~url "https://github.com/$ENV{REPO}/releases/download/v#{version}/archon-darwin-arm64"~g' "$FORMULA_FILE"
perl -0pi.bak -e 's~url "https://github.com/[^"]+/archon-darwin-x64"~url "https://github.com/$ENV{REPO}/releases/download/v#{version}/archon-darwin-x64"~g' "$FORMULA_FILE"
perl -0pi.bak -e 's~url "https://github.com/[^"]+/archon-linux-arm64"~url "https://github.com/$ENV{REPO}/releases/download/v#{version}/archon-linux-arm64"~g' "$FORMULA_FILE"
perl -0pi.bak -e 's~url "https://github.com/[^"]+/archon-linux-x64"~url "https://github.com/$ENV{REPO}/releases/download/v#{version}/archon-linux-x64"~g' "$FORMULA_FILE"

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
echo "2. Commit: git add $FORMULA_FILE && git commit -m 'chore: update Homebrew formula for $RELEASE_TAG'"
echo "3. If you have a tap repo, copy the formula there"
