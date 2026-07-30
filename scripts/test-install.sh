#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
installer="$repo_root/scripts/install.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

assert_equals() {
  local expected="$1"
  local actual="$2"
  local description="$3"

  [ "$expected" = "$actual" ] || fail "$description: expected $expected, got $actual"
}

make_platform_mocks() {
  local arch="$1"
  local translated="$2"
  local mock_dir="$tmp_dir/mocks-$arch-$translated"
  mkdir -p "$mock_dir"

  cat >"$mock_dir/uname" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "-s" ]; then
  echo Darwin
else
  echo "$arch"
fi
EOF
  cat >"$mock_dir/sysctl" <<EOF
#!/usr/bin/env bash
echo "$translated"
EOF
  chmod +x "$mock_dir/uname" "$mock_dir/sysctl"
  echo "$mock_dir"
}

detect_with_mocks() {
  local mock_dir="$1"
  PATH="$mock_dir:$PATH" bash -c 'source "$1"; detect_platform' _ "$installer"
}

rosetta_mocks="$(make_platform_mocks x86_64 1)"
assert_equals "darwin-arm64" "$(detect_with_mocks "$rosetta_mocks")" "Rosetta platform"

intel_mocks="$(make_platform_mocks x86_64 0)"
assert_equals "darwin-x64" "$(detect_with_mocks "$intel_mocks")" "Native Intel platform"

arm_mocks="$(make_platform_mocks arm64 1)"
assert_equals "darwin-arm64" "$(detect_with_mocks "$arm_mocks")" "Native ARM platform"

cmp -s "$installer" "$repo_root/packages/docs-web/public/install" \
  || fail "public installer mirror differs from scripts/install.sh"

mock_dir="$tmp_dir/install-mocks"
install_dir="$tmp_dir/install-bin"
mkdir -p "$mock_dir" "$install_dir"
printf '%s\n' 'working installation' >"$install_dir/archon"
cat >"$mock_dir/curl" <<'EOF'
#!/usr/bin/env bash
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    output="$2"
    shift 2
  else
    shift
  fi
done
cat >"$output" <<'BINARY'
#!/usr/bin/env bash
echo "illegal hardware instruction" >&2
exit 1
BINARY
EOF
chmod +x "$mock_dir/curl"

if PATH="$mock_dir:$PATH" INSTALL_DIR="$install_dir" SKIP_CHECKSUM=true bash "$installer" >/dev/null 2>&1; then
  fail "installer succeeded when downloaded binary failed its version check"
fi
assert_equals "working installation" "$(cat "$install_dir/archon")" "Existing installation after failed probe"

echo "Installer tests passed"
