#!/usr/bin/env bash
# scripts/install.sh
# Install Archon CLI from GitHub releases
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/coleam00/Archon/main/scripts/install.sh | bash
#
# Options (via environment variables):
#   VERSION       - Specific version to install (default: latest)
#   INSTALL_DIR   - Installation directory (default: /usr/local/bin)
#   SKIP_CHECKSUM - Set to "true" to skip checksum verification (not recommended)
#
# Examples:
#   # Install latest
#   curl -fsSL https://raw.githubusercontent.com/coleam00/Archon/main/scripts/install.sh | bash
#
#   # Install specific version
#   VERSION=v0.2.0 curl -fsSL ... | bash
#
#   # Install to custom directory
#   INSTALL_DIR=~/.local/bin curl -fsSL ... | bash

set -euo pipefail

# Configuration
REPO="coleam00/Archon"
BINARY_NAME="archon"
VERSION="${VERSION:-latest}"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info() { echo -e "${BLUE}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }

# Detect OS and architecture
detect_platform() {
  local os arch

  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"

  case "$os" in
    darwin)
      os="darwin"
      ;;
    linux)
      os="linux"
      ;;
    mingw*|msys*|cygwin*)
      error "Windows is not supported. Please use WSL2 or see documentation."
      exit 1
      ;;
    *)
      error "Unsupported OS: $os"
      exit 1
      ;;
  esac

  case "$arch" in
    x86_64|amd64)
      arch="x64"
      ;;
    arm64|aarch64)
      arch="arm64"
      ;;
    *)
      error "Unsupported architecture: $arch"
      exit 1
      ;;
  esac

  echo "${os}-${arch}"
}

# Get download URL for the binary
get_download_url() {
  local platform="$1"
  local version="$2"

  if [ "$version" = "latest" ]; then
    echo "https://github.com/${REPO}/releases/latest/download/${BINARY_NAME}-${platform}"
  else
    echo "https://github.com/${REPO}/releases/download/${version}/${BINARY_NAME}-${platform}"
  fi
}

# Get checksums URL
get_checksums_url() {
  local version="$1"

  if [ "$version" = "latest" ]; then
    echo "https://github.com/${REPO}/releases/latest/download/checksums.txt"
  else
    echo "https://github.com/${REPO}/releases/download/${version}/checksums.txt"
  fi
}

# Verify checksum
verify_checksum() {
  local binary_path="$1"
  local platform="$2"
  local checksums_url="$3"

  # Allow explicit skip with clear warning
  if [ "${SKIP_CHECKSUM:-false}" = "true" ]; then
    warn "Checksum verification SKIPPED by user request (SKIP_CHECKSUM=true)"
    warn "This binary has NOT been verified - use at your own risk"
    return 0
  fi

  info "Verifying checksum..."

  local checksums
  if ! checksums=$(curl -fsSL "$checksums_url" 2>/dev/null); then
    error "Could not download checksums file from $checksums_url"
    error "Cannot verify binary integrity."
    error "To install anyway (not recommended): SKIP_CHECKSUM=true curl -fsSL ... | bash"
    exit 1
  fi

  local expected_hash
  expected_hash=$(echo "$checksums" | grep "${BINARY_NAME}-${platform}" | awk '{print $1}')

  if [ -z "$expected_hash" ]; then
    error "Could not find checksum for ${BINARY_NAME}-${platform} in checksums file"
    error "This may indicate a corrupted or incomplete release."
    error "To install anyway (not recommended): SKIP_CHECKSUM=true curl -fsSL ... | bash"
    exit 1
  fi

  local actual_hash
  if command -v sha256sum >/dev/null 2>&1; then
    actual_hash=$(sha256sum "$binary_path" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    actual_hash=$(shasum -a 256 "$binary_path" | awk '{print $1}')
  else
    error "No sha256sum or shasum available for checksum verification"
    error "Please install sha256sum (coreutils) or use shasum"
    error "To install anyway (not recommended): SKIP_CHECKSUM=true curl -fsSL ... | bash"
    exit 1
  fi

  if [ "$expected_hash" != "$actual_hash" ]; then
    error "Checksum verification failed!"
    error "Expected: $expected_hash"
    error "Actual:   $actual_hash"
    error "The downloaded binary may be corrupted or tampered with."
    exit 1
  fi

  success "Checksum verified"
}

# Main installation
main() {
  echo ""
  echo "  ╔═══════════════════════════════════════╗"
  echo "  ║      Archon CLI Installer             ║"
  echo "  ╚═══════════════════════════════════════╝"
  echo ""

  # Detect platform
  info "Detecting platform..."
  local platform
  platform=$(detect_platform)
  success "Platform: $platform"

  # Get download URL
  local download_url checksums_url
  download_url=$(get_download_url "$platform" "$VERSION")
  checksums_url=$(get_checksums_url "$VERSION")

  info "Version: $VERSION"
  info "Download URL: $download_url"

  # Create temp directory
  local tmp_dir
  tmp_dir=$(mktemp -d)
  trap "rm -rf '$tmp_dir'" EXIT

  local binary_path="$tmp_dir/$BINARY_NAME"

  # Download binary
  info "Downloading binary..."
  if ! curl -fsSL "$download_url" -o "$binary_path"; then
    error "Failed to download binary from $download_url"
    exit 1
  fi
  success "Downloaded successfully"

  # Verify checksum
  verify_checksum "$binary_path" "$platform" "$checksums_url"

  # Make executable
  chmod +x "$binary_path"

  # Install
  info "Installing to $INSTALL_DIR/$BINARY_NAME..."

  # Create install directory if needed
  if [ ! -d "$INSTALL_DIR" ]; then
    if ! mkdir -p "$INSTALL_DIR" 2>/dev/null; then
      warn "Need sudo to create $INSTALL_DIR"
      sudo mkdir -p "$INSTALL_DIR"
    fi
  fi

  # Install binary
  if ! mv "$binary_path" "$INSTALL_DIR/$BINARY_NAME" 2>/dev/null; then
    warn "Need sudo to install to $INSTALL_DIR"
    sudo mv "$binary_path" "$INSTALL_DIR/$BINARY_NAME"
  fi

  success "Installed to $INSTALL_DIR/$BINARY_NAME"

  # Verify installation
  echo ""
  info "Verifying installation..."
  local version_output
  if version_output=$("$INSTALL_DIR/$BINARY_NAME" version 2>&1); then
    echo "$version_output"
    success "Installation complete!"
  else
    warn "Binary installed but version check failed:"
    echo "$version_output"
    warn "The binary may not work correctly. Please verify manually with: $INSTALL_DIR/$BINARY_NAME version"
  fi

  # Check if in PATH
  if ! command -v "$BINARY_NAME" >/dev/null 2>&1; then
    echo ""
    warn "$INSTALL_DIR is not in your PATH"
    echo "Add it with:"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    echo ""
    echo "Or add to your shell config (~/.bashrc, ~/.zshrc, etc.)"
  fi

  echo ""
  echo "Get started:"
  echo "  archon workflow list"
  echo "  archon workflow run assist \"What workflows are available?\""
  echo ""
}

main "$@"
