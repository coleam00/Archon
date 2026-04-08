---
name: test-release
description: |
  Verify a released archon binary works end-to-end via a specific install path.
  Use when: cutting a new release, reproducing a user bug report on the released
  version, or validating that a hotfix binary actually works after a re-tag.
  Triggers: "test the release", "test 0.3.1 via brew", "verify the curl install",
            "smoke test the binary", "did the release binary work",
            "run /test-release", "verify the release".
  NOT for: testing dev work (use bun link directly), testing unreleased changes
  (build locally via scripts/build-binaries.sh first), or running the full
  validate suite (bun run validate is separate).
argument-hint: "[brew|curl-mac|curl-vps] [optional: version to verify] [optional: vps-target]"
---

# Test Release

Automated smoke test for a released archon binary. Covers three install paths:

- `brew` — Homebrew tap on macOS (tests the formula and checksums)
- `curl-mac` — `curl install.sh` on macOS (tests the install script, sandboxed to a temp dir)
- `curl-vps` — `curl install.sh` on a remote Linux VPS (tests the Linux binary and full install path)

Every path installs the binary, runs a fixed smoke test suite, and cleans up. The dev `bun link` binary is never touched and remains the default `archon` on PATH throughout.

**When NOT to use this skill:**

- There is no release yet — build a local binary via `bash scripts/build-binaries.sh` and run it from `dist/binaries/` directly
- You want to test the dev clone — use `bun run validate` or invoke source directly via `bun packages/cli/src/cli.ts`
- You want to test the full server + web UI deploy flow — use the cloud-init from `deploy/cloud-init.yml` on a real VPS

## Local build for pre-release QA

To build a binary locally with the exact same flags and constants that CI uses,
invoke `scripts/build-binaries.sh` directly. The script supports two modes:

```bash
# Multi-target mode (builds all 4 local platforms into dist/binaries/)
VERSION=0.3.1 GIT_COMMIT=abc12345 bash scripts/build-binaries.sh

# Single-target mode (matches one CI matrix job)
VERSION=0.3.1 \
GIT_COMMIT=abc12345 \
TARGET=bun-darwin-arm64 \
OUTFILE=dist/test-archon-darwin-arm64 \
bash scripts/build-binaries.sh

# Verify the binary — use the path from the mode you built:
#   multi-target → ./dist/binaries/archon-darwin-arm64
#   single-target → the OUTFILE you passed above
./dist/test-archon-darwin-arm64 version
# Expected: Archon CLI v0.3.1, Build: binary, Git commit: abc12345
```

Run this **before tagging a release** to catch build-time-constant issues
locally. The script is the canonical entry point — both local dev and the
release workflow call it the same way, so a green local build means the CI
build will exercise the same code path.

## Phase 1 — Determine scope

Parse the arguments. The skill takes up to three:

1. **Install path** (`brew` | `curl-mac` | `curl-vps`): which install flow to exercise
2. **Expected version** (optional): the version tag the release should report, e.g. `0.3.1`. If not provided, fetch it:

```bash
gh release list --repo coleam00/Archon --limit 1 --json tagName --jq '.[0].tagName'
```

3. **VPS target** (only for `curl-vps`): SSH target in the form `user@host` or `host` (uses default SSH config)

If any argument is missing, ask the user for clarification BEFORE doing anything. Never guess the install path or the expected version.

Confirm the plan with the user before proceeding to Phase 2. Output should look like:

```
About to test:
  Path:     brew (Homebrew tap on macOS)
  Version:  0.3.1 (expected)
  Cleanup:  will uninstall after tests (brew uninstall + untap)

Proceed? (y/N)
```

Do not continue without explicit confirmation. Release testing touches install state and the user should be aware.

## Phase 2 — Pre-flight

Before touching anything:

1. Capture the current dev binary state for reference:

```bash
which -a archon
archon version 2>&1 | head -5
```

Record the path and version of the dev binary so the final report can show "dev binary was untouched".

2. Verify prerequisites for the chosen path:

   - **brew**: `brew --version` must succeed. If not, abort with "Homebrew not installed — see https://brew.sh/"
   - **curl-mac**: `curl --version` must succeed (effectively always true on macOS)
   - **curl-vps**: `ssh <target> 'uname -a'` must succeed. If not, abort with "Cannot SSH to <target>". Also verify `ssh <target> 'command -v curl'` returns a path.

3. Confirm the release exists on GitHub:

```bash
gh release view v<version> --repo coleam00/Archon --json tagName,assets --jq '{tag: .tagName, assetCount: (.assets | length)}'
```

If the release does not exist or has no assets, abort with a clear message. Do not proceed to install a non-existent release.

## Phase 3 — Install

### Path: brew

```bash
brew tap coleam00/archon
brew install coleam00/archon/archon
BINARY="$(brew --prefix coleam00/archon/archon)/bin/archon"
```

Capture `$BINARY` for Phase 4. Verify the file exists and is executable.

### Path: curl-mac

Install to a dedicated tmp directory so the dev `bun link` binary stays on PATH unchanged:

```bash
INSTALL_DIR=/tmp/archon-test-release-$(date +%s)
mkdir -p "$INSTALL_DIR"
INSTALL_DIR="$INSTALL_DIR" curl -fsSL https://raw.githubusercontent.com/coleam00/Archon/main/scripts/install.sh | bash
BINARY="$INSTALL_DIR/archon"
```

Verify `$BINARY` exists and is executable. Capture the install directory for cleanup.

### Path: curl-vps

Run the install script on the VPS:

```bash
ssh <target> 'curl -fsSL https://raw.githubusercontent.com/coleam00/Archon/main/scripts/install.sh | bash'
```

Determine where the binary landed — `install.sh` uses `/usr/local/bin/archon` by default, or falls back to `$HOME/.local/bin/archon` if `/usr/local/bin` is not writable:

```bash
ssh <target> 'command -v archon'
```

Capture the remote path as `$REMOTE_BINARY`. For the rest of Phase 4, wrap every command as `ssh <target> '<cmd>'`.

### Capture SHA256 and version

Immediately after install, capture:

```bash
# Local paths (brew / curl-mac)
shasum -a 256 "$BINARY" | awk '{print $1}'
"$BINARY" version 2>&1

# Remote path (curl-vps)
ssh <target> "shasum -a 256 $REMOTE_BINARY || sha256sum $REMOTE_BINARY" | awk '{print $1}'
ssh <target> "$REMOTE_BINARY version" 2>&1
```

Record both for the report. The SHA256 lets us confirm later that a user reporting a bug is running the exact same artifact we tested.

## Phase 4 — Smoke tests

Run these in order against `$BINARY` (or `ssh <target> $REMOTE_BINARY` for curl-vps). **Always use the full binary path, never the `archon` on PATH**, so there is no ambiguity about which binary is under test.

Each test should capture the full command output for the final report. If a test fails, continue to the next test (so the report is complete) but mark the overall result as FAIL.

### Test 1 — Version reports correctly

```bash
"$BINARY" version
```

**Pass criteria:**

- Exit code 0
- Output contains `Archon CLI v<expected-version>`
- Output contains `Build: binary` (not `Build: source (bun)`)
- Output contains a non-`unknown` git commit (i.e., `Git commit: <sha>`)

**Common failures:**

- Exit code non-zero → pino-pretty crash (#960) or similar startup failure
- Wrong version reported → binary is stale or the build script failed to update `bundled-build.ts`
- `Build: source (bun)` → `BUNDLED_IS_BINARY` was not set to `true` during the build (regression of #979)
- `Git commit: unknown` → build script did not capture the commit

### Test 2 — Bundled workflows load

Create a temporary git repository so the CLI has something to operate on:

```bash
TESTREPO=/tmp/archon-test-repo-$(date +%s)
mkdir -p "$TESTREPO"
cd "$TESTREPO"
git init -q
git commit -q --allow-empty -m init
"$BINARY" workflow list
```

**Pass criteria:**

- Exit code 0
- Output lists at least 20 bundled workflows (archon-assist, archon-fix-github-issue, archon-comprehensive-pr-review, etc.)
- No errors about missing workflow files or JSON parse failures

**Common failures:**

- Empty list → bundled defaults were not embedded in the binary (regression of the `isBinaryBuild` detection path)
- `Not in a git repository` → working directory handling bug
- Parse errors → the embedded JSON is corrupt or stale

### Test 3 — SDK path works (assist workflow)

In the same `$TESTREPO`:

```bash
"$BINARY" workflow run assist "say hello and nothing else" 2>&1 | tee /tmp/archon-test-assist.log
```

**Pass criteria:**

- Exit code 0
- The Claude subprocess spawns successfully (no `spawn EACCES`, `ENOENT`, or `process exited with code 1` in the early output)
- A response is produced (any response — even just "hello" — proves the SDK round-trip works)

**Common failures:**

- `Credit balance is too low` → auth is pointing at an exhausted API key (check `CLAUDE_USE_GLOBAL_AUTH` and `~/.archon/.env`)
- `unable to determine transport target for "pino-pretty"` → #960 regression, binary crashes on TTY
- `package.json not found (bad installation?)` → #961 regression, `isBinaryBuild` detection broken
- Process exits before producing output → generic spawn failure, capture stderr

### Test 4 — Env-leak gate refuses a leaky .env (optional, for releases including #1036/#1038/#983)

Create a second throwaway repo with a fake sensitive key:

```bash
LEAKREPO=/tmp/archon-test-leak-$(date +%s)
mkdir -p "$LEAKREPO"
cd "$LEAKREPO"
git init -q
git commit -q --allow-empty -m init
printf 'ANTHROPIC_API_KEY=sk-ant-test-fake\n' > .env
"$BINARY" workflow run assist "hello" 2>&1 | tee /tmp/archon-test-leak.log
```

**Pass criteria:**

- The command exits with a non-zero code, OR produces an error message containing `Cannot add codebase` or `Cannot run workflow`
- The error mentions the dangerous key name (`ANTHROPIC_API_KEY`)
- No Claude subprocess was actually spawned (the gate short-circuited)

**Common failures:**

- Command proceeds normally → the env-leak gate is not active (regression of #1036)
- Error is generic or unclear → the context-aware error message from #983 has regressed
- Gate blocks but with wrong remediation text → `formatLeakError` context detection is broken

Clean up the leak test repo:

```bash
rm -rf "$LEAKREPO"
```

### Test 5 — Isolation list works (sanity check)

In the same `$TESTREPO`:

```bash
"$BINARY" isolation list
```

**Pass criteria:**

- Exit code 0
- No errors (the list may be empty if no worktrees have been created, which is fine)

This catches regressions in the isolation subsystem that would not surface from the other tests.

### Test 6 — Cleanup test repos

```bash
rm -rf "$TESTREPO"
```

For `curl-vps` path, also clean up any remote test repos created via SSH.

## Phase 5 — Uninstall

**Always run uninstall, even if Phase 4 failed.** The goal is to leave the system in the same state as before the test.

### Path: brew

```bash
brew uninstall coleam00/archon/archon
brew untap coleam00/archon
```

Verify the dev binary is still the default:

```bash
which -a archon
# should show only the ~/.bun/bin/archon path, not a brew path

archon version | head -1
# should match the dev version captured in Phase 2
```

### Path: curl-mac

```bash
rm -rf "$INSTALL_DIR"
```

### Path: curl-vps

```bash
ssh <target> "sudo rm -f /usr/local/bin/archon || rm -f \$HOME/.local/bin/archon"
```

Optional: the user may want to LEAVE the VPS binary installed for ongoing QA. Ask before removing.

## Phase 6 — Report

Produce a structured report with:

- **Header**: release version tested, install path, timestamp, SHA256 of the tested binary
- **Environment**: dev binary path + version (proof the dev install was not disturbed)
- **Test results table**: one row per test with PASS / FAIL / SKIP
- **Captured output**: for any FAIL, include the exact command, exit code, and last 20 lines of stderr/stdout
- **Overall verdict**: PASS if all tests passed, FAIL if any test failed
- **Next steps**: if FAIL, suggest concrete actions (file a hotfix issue, re-tag, check the build workflow, etc.)

Example PASS report:

```
Test Release Report — archon v0.3.1 via brew
────────────────────────────────────────────
Tested at:    2026-04-08 15:42 UTC
Binary SHA:   e62eb73547b3740d56f242859b434a91d3830360a0d18f14de383da0fd7a0be6
Binary path:  /opt/homebrew/Cellar/archon/0.3.1/bin/archon
Dev binary:   /Users/rasmus/.bun/bin/archon → ../install/.../cli.ts (unchanged)

  [PASS]  Test 1  version reports 0.3.1, Build: binary, commit abc1234
  [PASS]  Test 2  workflow list returned 21 bundled workflows
  [PASS]  Test 3  workflow run assist produced output
  [PASS]  Test 4  env-leak gate refused leaky .env with context-aware error
  [PASS]  Test 5  isolation list executed without errors
  [PASS]  Cleanup brew uninstall + untap clean, dev binary unchanged

Overall: PASS

This release is safe to announce. Next steps:
  - Update release notes on GitHub if not done already
  - Announce on whatever channels you use
```

Example FAIL report:

```
Test Release Report — archon v0.3.1 via curl-vps
────────────────────────────────────────────────
Tested at:    2026-04-08 15:42 UTC
Binary SHA:   0cf83e15e6af228e3c3473467ca30fa7525b6d7069818d85f97a115ea703d708
Binary path:  user@vps:/usr/local/bin/archon
Dev binary:   /Users/rasmus/.bun/bin/archon (unchanged)

  [PASS]  Test 1  version reports 0.3.1, Build: binary
  [FAIL]  Test 2  workflow list returned 0 workflows

    Command:  archon workflow list
    Exit:     0
    Output:
      Discovering workflows in: /tmp/archon-test-repo-1712590923
      Found 0 workflow(s):

  [SKIP]  Test 3  SDK test skipped because Test 2 failed
  [SKIP]  Test 4  env-leak gate test skipped because Test 2 failed
  [PASS]  Test 5  isolation list executed without errors
  [PASS]  Cleanup VPS binary removed

Overall: FAIL

Likely cause: bundled workflows were not embedded in the binary.
Check the build workflow for missing asset embedding, or verify that
BUNDLED_WORKFLOWS in packages/workflows/src/defaults/bundled-defaults.ts
was populated at build time.

Next steps:
  1. File a P0 hotfix issue with the captured output
  2. Do NOT announce v0.3.1 until the hotfix ships as v0.3.2
  3. Consider adding a CI guard that blocks releases if BUNDLED_WORKFLOWS is empty
```

## Key behaviors

- **Never touch the dev `bun link` binary.** Always use the installed binary path for Phase 4 tests. Verify before and after.
- **Clean up on failure.** If Phase 4 fails mid-way, still run Phase 5 so the next run starts clean.
- **Capture SHA256 immediately after install.** This lets bug reports reference the exact artifact under test.
- **Explicit confirmation before install.** Never surprise the user by installing a second binary.
- **Report the dev binary state in both preamble and postamble.** Proof that the test did not disturb the dev environment.
- **Exit non-zero if any test failed.** The skill should propagate failure so automated wrappers (CI, scripts) can detect it.

## Related

- `scripts/build-binaries.sh` — builds the binary artifacts that end up in releases
- `.github/workflows/release.yml` — builds and publishes the binary on tag push
- `homebrew/archon.rb` — Homebrew tap formula (updated per release)
- `scripts/install.sh` — the curl install script
- `scripts/install-local.sh` / `install-local.ps1` — local-file install harnesses (for pre-release QA of binaries built from a branch, not from GitHub releases)
- `/release` skill — the release procedure itself (opposite side of the flow)
