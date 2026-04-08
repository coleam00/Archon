# Investigation: Release workflow bypasses scripts/build-binaries.sh — v0.2.13 and v0.3.0 binaries are broken

**Issue**: #986 (https://github.com/coleam00/Archon/issues/986)
**Type**: BUG
**Investigated**: 2026-04-08

### Assessment

| Metric     | Value    | Reasoning                                                                                                                                      |
| ---------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Severity   | CRITICAL | Two consecutive releases (v0.2.13, v0.3.0) ship binaries that crash on `archon version`; no user can run the released CLI, no workaround.      |
| Complexity | MEDIUM   | Touches 3 files (`scripts/build-binaries.sh`, `.github/workflows/release.yml`, `test-release` skill) with moderate bash/YAML refactoring risk. |
| Confidence | HIGH     | Root cause is verified: `release.yml:51-59` calls `bun build --compile` inline and never rewrites `packages/paths/src/bundled-build.ts`.       |

---

## Problem Statement

The release workflow builds binaries by calling `bun build --compile` inline, bypassing `scripts/build-binaries.sh` which is the only place that rewrites `packages/paths/src/bundled-build.ts` with `BUNDLED_IS_BINARY=true`. As a result, released binaries bake in the dev defaults (`BUNDLED_IS_BINARY=false`, `BUNDLED_VERSION='dev'`), `isBinaryBuild()` returns false at runtime, and `archon version` falls into `getDevVersion()` which tries to read `package.json` from Bun's `/$bunfs/` virtual filesystem and crashes with "Failed to read version: package.json not found (bad installation?)".

---

## Analysis

### Root Cause

PR #982 replaced runtime binary detection with build-time constants, centralizing the rewrite logic in `scripts/build-binaries.sh`. The release workflow was never updated to call the script — it still invokes `bun build --compile` directly, so the constants rewrite step is skipped entirely in CI.

### Evidence Chain

WHY: `archon version` fails with "Failed to read version: package.json not found"
↓ BECAUSE: `isBinaryBuild()` returns `false` in the released binary, so version lookup falls into the dev-mode `package.json` read path
Evidence: `packages/paths/src/bundled-build.ts:16` — committed dev default is `export const BUNDLED_IS_BINARY = false;`

↓ BECAUSE: `bundled-build.ts` was never rewritten before `bun build --compile` ran in CI
Evidence: `.github/workflows/release.yml:51-59` — "Build binary" step runs `bun build --compile --minify [--bytecode] --target=... --outfile=... packages/cli/src/cli.ts` directly, with no preceding rewrite step

↓ ROOT CAUSE: The release workflow does not call `scripts/build-binaries.sh`, which is the sole writer of the build-time constants
Evidence: `scripts/build-binaries.sh:15-31` — the file-rewrite + EXIT-trap-restore logic lives only here, and nothing in `release.yml` references this script

### Affected Files

| File                                     | Lines  | Action | Description                                                                                                                              |
| ---------------------------------------- | ------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/build-binaries.sh`              | 1-86   | UPDATE | Add single-target mode via `TARGET`/`OUTFILE` env vars; add `--minify` by default; skip `--bytecode` for Windows targets.                 |
| `.github/workflows/release.yml`          | 51-59  | UPDATE | Replace inline `bun build --compile` with `bash scripts/build-binaries.sh` invocation; pass `VERSION`/`GIT_COMMIT`/`TARGET`/`OUTFILE`.    |
| `.github/workflows/release.yml`          | ~60    | CREATE | New step: post-build smoke test on `bun-linux-x64` target that runs `archon version` and asserts "Build: binary" + correct tag version. |
| `.claude/skills/test-release/SKILL.md`   | —      | UPDATE | Add "Local build for pre-release QA" section documenting the env vars for reproducing CI builds locally.                                 |

### Integration Points

- `scripts/build-binaries.sh:15-31` — sole writer of `bundled-build.ts` build-time constants (EXIT trap restores dev defaults)
- `packages/paths/src/bundled-build.ts:16-18` — consumed by `isBinaryBuild()`, `getVersion()`, and git-commit reporting; any code path that needs to know "am I a compiled binary?" reads these
- `.github/workflows/release.yml:51-59` — the divergent build path that bypasses the constants rewrite
- Matrix has 5 targets (linux x64/arm64, windows x64, darwin x64/arm64); all 5 are currently broken the same way

### Git History

- **PR #982** introduced the build-time constants approach but only wired it into `scripts/build-binaries.sh`, not `release.yml`
- **PRs #962/#963** previously fixed the same class of bug using runtime detection, which would have worked against the current release workflow because it didn't depend on the build script running
- **Implication**: Regression introduced by an incomplete refactor; the CI path was never exercised before shipping.

---

## Implementation Plan

### Step 1: Refactor `scripts/build-binaries.sh` for single-target mode

**File**: `scripts/build-binaries.sh`
**Action**: UPDATE

**Required changes**:

1. Accept `TARGET` and `OUTFILE` env vars. If both set → build only that target (CI mode). If neither set → build all 4 local targets (unchanged local-dev behavior). If only one set → error out.
2. Always pass `--minify` (matches current CI behavior).
3. Skip `--bytecode` for Windows targets (Bun cross-compile inconsistency; matches current CI behavior).
4. Preserve the existing EXIT trap that restores `packages/paths/src/bundled-build.ts`.
5. Preserve the existing min-size check (`MIN_BINARY_SIZE=1000000`).
6. Keep `VERSION` / `GIT_COMMIT` env var precedence; defaults unchanged.

See the issue body (#986) for the full script rewrite — use it verbatim as the target state.

**Why**: Single canonical build entry point eliminates the drift risk between local dev and CI.

---

### Step 2: Update `.github/workflows/release.yml` to call the script

**File**: `.github/workflows/release.yml`
**Lines**: 51-59
**Action**: UPDATE

**Current code**:

```yaml
- name: Build binary
  run: |
    mkdir -p dist
    # --bytecode excluded for Windows cross-compile (inconsistent Bun support)
    if [[ "${{ matrix.target }}" == *windows* ]]; then
      bun build --compile --minify --target=${{ matrix.target }} --outfile=dist/${{ matrix.binary }} packages/cli/src/cli.ts
    else
      bun build --compile --minify --bytecode --target=${{ matrix.target }} --outfile=dist/${{ matrix.binary }} packages/cli/src/cli.ts
    fi
```

**Required change**:

```yaml
- name: Build binary
  env:
    VERSION: ${{ github.ref_name }}
    GIT_COMMIT: ${{ github.sha }}
    TARGET: ${{ matrix.target }}
    OUTFILE: dist/${{ matrix.binary }}
  run: |
    # Strip 'v' prefix from tag (e.g. v0.3.1 → 0.3.1)
    VERSION="${VERSION#v}"
    # Short commit (first 8 chars of SHA)
    GIT_COMMIT="${GIT_COMMIT::8}"
    mkdir -p dist
    VERSION="$VERSION" GIT_COMMIT="$GIT_COMMIT" TARGET="$TARGET" OUTFILE="$OUTFILE" bash scripts/build-binaries.sh
```

**Why**: Delegates all build logic (including the constants rewrite) to the canonical script.

---

### Step 3: Add post-build smoke test

**File**: `.github/workflows/release.yml`
**Action**: CREATE (new step after "Build binary")

Add the smoke-test YAML block from issue #986 verbatim. Runs only on `bun-linux-x64` + Linux runner. Asserts:

1. Output contains neither "Failed to read version" nor "package.json not found" nor "bad installation"
2. Output contains "Build: binary"
3. Output contains the tag version

**Why**: Would have caught both v0.2.13 and v0.3.0 before publishing. One target per class of bug is enough.

---

### Step 4: Update `test-release` skill docs

**File**: `.claude/skills/test-release/SKILL.md`
**Action**: UPDATE

Add the "Local build for pre-release QA" section from issue #986 verbatim. Documents how to invoke the script in both multi-target and single-target modes for local reproduction of CI builds.

**Why**: Lets the next contributor exercise the CI code path locally before tagging.

---

### Step 5: No test code changes

The build script is bash and has no unit tests; validation is manual (see Validation section). No TypeScript test additions required.

---

## Patterns to Follow

The script rewrite should preserve the existing patterns in `scripts/build-binaries.sh`:

```bash
# SOURCE: scripts/build-binaries.sh:15-16
# Pattern: EXIT trap restore — keep dev tree clean even on failure
BUNDLED_BUILD_FILE="packages/paths/src/bundled-build.ts"
trap 'echo "Restoring ${BUNDLED_BUILD_FILE}..."; git checkout -- "${BUNDLED_BUILD_FILE}"' EXIT
```

```bash
# SOURCE: scripts/build-binaries.sh:68-78
# Pattern: portable stat + min-size sanity check
if stat -f%z "$outfile" >/dev/null 2>&1; then
  size=$(stat -f%z "$outfile")
else
  size=$(stat --printf="%s" "$outfile")
fi
if [ "$size" -lt "$MIN_BINARY_SIZE" ]; then
  echo "ERROR: Build output suspiciously small ($size bytes): $outfile" >&2
  exit 1
fi
```

---

## Edge Cases & Risks

| Risk/Edge Case                                                                 | Mitigation                                                                                                                                  |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| EXIT trap fails in CI (repo is detached HEAD during tag checkout)              | `git checkout -- <file>` works on detached HEAD; also guard with `|| true` to avoid failing the step on restore errors after successful build. |
| `VERSION` still has `v` prefix when passed to script                           | Strip in `release.yml` before invocation (`VERSION="${VERSION#v}"`).                                                                         |
| Windows smoke test can't run on Linux CI runner                                | Smoke test gated to `bun-linux-x64` only; documented as acceptable because the bug class is cross-platform.                                  |
| `scripts/build-binaries.sh` invoked with only `TARGET` or only `OUTFILE`       | Script errors out with clear message before doing any work.                                                                                 |
| Backwards compatibility for local `bash scripts/build-binaries.sh` with no env | Script falls through to multi-target mode unchanged (builds all 4 targets into `dist/binaries/`).                                            |
| `bytecode` flag support regresses on a target                                  | Per-target `*windows*` pattern match preserves current CI behavior exactly.                                                                  |

---

## Validation

### Automated Checks

```bash
# Shell syntax check
bash -n scripts/build-binaries.sh

# Workflow YAML validity (actionlint if available, else yamllint)
actionlint .github/workflows/release.yml || yamllint .github/workflows/release.yml

# Repo validation
bun run validate
```

### Manual Verification (local, pre-merge)

1. **Backwards compatibility**: `bash scripts/build-binaries.sh` (no env). Confirm all 4 targets build into `dist/binaries/`.
2. **Single-target mode**: `VERSION=0.3.1-test GIT_COMMIT=test1234 TARGET=bun-darwin-arm64 OUTFILE=/tmp/test-single-target bash scripts/build-binaries.sh`. Confirm binary exists.
3. **Build-time constants embedded**: `/tmp/test-single-target version` → reports `v0.3.1-test`, `Build: binary`, `Git commit: test1234`.
4. **EXIT trap restore**: `git status packages/paths/src/bundled-build.ts` shows clean.
5. **Error handling**: Run with only `TARGET` set (no `OUTFILE`). Script exits with clear error.

### CI Verification (post-merge)

1. Trigger the release workflow via `workflow_dispatch` with a test tag (e.g. `v0.3.1-rc1`).
2. Confirm the new smoke-test step executes and passes for `bun-linux-x64`.
3. `gh release view v0.3.1-rc1` shows all 5 binaries + `checksums.txt`.
4. Download `archon-darwin-arm64` and run `./archon-darwin-arm64 version` — must report the tag version + `Build: binary`.

### Post-release Verification

1. `/test-release curl-mac 0.3.1` passes.
2. `/test-release curl-linux 0.3.1` passes.

---

## Scope Boundaries

**IN SCOPE:**

- Refactor `scripts/build-binaries.sh` for single-target mode
- Wire `release.yml` to call the script
- Add post-build smoke test for `bun-linux-x64`
- Document local build env vars in `test-release` skill

**OUT OF SCOPE (do not touch):**

- Homebrew tap sync gap (separate issue — `coleam00/homebrew-archon` formula still at v0.2.0)
- Telemetry / `BUNDLED_POSTHOG_KEY` (#980) — separate feature, will benefit from this refactor automatically
- Windows / macOS smoke tests (can't run on Linux runner; one target catches the class of bug)
- Runtime detection fallback (deliberately removed in #982; don't re-introduce)
- `update-homebrew` job structure (works as-is post-fix)

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-04-08
- **Artifact**: `.claude/PRPs/issues/issue-986.md`
