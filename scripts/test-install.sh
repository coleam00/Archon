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
  local os="$1"
  local arch="$2"
  local translated="$3"
  local mock_dir="$tmp_dir/mocks-$os-$arch-$translated"
  mkdir -p "$mock_dir"

  cat >"$mock_dir/uname" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "-s" ]; then
  echo "$os"
else
  echo "$arch"
fi
EOF
  cat >"$mock_dir/sysctl" <<EOF
#!/usr/bin/env bash
if [ "$translated" = "fail" ]; then
  exit 1
fi
echo "$translated"
EOF
  # detect_with_mocks SOURCES the installer, so it depends on the source-guard
  # suppressing main(). If that guard ever regresses, main() runs and reaches the real
  # release URL over curl -- and sudo mkdir/mv with a non-writable INSTALL_DIR -- during
  # `bun run validate`. These stubs turn that latent network/privilege side effect into a
  # deterministic local failure.
  for forbidden in curl sudo; do
    cat >"$mock_dir/$forbidden" <<EOF
#!/usr/bin/env bash
echo "TEST BUG: sourced installer invoked $forbidden — the source guard is not suppressing main()" >&2
exit 99
EOF
    chmod +x "$mock_dir/$forbidden"
  done

  chmod +x "$mock_dir/uname" "$mock_dir/sysctl"
  echo "$mock_dir"
}

detect_with_mocks() {
  local mock_dir="$1"
  PATH="$mock_dir:$PATH" bash -c 'source "$1"; detect_platform' _ "$installer"
}

assert_platform() {
  local os="$1"
  local arch="$2"
  local translated="$3"
  local expected="$4"
  local description="$5"
  local mocks
  mocks="$(make_platform_mocks "$os" "$arch" "$translated")"
  assert_equals "$expected" "$(detect_with_mocks "$mocks")" "$description"
}

assert_platform Darwin x86_64 1 darwin-arm64 "Rosetta platform"
assert_platform Darwin x86_64 0 darwin-x64 "Native Intel platform"
assert_platform Darwin arm64 1 darwin-arm64 "Native ARM platform"
assert_platform Linux x86_64 1 linux-x64 "Linux x64 platform"
assert_platform Darwin x86_64 fail darwin-x64 "Native Intel platform without Rosetta marker"

cmp -s "$installer" "$repo_root/packages/docs-web/public/install" \
  || fail "public installer mirror differs from scripts/install.sh"

# The PowerShell pair needs the same guard. It had ALREADY drifted: the public copy
# was missing the @() array wrapper from 53cabd44 (#1000), so `irm … | iex` shipped a
# PATH-corrupting installer to Windows users while the repo copy was fixed. #2339.
cmp -s "$repo_root/scripts/install.ps1" "$repo_root/packages/docs-web/public/install.ps1" \
  || fail "public install.ps1 mirror differs from scripts/install.ps1"

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

success_mock_dir="$tmp_dir/success-install-mocks"
success_install_dir="$tmp_dir/success-install-bin"
mkdir -p "$success_mock_dir" "$success_install_dir"
printf '%s\n' 'old installation' >"$success_install_dir/archon"
cat >"$success_mock_dir/curl" <<'EOF'
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
if [ "$1" = "version" ]; then
  echo "archon 1.2.3"
fi
BINARY
EOF
chmod +x "$success_mock_dir/curl"

install_output=$(PATH="$success_mock_dir:$PATH" INSTALL_DIR="$success_install_dir" SKIP_CHECKSUM=true bash "$installer")
assert_equals "archon 1.2.3" "$("$success_install_dir/archon" version)" "Successful probe replaces installation"
case "$install_output" in
  *"archon 1.2.3"*) ;;
  *) fail "Installer prints verified version" ;;
esac

# Regression for #2338: the installer must survive being READ FROM STDIN, which is how
# `curl -fsSL … | bash` delivers it. There BASH_SOURCE[0] is unbound, and with `set -u` a
# bare reference aborted the script before main() ran — the documented install path failed
# for every user on every platform. Every other case here invokes the installer by path or
# sources it, so none of them can catch this.
#
# Mocked curl + a scratch INSTALL_DIR keep this off the network and out of the real system.
piped_status=0
piped_stderr="$(PATH="$success_mock_dir:$PATH" INSTALL_DIR="$tmp_dir/piped-bin" \
  SKIP_CHECKSUM=true bash <"$installer" 2>&1 >/dev/null)" || piped_status=$?
# Specific diagnosis FIRST, generic assertion second. With the order reversed the
# assert_equals fired on any regression and this case block was dead code, so the
# #2338 failure reported only "expected 0, got 1" with no hint at the cause.
case "$piped_stderr" in
  *"unbound variable"*)
    fail "installer aborts when piped to bash (BASH_SOURCE unbound under set -u) — see #2338"
    ;;
esac
assert_equals "0" "$piped_status" "Piped installer exits successfully"
assert_equals "archon 1.2.3" "$("$tmp_dir/piped-bin/archon" version)" "Piped installer installs a working binary"

echo "Installer tests passed"
