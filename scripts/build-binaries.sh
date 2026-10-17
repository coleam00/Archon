#!/usr/bin/env bash
# scripts/build-binaries.sh
# Build standalone server, CLI and maintained provider plugin binaries for all
# supported platforms. Every binary embeds the same build-time constants, so a
# provider plugin reports the CLI's version and resolves its agent binary as a
# release binary does.
#
# Modes:
#   - Multi-target (local dev): no env vars → builds all 4 local targets into dist/binaries/
#   - Single-target (CI):       TARGET + OUTFILE set → builds only that target
#
# Env vars:
#   VERSION    - version string (default: from package.json)
#   GIT_COMMIT - short git commit (default: from `git rev-parse --short HEAD`)
#   TARGET     - bun target triple (e.g. bun-darwin-arm64); CI mode
#   OUTFILE    - output path for the CLI binary; CI mode. The server and provider
#                plugin binaries are written beside it under their release asset names.

set -euo pipefail

VERSION="${VERSION:-$(grep '"version"' package.json | head -1 | cut -d'"' -f4)}"
GIT_COMMIT="${GIT_COMMIT:-$(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')}"
TARGET="${TARGET:-}"
OUTFILE="${OUTFILE:-}"

echo "Building Archon server, CLI and provider plugins v${VERSION} (commit: ${GIT_COMMIT})"

# Update build-time constants and embed the bundled packs in source before compiling.
# Both files are restored via an EXIT trap so the dev tree is never left dirty,
# even if `bun build --compile` fails mid-way. See GitHub issue #979.
BUNDLED_BUILD_FILE="packages/paths/src/bundled-build.ts"
BUNDLED_DATA_FILE="packages/workflows/src/defaults/bundled-data.ts"
# The restore discards unstaged edits, so refuse to start rather than lose them.
if ! git diff --quiet -- "${BUNDLED_BUILD_FILE}" "${BUNDLED_DATA_FILE}"; then
  echo "ERROR: ${BUNDLED_BUILD_FILE} or ${BUNDLED_DATA_FILE} has unstaged edits that the post-build restore would discard; commit or stage them first" >&2
  exit 1
fi
trap 'echo "Restoring ${BUNDLED_BUILD_FILE} and ${BUNDLED_DATA_FILE}..."; git checkout -- "${BUNDLED_BUILD_FILE}" "${BUNDLED_DATA_FILE}" || echo "WARNING: failed to restore ${BUNDLED_BUILD_FILE} or ${BUNDLED_DATA_FILE} — working tree may be dirty" >&2' EXIT

# The committed bundled-data.ts reads the packs named in bundle-index.json from disk;
# the generator overwrites it with their current contents as literals for the binary.
echo "Embedding bundled defaults..."
bun run scripts/generate-bundled-defaults.ts

echo "Updating build-time constants (version=${VERSION}, is_binary=true)..."

# Compute SHA-256 of the web dist tarball when available (CI publishes it before binaries).
is_release_build() {
  [ -n "${CI:-}" ] || { [ -n "$TARGET" ] && [ -n "$OUTFILE" ]; }
}

is_valid_sha256() {
  printf '%s' "$1" | grep -Eq '^[0-9a-f]{64}$'
}

compute_sha256() {
  bun -e 'console.log(new Bun.CryptoHasher("sha256").update(await Bun.file(process.argv[1]).arrayBuffer()).digest("hex"));' "$1"
}

WEB_DIST_SHA256=""
if [ -f "archon-web.tar.gz" ]; then
  # An unreadable artifact yields an empty hash, so release builds fail closed
  # while local development retains its existing remote-checksum fallback.
  WEB_DIST_SHA256="$(compute_sha256 archon-web.tar.gz 2>/dev/null || true)"
  if is_valid_sha256 "$WEB_DIST_SHA256"; then
    echo "Embedded web dist SHA-256: ${WEB_DIST_SHA256}"
  else
    if is_release_build; then
      echo "ERROR: invalid SHA-256 for archon-web.tar.gz (${WEB_DIST_SHA256:-empty}) — refusing CI/release build" >&2
      exit 1
    fi
    echo "WARNING: failed to compute a valid SHA-256 for archon-web.tar.gz — remote fallback will be used" >&2
    WEB_DIST_SHA256=""
  fi
else
  if is_release_build; then
    echo "ERROR: archon-web.tar.gz not found — refusing to build CI/release binary without embedded web dist checksum" >&2
    exit 1
  fi
  echo "WARNING: archon-web.tar.gz not found — BUNDLED_WEB_DIST_SHA256 will be empty (remote fallback)" >&2
fi

write_constants() {
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
/** SHA-256 of archon-web.tar.gz, embedded at build time by scripts/build-binaries.sh */
export const BUNDLED_WEB_DIST_SHA256 = '${WEB_DIST_SHA256}';
export const BUNDLED_SERVER_SHA256 = '${SERVER_SHA256}';
EOF
}
SERVER_SHA256=''
write_constants

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
  server_asset=$(TARGET="$target" bun -e 'import { serverReleaseAsset } from "./packages/paths/src/server-launch.ts"; console.log(serverReleaseAsset(process.env.TARGET));')
  server_outfile="$(dirname "$outfile")/$server_asset"
  # Provider plugins are named the way `archon provider add` requests them.
  provider_plugins=$(TARGET="$target" bun -e '
    const { relative } = await import("node:path");
    const { MAINTAINED_PROVIDER_IDS } = await import("./packages/provider-contract/src/registration.ts");
    const { getSourceProviderEntry } = await import("./packages/paths/src/archon-paths.ts");
    const { pluginReleaseAsset } = await import("./packages/plugin-manifest/src/index.ts");
    for (const id of MAINTAINED_PROVIDER_IDS) {
      const manifest = await Bun.file(`plugins/provider-${id}/archon-plugin.json`).json();
      console.log(relative(process.cwd(), getSourceProviderEntry(id)), pluginReleaseAsset(manifest.executable, process.env.TARGET));
    }
  ')
  entry_outputs=("packages/server/src/bin.ts:$server_outfile" "packages/cli/src/cli.ts:$outfile")
  while read -r entry asset; do
    entry_outputs+=("$entry:$(dirname "$outfile")/$asset")
  done <<< "$provider_plugins"
  SERVER_SHA256=''
  write_constants
  for entry_output in "${entry_outputs[@]}"; do
    IFS=':' read -r entry output <<< "$entry_output"
    echo "Building $target → $output"

    # --bytecode disabled: Bun 1.3.11 produces broken bytecode for our module graph
    # (likely triggered by @earendil-works/pi-coding-agent's CJS/ESM interop shape) —
    # "TypeError: Expected CommonJS module to have a function wrapper" at runtime.
    # Always --minify to match release parity.
    # A standalone executable autoloads .env and bunfig.toml from its working
    # directory unless told not to. Providers run in the target repository, so
    # autoloading would undo strip-cwd-env.ts and hand the repository's keys to
    # them; source mode passes --no-env-file for the same reason.
    bun build \
      --compile \
      --minify \
      --no-compile-autoload-dotenv \
      --no-compile-autoload-bunfig \
      --target="$target" \
      --outfile="$output" \
      "$entry"

    # Verify build output exists
    if [ ! -f "$output" ]; then
      echo "ERROR: Build failed - $output not created" >&2
      exit 1
    fi

    # Verify minimum reasonable size (Bun binaries are typically 50MB+)
    # Use portable stat command (works on both macOS and Linux)
    if stat -f%z "$output" >/dev/null 2>&1; then
      size=$(stat -f%z "$output")
    else
      size=$(stat --printf="%s" "$output")
    fi

    if [ "$size" -lt "$MIN_BINARY_SIZE" ]; then
      echo "ERROR: Build output suspiciously small ($size bytes): $output" >&2
      echo "Expected at least $MIN_BINARY_SIZE bytes for a Bun-compiled binary" >&2
      exit 1
    fi

    echo "  -> $output ($size bytes)"
    if [ "$entry" = 'packages/server/src/bin.ts' ]; then
      SERVER_SHA256="$(compute_sha256 "$output" 2>/dev/null || true)"
      if ! is_valid_sha256 "$SERVER_SHA256"; then
        echo "ERROR: invalid server SHA-256 for $output — refusing to build CLI" >&2
        exit 1
      fi
      write_constants
    fi
  done
done

echo ""
echo "Build complete."
