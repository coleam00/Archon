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

assert_powershell_version_guard() {
  local powershell_installer="$1"

  awk '
    /# --- Verify installation ---/ { in_verification = 1; next }
    /# --- Getting started ---/ { exit }
    !in_verification { next }
    /\$versionOutput = & \$destBinary version 2>&1/ { invoked = 1; next }
    invoked && /if \(\$LASTEXITCODE -ne 0\)/ { guarded = 1; next }
    guarded && /exit 1/ { exits_on_failure = 1; next }
    exits_on_failure && /Write-Ok "Installation complete!"/ { reports_success = 1 }
    END {
      exit !(invoked && guarded && exits_on_failure && reports_success)
    }
  ' "$powershell_installer" \
    || fail "PowerShell installer must fail a non-zero version check before reporting success"
}

make_platform_mocks() {
  local os="$1"
  local arch="$2"
  local translated="$3"
  local cpu_features="${4:-AVX2}"
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
if [ "\$1" = "-in" ] && [ "\$2" = "sysctl.proc_translated" ]; then
  if [ "$translated" = "fail" ]; then
    exit 1
  fi
  echo "$translated"
elif [ "\$1" = "-n" ] && [ "\$2" = "machdep.cpu.leaf7_features" ]; then
  if [ "$cpu_features" = "fail" ]; then
    exit 1
  fi
  echo "$cpu_features"
else
  exit 1
fi
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

check_cpu_with_mocks() {
  local platform="$1"
  local cpu_features="$2"
  local mocks
  local cpuinfo="$tmp_dir/cpuinfo-${platform}-${cpu_features// /-}"
  local status=0

  printf 'flags : fpu sse %s\n' "$cpu_features" >"$cpuinfo"
  mocks="$(make_platform_mocks Darwin x86_64 0 "$cpu_features")"
  PATH="$mocks:$PATH" ARCHON_CPUINFO_PATH="$cpuinfo" \
    bash -c 'source "$1"; check_cpu_compatibility "$2"' _ "$installer" "$platform" \
    || status=$?
  echo "$status"
}

assert_equals "0" "$(check_cpu_with_mocks linux-x64 avx2)" "Linux x64 with AVX2"
assert_equals "1" "$(check_cpu_with_mocks linux-x64 sse4_2)" "Linux x64 without AVX2"
assert_equals "0" "$(check_cpu_with_mocks darwin-x64 AVX2)" "macOS x64 with AVX2"
assert_equals "1" "$(check_cpu_with_mocks darwin-x64 SSE4.2)" "macOS x64 without AVX2"
assert_equals "0" "$(check_cpu_with_mocks linux-arm64 none)" "Linux ARM64 skips AVX2 check"

missing_cpuinfo="$tmp_dir/missing-cpuinfo"
missing_cpuinfo_status=0
ARCHON_CPUINFO_PATH="$missing_cpuinfo" \
  bash -c 'source "$1"; check_cpu_compatibility linux-x64' _ "$installer" \
  || missing_cpuinfo_status=$?
assert_equals "2" "$missing_cpuinfo_status" "Linux x64 with unavailable CPU features"

no_features_cpuinfo="$tmp_dir/cpuinfo-no-features"
printf '%s\n' 'processor : 0' >"$no_features_cpuinfo"
no_features_status=0
ARCHON_CPUINFO_PATH="$no_features_cpuinfo" \
  bash -c 'source "$1"; check_cpu_compatibility linux-x64' _ "$installer" \
  || no_features_status=$?
assert_equals "2" "$no_features_status" "Linux x64 without a feature declaration"
assert_equals "2" "$(check_cpu_with_mocks darwin-x64 fail)" "macOS x64 with unavailable CPU features"

cmp -s "$installer" "$repo_root/packages/docs-web/public/install" \
  || fail "public installer mirror differs from scripts/install.sh"

# The PowerShell pair needs the same guard. It had ALREADY drifted: the public copy
# was missing the @() array wrapper from 53cabd44 (#1000), so `irm … | iex` shipped a
# PATH-corrupting installer to Windows users while the repo copy was fixed. #2339.
cmp -s "$repo_root/scripts/install.ps1" "$repo_root/packages/docs-web/public/install.ps1" \
  || fail "public install.ps1 mirror differs from scripts/install.ps1"
assert_powershell_version_guard "$repo_root/scripts/install.ps1"

mock_dir="$tmp_dir/install-mocks"
install_dir="$tmp_dir/install-bin"
mkdir -p "$mock_dir" "$install_dir"
avx2_cpuinfo="$tmp_dir/cpuinfo-avx2"
printf '%s\n' 'flags : fpu sse avx2' >"$avx2_cpuinfo"
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

if PATH="$mock_dir:$PATH" ARCHON_CPUINFO_PATH="$avx2_cpuinfo" INSTALL_DIR="$install_dir" \
  SKIP_CHECKSUM=true bash "$installer" >/dev/null 2>&1; then
  fail "installer succeeded when downloaded binary failed its version check"
fi
assert_equals "working installation" "$(cat "$install_dir/archon")" "Existing installation after failed probe"

no_avx2_mock_dir="$tmp_dir/no-avx2-install-mocks"
no_avx2_install_dir="$tmp_dir/no-avx2-install-bin"
no_avx2_cpuinfo="$tmp_dir/cpuinfo-no-avx2"
curl_marker="$tmp_dir/no-avx2-curl-called"
mkdir -p "$no_avx2_mock_dir" "$no_avx2_install_dir"
printf '%s\n' 'flags : fpu sse4_2' >"$no_avx2_cpuinfo"
printf '%s\n' 'working installation' >"$no_avx2_install_dir/archon"
cat >"$no_avx2_mock_dir/uname" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "-s" ]; then
  echo Linux
else
  echo x86_64
fi
EOF
cat >"$no_avx2_mock_dir/curl" <<EOF
#!/usr/bin/env bash
touch "$curl_marker"
exit 99
EOF
chmod +x "$no_avx2_mock_dir/uname" "$no_avx2_mock_dir/curl"

no_avx2_status=0
no_avx2_output=$(PATH="$no_avx2_mock_dir:$PATH" ARCHON_CPUINFO_PATH="$no_avx2_cpuinfo" \
  INSTALL_DIR="$no_avx2_install_dir" SKIP_CHECKSUM=true bash "$installer" 2>&1) \
  || no_avx2_status=$?
[ "$no_avx2_status" -ne 0 ] || fail "installer succeeded on Linux x64 without AVX2"
case "$no_avx2_output" in
  *"requires a CPU with AVX2 support"*"#from-source"*) ;;
  *) fail "non-AVX2 failure does not explain AVX2 requirement and source installation" ;;
esac
[ ! -e "$curl_marker" ] || fail "installer downloaded a binary before rejecting a non-AVX2 CPU"
assert_equals "working installation" "$(cat "$no_avx2_install_dir/archon")" \
  "Existing installation after non-AVX2 preflight"

unknown_cpu_mock_dir="$tmp_dir/unknown-cpu-install-mocks"
unknown_cpu_install_dir="$tmp_dir/unknown-cpu-install-bin"
unknown_cpu_curl_marker="$tmp_dir/unknown-cpu-curl-called"
unknown_cpuinfo="$tmp_dir/cpuinfo-unknown"
mkdir -p "$unknown_cpu_mock_dir" "$unknown_cpu_install_dir"
printf '%s\n' 'processor : 0' >"$unknown_cpuinfo"
printf '%s\n' 'working installation' >"$unknown_cpu_install_dir/archon"
cat >"$unknown_cpu_mock_dir/uname" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "-s" ]; then
  echo Linux
else
  echo x86_64
fi
EOF
cat >"$unknown_cpu_mock_dir/curl" <<EOF
#!/usr/bin/env bash
touch "$unknown_cpu_curl_marker"
exit 99
EOF
chmod +x "$unknown_cpu_mock_dir/uname" "$unknown_cpu_mock_dir/curl"

unknown_cpu_status=0
unknown_cpu_output=$(PATH="$unknown_cpu_mock_dir:$PATH" ARCHON_CPUINFO_PATH="$unknown_cpuinfo" \
  INSTALL_DIR="$unknown_cpu_install_dir" SKIP_CHECKSUM=true bash "$installer" 2>&1) \
  || unknown_cpu_status=$?
[ "$unknown_cpu_status" -ne 0 ] || fail "installer succeeded with undetectable Linux CPU features"
case "$unknown_cpu_output" in
  *"Could not determine whether this x64 CPU supports AVX2."*"#from-source"*) ;;
  *) fail "unknown CPU-feature failure does not explain source installation" ;;
esac
[ ! -e "$unknown_cpu_curl_marker" ] || fail "installer downloaded a binary before rejecting unknown CPU features"
assert_equals "working installation" "$(cat "$unknown_cpu_install_dir/archon")" \
  "Existing installation after unknown CPU-feature preflight"

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

install_output=$(PATH="$success_mock_dir:$PATH" ARCHON_CPUINFO_PATH="$avx2_cpuinfo" \
  INSTALL_DIR="$success_install_dir" SKIP_CHECKSUM=true bash "$installer")
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
piped_stderr="$(PATH="$success_mock_dir:$PATH" ARCHON_CPUINFO_PATH="$avx2_cpuinfo" \
  INSTALL_DIR="$tmp_dir/piped-bin" \
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
