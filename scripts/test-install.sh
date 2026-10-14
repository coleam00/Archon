#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
installer="$repo_root/scripts/install.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
# The installer asks on the terminal which providers to install. Point it at a path
# that does not exist so no case below waits on the developer's terminal, and drop
# any selection inherited from the caller's environment.
export ARCHON_TTY="$tmp_dir/no-terminal"
unset ARCHON_PROVIDERS

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

# Provider selection. The downloaded "binary" is a shell-script stub that records each
# invocation, so these cases prove which `archon provider add` the installer runs.
assert_provider_ids_match() {
  local owner="$repo_root/packages/provider-contract/src/registration.ts"
  local expected shell_ids powershell_ids
  expected=$(sed -n "s/^export const MAINTAINED_PROVIDER_IDS = \[\(.*\)\] as const;$/\1/p" "$owner" \
    | tr -d "' " | tr ',' ' ')
  [ -n "$expected" ] || fail "could not read MAINTAINED_PROVIDER_IDS from $owner"
  shell_ids=$(sed -n 's/^PROVIDER_IDS="\(.*\)"$/\1/p' "$installer")
  assert_equals "$expected" "$shell_ids" "install.sh PROVIDER_IDS"
  powershell_ids=$(sed -n 's/^\$PROVIDER_IDS *= *@(\(.*\))$/\1/p' "$repo_root/scripts/install.ps1" \
    | tr -d "' " | tr ',' ' ')
  assert_equals "$expected" "$powershell_ids" "install.ps1 PROVIDER_IDS"
}
assert_provider_ids_match

provider_mock_dir="$tmp_dir/provider-mocks"
provider_calls="$tmp_dir/provider-calls"
provider_curl_marker="$tmp_dir/provider-curl-called"
mkdir -p "$provider_mock_dir"
cat >"$provider_mock_dir/curl" <<EOF
#!/usr/bin/env bash
touch "$provider_curl_marker"
output=""
while [ "\$#" -gt 0 ]; do
  if [ "\$1" = "-o" ]; then
    output="\$2"
    shift 2
  else
    shift
  fi
done
cat >"\$output" <<'BINARY'
#!/usr/bin/env bash
if [ "\$1" = "version" ]; then
  echo "archon 1.2.3"
  exit 0
fi
echo "\$*" >>"$provider_calls"
[ "\$*" != "provider add pi" ]
BINARY
EOF
chmod +x "$provider_mock_dir/curl"

# Runs the installer into a fresh directory with extra arguments passed through, and
# prints its combined output. The stub fails `provider add pi` on purpose.
provider_install_count=0
run_provider_install() {
  rm -f "$provider_calls" "$provider_curl_marker"
  provider_install_count=$((provider_install_count + 1))
  PATH="$provider_mock_dir:$PATH" ARCHON_CPUINFO_PATH="$avx2_cpuinfo" \
    INSTALL_DIR="$tmp_dir/provider-bin-$provider_install_count" \
    SKIP_CHECKSUM=true bash "$installer" "$@" 2>&1
}

provider_calls_made() {
  if [ -e "$provider_calls" ]; then cat "$provider_calls"; fi
}

output=$(run_provider_install --providers codex,claude) || fail "--providers install failed: $output"
assert_equals "provider add codex claude" "$(provider_calls_made)" "--providers runs one provider add"

output=$(run_provider_install --providers=codex) || fail "--providers= install failed: $output"
assert_equals "provider add codex" "$(provider_calls_made)" "--providers=<ids> form"

output=$(ARCHON_PROVIDERS="claude" run_provider_install) || fail "ARCHON_PROVIDERS install failed: $output"
assert_equals "provider add claude" "$(provider_calls_made)" "ARCHON_PROVIDERS selects providers"

output=$(ARCHON_PROVIDERS="claude" run_provider_install --providers codex) \
  || fail "flag over env install failed: $output"
assert_equals "provider add codex" "$(provider_calls_made)" "--providers wins over ARCHON_PROVIDERS"

output=$(run_provider_install) || fail "non-interactive install failed: $output"
assert_equals "" "$(provider_calls_made)" "No terminal and no selection installs no provider"
case "$output" in
  *"archon provider add <claude|codex|pi>"*) ;;
  *) fail "non-interactive install without a selection does not print the provider add command" ;;
esac

answers="$tmp_dir/provider-answers"
printf '%s\n' 'codex' >"$answers"
output=$(ARCHON_TTY="$answers" run_provider_install --providers "") \
  || fail "explicit empty selection failed: $output"
assert_equals "" "$(provider_calls_made)" "An explicit empty selection installs none without asking"

printf '%s\n' 'bogus' 'codex, claude' >"$answers"
output=$(ARCHON_TTY="$answers" run_provider_install) || fail "interactive install failed: $output"
assert_equals "provider add codex claude" "$(provider_calls_made)" \
  "The terminal answer selects providers after an invalid one is asked again"
case "$output" in
  *"Unknown provider 'bogus'"*) ;;
  *) fail "interactive install does not reject an unknown provider" ;;
esac

: >"$answers"
output=$(ARCHON_TTY="$answers" run_provider_install) || fail "empty interactive answer failed: $output"
assert_equals "" "$(provider_calls_made)" "An empty terminal answer installs no provider"

invalid_status=0
output=$(run_provider_install --providers codex,claud) || invalid_status=$?
[ "$invalid_status" -ne 0 ] || fail "installer accepted an unknown provider in --providers"
case "$output" in
  *"Unknown provider 'claud'. Choose from: claude, codex, pi"*) ;;
  *) fail "unknown --providers id is not named with the valid choices" ;;
esac
[ ! -e "$provider_curl_marker" ] || fail "installer downloaded a binary before rejecting --providers"

failed_status=0
output=$(run_provider_install --providers pi) || failed_status=$?
[ "$failed_status" -ne 0 ] || fail "installer succeeded when provider add failed"
case "$output" in
  *"Retry with: archon provider add pi"*) ;;
  *) fail "failed provider add does not print the retry command" ;;
esac

rm -f "$provider_calls"
PATH="$provider_mock_dir:$PATH" ARCHON_CPUINFO_PATH="$avx2_cpuinfo" \
  INSTALL_DIR="$tmp_dir/piped-provider-bin" SKIP_CHECKSUM=true \
  bash -s -- --providers codex <"$installer" >/dev/null 2>&1 \
  || fail "piped installer with --providers failed"
assert_equals "provider add codex" "$(provider_calls_made)" "Piped installer passes --providers"

# The same selection cases for install.ps1, where PowerShell is installed (the Linux CI
# runner has it). The driver shadows the Invoke-WebRequest cmdlet with a function, so the
# installer it invokes "downloads" the shell-script stub and leaves a marker.
if command -v pwsh >/dev/null 2>&1; then
  ps_stub="$tmp_dir/ps-archon-stub"
  ps_calls="$tmp_dir/ps-provider-calls"
  ps_download_marker="$tmp_dir/ps-downloaded"
  cat >"$ps_stub" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "version" ]; then
  echo "archon 1.2.3"
  exit 0
fi
echo "\$*" >>"$ps_calls"
[ "\$*" != "provider add pi" ]
EOF
  chmod +x "$ps_stub"
  ps_driver="$tmp_dir/ps-driver.ps1"
  cat >"$ps_driver" <<'EOF'
param([string]$Installer, [string]$Stub, [string]$Marker, [string]$Providers)
function Invoke-WebRequest {
    param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)
    New-Item -ItemType File -Path $Marker -Force | Out-Null
    Copy-Item -Path $Stub -Destination $OutFile -Force
}
# The two documented forms. In both, the installer's `exit` ends this process.
$source = Get-Content -Raw $Installer
if ($PSBoundParameters.ContainsKey('Providers')) {
    & ([scriptblock]::Create($source)) -Providers $Providers
} else {
    $source | Invoke-Expression
}
exit 0
EOF

  # Prints the installer's output. With -Providers <ids> it runs the scriptblock form;
  # without, the `irm | iex` form.
  run_ps_install() {
    rm -rf "$ps_calls" "$ps_download_marker" "$tmp_dir/ps-bin"
    PROCESSOR_ARCHITECTURE=AMD64 INSTALL_DIR="$tmp_dir/ps-bin" SKIP_CHECKSUM=true \
      pwsh -NoProfile -NonInteractive -File "$ps_driver" -Installer "$repo_root/scripts/install.ps1" \
      -Stub "$ps_stub" -Marker "$ps_download_marker" "$@" </dev/null 2>&1
  }

  ps_calls_made() {
    if [ -e "$ps_calls" ]; then cat "$ps_calls"; fi
  }

  output=$(run_ps_install -Providers codex,claude) || fail "-Providers install failed: $output"
  assert_equals "provider add codex claude" "$(ps_calls_made)" "-Providers runs one provider add"

  output=$(run_ps_install -Providers codex) || fail "single -Providers install failed: $output"
  assert_equals "provider add codex" "$(ps_calls_made)" "-Providers with one id"

  output=$(ARCHON_PROVIDERS="claude" run_ps_install -Providers codex) \
    || fail "-Providers over env install failed: $output"
  assert_equals "provider add codex" "$(ps_calls_made)" "-Providers wins over ARCHON_PROVIDERS"

  output=$(ARCHON_PROVIDERS="claude" run_ps_install) || fail "ARCHON_PROVIDERS install failed: $output"
  assert_equals "provider add claude" "$(ps_calls_made)" "ARCHON_PROVIDERS selects providers"

  output=$(ARCHON_PROVIDERS="claude" run_ps_install -Providers "") \
    || fail "explicit empty -Providers failed: $output"
  assert_equals "" "$(ps_calls_made)" "An explicit empty -Providers installs none"

  output=$(run_ps_install) || fail "PowerShell install without a selection failed: $output"
  assert_equals "" "$(ps_calls_made)" "No console and no selection installs no provider"
  case "$output" in
    *"archon provider add <claude|codex|pi>"*) ;;
    *) fail "PowerShell install without a selection does not print the provider add command" ;;
  esac

  # With a real console, -NonInteractive makes Read-Host throw; the installer must still
  # install none and print the command. Needs util-linux `script` for the pty.
  if script -qec true /dev/null >/dev/null 2>&1; then
    rm -rf "$ps_calls" "$ps_download_marker" "$tmp_dir/ps-bin"
    ps_tty_cmd=$(printf '%q ' pwsh -NoProfile -NonInteractive -File "$ps_driver" \
      -Installer "$repo_root/scripts/install.ps1" -Stub "$ps_stub" -Marker "$ps_download_marker")
    output=$(PROCESSOR_ARCHITECTURE=AMD64 INSTALL_DIR="$tmp_dir/ps-bin" SKIP_CHECKSUM=true \
      script -qec "$ps_tty_cmd" /dev/null </dev/null 2>&1) \
      || fail "-NonInteractive install with a console failed: $output"
    assert_equals "" "$(ps_calls_made)" "-NonInteractive with a console installs no provider"
    case "$output" in
      *"archon provider add <claude|codex|pi>"*) ;;
      *) fail "-NonInteractive install with a console does not print the provider add command" ;;
    esac
  else
    echo "SKIP: util-linux script not found; install.ps1 -NonInteractive console case not exercised"
  fi

  ps_status=0
  output=$(run_ps_install -Providers codex,claud) || ps_status=$?
  [ "$ps_status" -ne 0 ] || fail "install.ps1 accepted an unknown provider in -Providers"
  case "$output" in
    *"Unknown provider 'claud'. Choose from: claude, codex, pi"*) ;;
    *) fail "unknown -Providers id is not named with the valid choices" ;;
  esac
  [ ! -e "$ps_download_marker" ] || fail "install.ps1 downloaded a binary before rejecting -Providers"

  ps_status=0
  output=$(run_ps_install -Providers pi) || ps_status=$?
  [ "$ps_status" -ne 0 ] || fail "install.ps1 succeeded when provider add failed"
  case "$output" in
    *"Retry with: archon provider add pi"*) ;;
    *) fail "failed PowerShell provider add does not print the retry command" ;;
  esac
else
  echo "SKIP: pwsh not found; install.ps1 provider selection not exercised"
fi

echo "Installer tests passed"
