---
name: release
description: |
  Create a release from dev branch. Generates changelog entries from commits,
  bumps version, and creates a PR to main.

  TRIGGERS - Use this skill when user says:
  - "/release" - create a patch release (default)
  - "/release minor" - create a minor release
  - "/release major" - create a major release
  - "make a release", "cut a release", "ship it", "release to main"
---

# Release Skill

Creates a release by comparing dev to main, generating changelog entries from commits, bumping the version, and creating a PR. After the tag is pushed and the release workflow finishes building binaries, updates the Homebrew formula with the real SHA256 values from the published `checksums.txt`, syncs the `coleam00/homebrew-archon` tap, and verifies the end-to-end install path via `/test-release`.

> **⚠️ CRITICAL — Homebrew formula SHAs cannot be known until after the release workflow builds binaries.**
>
> The `version` field in `homebrew/archon.rb` and the `sha256` fields must be updated **atomically**. Never update one without the other.
>
> The correct sequence is:
> 1. Tag is pushed → release workflow fires → binaries built → `checksums.txt` uploaded
> 2. Fetch `checksums.txt` from the published release
> 3. Parse the SHA256 per platform
> 4. Update `homebrew/archon.rb` with the new version AND the new SHAs in a single commit
> 5. Sync to the `coleam00/homebrew-archon/Formula/archon.rb` tap repo
>
> Updating the formula's `version` field without also updating the `sha256` values creates a stale, misleading formula that looks valid but produces checksum mismatches on install. This has happened before (v0.3.0: version updated to 0.3.0 but SHAs were still from v0.2.13). Always do both or neither.

## Process

### Step 1: Validate State

```bash
# Must be on dev branch with clean working tree
git checkout dev
git pull origin dev --no-rebase
git status --porcelain  # must be empty
git fetch origin main
```

If not on dev or working tree is dirty, abort with a clear message.

**Then check that dev actually contains main.** Anything committed directly to
main — a docs typo fix, a hotfix, the previous release's formula commit — stays
stranded there until someone merges it back. The release PR would then propose
*reverting* it, and the next release inherits the drift.

```bash
if git merge-base --is-ancestor origin/main origin/dev; then
  echo "dev contains main — OK"
else
  echo "DRIFT: commits exist on main that dev does not have:"
  git log origin/dev..origin/main --oneline
  echo ""
  echo "Resync before releasing:"
  echo "  git checkout dev && git pull origin main --no-rebase && git push origin dev"
  exit 1
fi
```

Observed on the 0.7.1 release: `ae704a73 Update docs.mdx (#2155)` had been
committed straight to main after 0.7.0 and never merged back. Someone had
noticed the *content* gap and hand-forward-ported it via a separate PR (#2403),
so dev had the change but not the commit — and `main` was still not an ancestor
of `dev`. Resolve this before Step 2; do not carry it into the release PR.

### Step 1.5: Pre-flight compiled-binary smoke test (MANDATORY before any other step)

> **Why this is first**: releases have ended up with zero working binaries because a module-init crash or bundler bug only surfaces in `bun build --compile` output, not in `bun run`. CI catches it — but only AFTER the tag is pushed and a GitHub Release is created. By then the damage (empty release, broken `releases/latest`, broken `install.sh`) is already live. Failing here, before any user-visible change, keeps the blast radius at "no release was cut."

Run locally on the native target. This takes ~15-30s and is cheaper than discovering the problem after tag+release.

```bash
# Guard: only run this for Node/Bun projects with a CLI entry point + build-binaries script.
if [ -f scripts/build-binaries.sh ] && [ -f packages/cli/src/cli.ts ]; then
  TMP_BINARY=$(mktemp)
  trap "rm -f $TMP_BINARY" EXIT

  # Compile for the native target only (not full cross-compile — that's CI's job).
  # Match the real release flags so any bundler quirk reproduces locally.
  bun build \
    --compile \
    --minify \
    --target=bun \
    --outfile="$TMP_BINARY" \
    packages/cli/src/cli.ts

  # Smoke test: the binary must start and exit 0 on a safe, non-interactive command.
  # Use `--help` (NOT `version`). The `version` command's compiled-binary code
  # path depends on BUNDLED_IS_BINARY=true, which is set by scripts/build-binaries.sh
  # — but we're doing a bare `bun build --compile` here to keep the smoke fast,
  # so BUNDLED_IS_BINARY is still `false`. That sends `version` down the dev
  # branch of version.ts which tries to read package.json from a path that only
  # exists in node_modules, producing a false-positive ENOENT. `--help` has no
  # such dev/binary branch and exercises the same module-init graph we're
  # actually testing. Must NOT touch network, database, or require env vars.
  if ! "$TMP_BINARY" --help > /tmp/archon-preflight.log 2>&1; then
    echo "ERROR: compiled binary crashed at startup"
    cat /tmp/archon-preflight.log
    echo ""
    echo "This usually means a dependency has a module-init-time side effect that"
    echo "fails in a compiled binary context (readFileSync of a path that only"
    echo "exists in node_modules, etc.). Fix before cutting the release — do NOT"
    echo "proceed to version bump."
    exit 1
  fi

  # Also grep for known crash markers that exit 0 but print a fatal error
  # (some module-init errors are caught by top-level try/catch but still log).
  if grep -qE "Expected CommonJS module|TypeError:|ReferenceError:|SyntaxError:" /tmp/archon-preflight.log; then
    echo "ERROR: compiled binary emitted a runtime error despite exit 0"
    cat /tmp/archon-preflight.log
    exit 1
  fi

  echo "Pre-flight binary smoke: PASSED"
fi
```

If this fails, **abort the release entirely** — do not bump version, do not modify CHANGELOG, do not create a PR. Surface the error to the user, point at the failing output, and stop. Recovery is: fix the bundler / dependency issue on a feature branch, merge to dev, re-run `/release`.

**Common failure modes this catches:**
- Bun `--bytecode` flag producing broken bytecode for the current module graph
- A dependency (e.g. an SDK) reading `package.json` or other files at module top level via paths that resolve fine in `node_modules/` but not next to a compiled binary
- Circular imports that break under minification but work under plain `bun run`
- A newly added package that ships CJS with an unusual wrapper shape

### Step 2: Detect Stack and Current Version

Detect the project's package manager and version file:

1. **Check for `pyproject.toml`** — Python project, version in `version = "x.y.z"`
2. **Check for `package.json`** — Node/Bun project, version in `"version": "x.y.z"`
3. **Check for `Cargo.toml`** — Rust project, version in `version = "x.y.z"`
4. **Check for `go.mod`** — Go project (version from git tags only, no file to bump)

If none found, abort: "Could not detect project stack — no version file found."

Read the current version from the detected file.

### Step 3: Determine Version Bump

**Bump rules based on argument:**
- No argument or `patch` (default): `0.1.0 -> 0.1.1`
- `minor`: `0.1.3 -> 0.2.0`
- `major`: `0.3.5 -> 1.0.0`

### Step 4: Collect Commits

> **Do NOT use `git log main..dev`.** This repo **squash**-merges the release PR
> into main, so main receives one new commit per release and never contains dev's
> individual commits. `main..dev` therefore accumulates *every commit ever
> squashed* and grows release over release. On 0.7.1 it returned **61** commits
> when only **25** were new — the other 36 were already shipped in 0.7.0 and
> already written into its changelog. Followed literally, it re-logs most of the
> previous release.

The real boundary is dev's own last `Release x.y.z` commit:

```bash
# The previous release commit ON DEV (not the squashed one on main).
#
# The `$` anchor is load-bearing. Both commits exist on dev after Step 9's sync:
#   6c6945ce  Release 0.7.1           <- dev's own version-bump commit  (WANT)
#   c71f7f52  Release 0.7.1 (#2435)   <- main's squash, pulled back     (WRONG)
# Picking the squash commit is catastrophic: its ancestry does not include dev's
# individual history, so the range balloons to the whole repo (383 commits when
# tested). Match the bare subject only.
LAST_RELEASE=$(git log origin/dev \
  --grep='^Release [0-9]+\.[0-9]+\.[0-9]+$' --extended-regexp \
  --format='%H' -n 1)

# First-ever release: fall back to the root commit. Without this the range
# becomes `..origin/dev`, which git resolves against HEAD and which returns
# ZERO commits — the skill would report "nothing to release" and stop.
if [ -z "$LAST_RELEASE" ]; then
  LAST_RELEASE=$(git rev-list --max-parents=0 origin/dev | tail -n 1)
fi
echo "Previous release commit: $(git log -1 --oneline "$LAST_RELEASE")"

# Everything after it is genuinely new, minus the release-plumbing commits
# described below.
git log "$LAST_RELEASE"..origin/dev --oneline --no-merges \
  --grep='^Release [0-9]+\.[0-9]+\.[0-9]+' \
  --grep='^chore: update Homebrew formula for v' \
  --grep='^chore\(homebrew\):' \
  --extended-regexp --invert-grep
```

> The backslashes in `^chore\(homebrew\):` are required. Under `--extended-regexp`
> bare `(` and `)` are grouping operators, so the unescaped form matches the
> literal text `chorehomebrew:` and silently fails to filter anything.

Two commit kinds in that range are **release plumbing, not changelog material**,
and the `--invert-grep` above drops them:

- `Release x.y.z (#NNNN)` — main's squash commit, pulled back by Step 9's sync
- `chore: update Homebrew formula for vx.y.z` / `chore(homebrew): …` — the CI job
  and the Step 10 commit; note these appear as *two different SHAs* with the same
  content, one per branch

> The `Release` pattern is anchored to a full `x.y.z` version deliberately. A bare
> `^Release ` would also swallow a legitimate feature commit whose subject starts
> with that word. If a real commit is ever dropped, widen the range by hand rather
> than loosening the pattern.

**Sanity-check the boundary before drafting.** Cross-reference against what the
previous version already documented — any overlap means the range is wrong.
Derive both headings from the current version so this does not rot:

```bash
# CURRENT_VERSION is the value read in Step 2, before the bump (e.g. 0.7.1)
PREV_MAJOR_MINOR_PATCH="$CURRENT_VERSION"
# The heading immediately above the one we are about to write:
awk -v prev="## [$PREV_MAJOR_MINOR_PATCH]" '
  index($0, prev) == 1 { on = 1; next }
  on && /^## \[/       { exit }
  on                   { print }
' CHANGELOG.md | grep -oE '#[0-9]{3,5}' | sort -u
```

If a PR number in your commit range appears in that list, stop and re-derive the
boundary — do not write it twice.

If no new commits, abort: "Nothing to release — dev is up to date with main."

### Step 5: Draft Changelog Entries

Read the commit messages and the actual diffs (`git diff "$LAST_RELEASE"..origin/dev`) to understand what changed.

Prefer the PR title and its `## Summary` section over the raw commit subject —
they state the user-visible problem, which is what a changelog entry needs:

```bash
gh pr view <N> --repo coleam00/Archon --json title,body
```

**Categorize into Keep a Changelog sections:**
- **Added** — new features, new files, new capabilities
- **Changed** — modifications to existing behavior
- **Fixed** — bug fixes
- **Removed** — deleted features or code

**Writing rules:**
- Write entries as a human would — clear, concise, user-facing language
- Do NOT just copy commit messages verbatim — rewrite them into proper changelog entries
- Group related commits into single entries where it makes sense
- Include PR numbers in parentheses when available: `(#12)`
- Each entry should start with a noun or gerund describing WHAT changed
- Skip internal-only changes (CI tweaks, typo fixes) unless they affect behavior
- One blank line between sections

### Step 6: Update Files

1. **Version file** — update version to new value:
   - `package.json`: update `"version": "x.y.z"`
   - `pyproject.toml`: update `version = "x.y.z"`
   - `Cargo.toml`: update `version = "x.y.z"`

2. **Workspace version sync** (monorepo only):
   - If `scripts/sync-versions.sh` exists, run `bash scripts/sync-versions.sh` to sync all `packages/*/package.json` versions to match the root version.

3. **Lockfile refresh** (stack-dependent):
   - `package.json` + `bun.lock`: run `bun install`
   - `package.json` + `package-lock.json`: run `npm install --package-lock-only`
   - `pyproject.toml` + `uv.lock`: run `uv lock --quiet`
   - `Cargo.toml`: run `cargo update --workspace`

4. **`CHANGELOG.md`** — prepend new version section:

```markdown
## [x.y.z] - YYYY-MM-DD

One-line summary of the release.

### Added

- Entry one (#PR)
- Entry two (#PR)

### Changed

- Entry one (#PR)

### Fixed

- Entry one (#PR)
```

Move any content under `[Unreleased]` into the new version section. Leave `[Unreleased]` header with nothing under it.

### Step 7: Present for Review

Show the user:
1. The detected stack and version file
2. The version bump (old -> new)
3. The full changelog section that will be added
4. The list of commits being included

Ask: "Does this look good? I'll commit and create the PR."

### Step 8: Commit and PR

Only after user approval:

```bash
# Stage version file, workspace packages, lockfile, and changelog
git add <version-file> packages/*/package.json <lockfile> CHANGELOG.md
git commit -m "Release x.y.z"

# Push dev
git push origin dev

# Create PR: dev -> main
gh pr create --base main --head dev \
  --title "Release x.y.z" \
  --body "$(cat <<'EOF'
## Release x.y.z

{changelog section content}

---

Merging this PR releases x.y.z to main.
EOF
)"
```

Return the PR URL to the user.

### Step 9: Tag, Release, and Sync After Merge

After the PR is merged (either by the user or via `gh pr merge`):

```bash
# Fetch the merge commit on main
git fetch origin main

# Tag the merge commit
git tag vx.y.z origin/main
git push origin vx.y.z

# Create a GitHub Release from the tag (uses changelog content as release notes)
gh release create vx.y.z --title "vx.y.z" --notes "{changelog section content without the ## header}"

# Sync dev with main so both branches are identical
git checkout dev
git pull origin main --no-rebase
git push origin dev

# Verify the sync actually converged — do not assume it did. FAIL CLOSED:
# continuing past a failed sync publishes a formula and tap from a tree that
# does not match what was released.
git fetch origin
if git merge-base --is-ancestor origin/main origin/dev; then
  echo "dev contains main — OK"
else
  echo "STILL DIVERGED — stranded on main:"
  git log origin/dev..origin/main --oneline
  exit 1
fi
```

> **`--no-rebase` is required, not optional.** Without it, git aborts with
> `fatal: Need to specify how to reconcile divergent branches` on any machine
> that has not set `pull.rebase`. It also pins the behaviour to the merge this
> step actually wants — a `pull.rebase=true` config would otherwise rewrite dev's
> history, which is exactly what the warning below forbids.

> **Expect to run this twice.** The CI `update-homebrew` job pushes its own
> formula commit to dev while you are working, so the `git push origin dev` here
> (and again in Step 10) can be rejected with `Updates were rejected`. That is
> normal: `git pull origin dev --no-rebase`, then push again. On 0.7.1 both this
> step and Step 10 required a second pass.

> **Important**: This sync ensures dev has the merge commit from main. Without it,
> dev and main diverge. The CI `update-homebrew` job only pushes the formula
> commit to dev — it does not bring the PR merge commit onto dev. This manual
> `git pull origin main --no-rebase` is what ensures dev has the merge commit.

> **Do NOT** use `git pull origin main --ff-only` or `git reset --hard origin/main`
> for this sync. Fast-forward is impossible across a squash merge — main's squash
> commit has a different SHA than dev's release commit, so dev is never
> fast-forwardable to main. And resetting dev to main rewrites dev's history,
> which severs every open PR's merge-base from its original commit and balloons
> their diffs to thousands of lines (confirmed against v0.3.10's release: PRs
> went from `+80/-1` to `+6626/-300` after a `git reset --hard origin/main` on
> dev). The plain `git pull origin main --no-rebase` above creates a regular merge commit on
> dev. The merge bubble in dev's `git log` is the right cost for preserving
> open-PR sanity. If the merge produces a `homebrew/archon.rb` conflict during a
> recovery flow, resolve with `git checkout origin/main -- homebrew/archon.rb`
> (note: `origin/main`, NOT `main` — local main is often stale because the
> release pushes via `git push origin dev:main` without fast-forwarding the local
> branch).

The GitHub Release is distinct from the git tag — without it, the release won't appear on the repository's Releases page. Always create it.

If the user merges the PR themselves and comes back, still offer to tag, release, and sync.

### Step 10: Wait for Release Workflow and Update Homebrew Formula

> **Note**: The `update-homebrew` CI job in `.github/workflows/release.yml` runs automatically
> after the release job and handles the formula update + push to dev (part of Step 10).
> Step 11 (tap sync to `coleam00/homebrew-archon`) is always manual. Check the Actions tab
> before running Step 10 manually.

After the tag is pushed, `.github/workflows/release.yml` builds platform binaries and uploads them to the GitHub release. This takes 5-10 minutes. The Homebrew formula SHA256 values cannot be known until these binaries exist.

**Wait for all assets to appear on the release:**

```bash
echo "Waiting for release workflow to finish uploading binaries..."
WORKFLOW_FAILED=0
for i in {1..30}; do
  ASSET_COUNT=$(gh release view "vx.y.z" --repo coleam00/Archon --json assets --jq '.assets | length')
  # Expect 7 assets: 5 binaries (darwin-arm64, darwin-x64, linux-arm64, linux-x64, windows-x64.exe) + archon-web.tar.gz + checksums.txt
  if [ "$ASSET_COUNT" -ge 7 ]; then
    echo "All $ASSET_COUNT assets uploaded"
    break
  fi

  # Short-circuit: if the release workflow itself has failed, stop waiting.
  # Hanging for 15 min when CI already crashed just delays the recovery path.
  WORKFLOW_STATUS=$(gh run list --workflow release.yml --event push --limit 1 --json conclusion,status --jq '.[0] | "\(.status)|\(.conclusion)"')
  if [[ "$WORKFLOW_STATUS" == "completed|failure" ]]; then
    echo "Release workflow FAILED — no point waiting longer"
    WORKFLOW_FAILED=1
    break
  fi

  echo "  Assets so far: $ASSET_COUNT/7 — waiting 30s (attempt $i/30)..."
  sleep 30
done

if [ "$WORKFLOW_FAILED" -eq 1 ] || [ "$ASSET_COUNT" -lt 7 ]; then
  # Triage: rerun once in case it's transient, then check again.
  RUN_ID=$(gh run list --workflow release.yml --event push --limit 1 --json databaseId --jq '.[0].databaseId')
  echo "Release workflow failed on run $RUN_ID. Rerunning failed jobs once to confirm..."
  gh run rerun "$RUN_ID" --failed
  gh run watch "$RUN_ID" --exit-status --interval 30 || true

  # Re-check asset count + run status after rerun.
  ASSET_COUNT=$(gh release view "vx.y.z" --repo coleam00/Archon --json assets --jq '.assets | length')
  if [ "$ASSET_COUNT" -ge 7 ]; then
    echo "Rerun succeeded — all assets now present"
  else
    echo ""
    echo "===== DETERMINISTIC CI FAILURE ====="
    echo "The release workflow failed on two consecutive runs. This is NOT a flake."
    echo "The tag and release exist but have no (or incomplete) assets."
    echo ""
    echo "install.sh and similar 'releases/latest' paths are now 404-ing."
    echo "Proceeding with Homebrew/tap sync would publish a formula pointing at"
    echo "missing or inconsistent binaries."
    echo ""
    echo "Jump to the 'Recovery: deterministic release CI failure' section at the"
    echo "bottom of this skill and execute it. Do NOT continue past this point."
    exit 1
  fi
fi
```

**Fetch checksums.txt and extract SHA256 values:**

```bash
TMP_DIR=$(mktemp -d)
gh release download "vx.y.z" --repo coleam00/Archon --pattern "checksums.txt" --dir "$TMP_DIR"

DARWIN_ARM64_SHA=$(awk '/archon-darwin-arm64$/ {print $1}' "$TMP_DIR/checksums.txt")
DARWIN_X64_SHA=$(awk '/archon-darwin-x64$/ {print $1}' "$TMP_DIR/checksums.txt")
LINUX_ARM64_SHA=$(awk '/archon-linux-arm64$/ {print $1}' "$TMP_DIR/checksums.txt")
LINUX_X64_SHA=$(awk '/archon-linux-x64$/ {print $1}' "$TMP_DIR/checksums.txt")

# Sanity check — all four must be present and non-empty
for var in DARWIN_ARM64_SHA DARWIN_X64_SHA LINUX_ARM64_SHA LINUX_X64_SHA; do
  if [ -z "${!var}" ]; then
    echo "ERROR: $var is empty — checksums.txt may be malformed"
    cat "$TMP_DIR/checksums.txt"
    exit 1
  fi
done

rm -rf "$TMP_DIR"
```

**Update `homebrew/archon.rb` in the main repo atomically with version AND SHAs:**

Rewrite the formula file using the exact template below. Do NOT edit in place with sed — the whole file should be regenerated from this template so there is zero risk of partial updates.

```bash
cat > homebrew/archon.rb << EOF
# Homebrew formula for Archon CLI
# To install: brew install coleam00/archon/archon
#
# This formula downloads pre-built binaries from GitHub releases.
# For development, see: https://github.com/coleam00/Archon

class Archon < Formula
  desc "Remote agentic coding platform - control AI assistants from anywhere"
  homepage "https://github.com/coleam00/Archon"
  version "x.y.z"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/coleam00/Archon/releases/download/v#{version}/archon-darwin-arm64"
      sha256 "${DARWIN_ARM64_SHA}"
    end
    on_intel do
      url "https://github.com/coleam00/Archon/releases/download/v#{version}/archon-darwin-x64"
      sha256 "${DARWIN_X64_SHA}"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/coleam00/Archon/releases/download/v#{version}/archon-linux-arm64"
      sha256 "${LINUX_ARM64_SHA}"
    end
    on_intel do
      url "https://github.com/coleam00/Archon/releases/download/v#{version}/archon-linux-x64"
      sha256 "${LINUX_X64_SHA}"
    end
  end

  def install
    binary_name = case
    when OS.mac? && Hardware::CPU.arm?
      "archon-darwin-arm64"
    when OS.mac? && Hardware::CPU.intel?
      "archon-darwin-x64"
    when OS.linux? && Hardware::CPU.arm?
      "archon-linux-arm64"
    when OS.linux? && Hardware::CPU.intel?
      "archon-linux-x64"
    end

    bin.install binary_name => "archon"
  end

  test do
    # Basic version check - archon version should exit with 0 on success
    assert_match version.to_s, shell_output("#{bin}/archon version")
  end
end
EOF
```

**Commit the formula update to main, then sync back to dev:**

```bash
git checkout main
git pull origin main --no-rebase
git add homebrew/archon.rb
git commit -m "chore(homebrew): update formula to vx.y.z"
git push origin main

# Sync dev with main so the formula update is on both branches
git checkout dev
git pull origin main --no-rebase
git push origin dev   # may be rejected — see below
```

**The CI `update-homebrew` job races you here.** It writes its own formula commit
directly to dev (e.g. `chore: update Homebrew formula for vx.y.z`) while you are
committing the same change to main. Both touch the same four `sha256` lines. The
push above then fails with `Updates were rejected`:

```bash
git pull origin dev --no-rebase   # merges CI's commit; usually resolves clean
git push origin dev
```

**A clean merge is not proof the SHAs are right.** Two commits editing the same
lines can merge without conflict and still leave the wrong values. Verify against
the published checksums before pushing — this is the one file where a wrong value
breaks every user's install:

```bash
VERSION=x.y.z   # without the leading v
gh release download "v$VERSION" --repo coleam00/Archon --pattern checksums.txt --dir /tmp/rel

fail=0

# Assert the formula version matches the release. A stale version points every
# URL at the wrong release while carrying the new digests.
formula_version=$(awk -F'"' '/^[[:space:]]*version "/ {print $2; exit}' homebrew/archon.rb)
if [ "$formula_version" != "$VERSION" ]; then
  echo "  BAD version: formula says '$formula_version', release is '$VERSION'"
  fail=1
fi

# Compare each digest against the sha256 that FOLLOWS ITS OWN url line. A naive
# `grep -q "$digest" formula` only asks whether the value appears anywhere, so
# two platforms with swapped hashes both pass — and an empty digest degenerates
# to `grep -q ""`, which matches every file.
for p in archon-darwin-arm64 archon-darwin-x64 archon-linux-arm64 archon-linux-x64; do
  real=$(awk -v p="$p" '$2 ~ "(^|/)" p "$" {print $1}' /tmp/rel/checksums.txt | head -1)
  if ! printf '%s' "$real" | grep -qE '^[0-9a-f]{64}$'; then
    echo "  BAD $p: no 64-char digest in checksums.txt (got '$real')"
    fail=1
    continue
  fi
  in_formula=$(awk -v p="$p" '
    index($0, "/" p "\"") { seen = 1; next }
    seen && /sha256 "/    { gsub(/.*sha256 "|".*/, ""); print; exit }
  ' homebrew/archon.rb)
  if [ "$in_formula" = "$real" ]; then
    echo "  OK   $p"
  else
    echo "  BAD  $p: formula has '$in_formula', release has '$real'"
    fail=1
  fi
done

[ "$fail" -eq 0 ] || { echo "formula verification FAILED — do not push"; exit 1; }
echo "formula verified against v$VERSION checksums"
```

Every line must print `OK` and the version must match. On any `BAD`, regenerate
the formula from the Step 10 template rather than hand-editing — a hand edit is
how a digest ends up under the wrong platform in the first place.

Finally, confirm convergence. **Fail closed** — Step 11 publishes to the tap that
users install from, so do not proceed on an unconverged tree:

```bash
git fetch origin
converged=1
git merge-base --is-ancestor origin/main origin/dev \
  || { echo "DIVERGED: dev does not contain main"; converged=0; }
stranded=$(git log origin/dev..origin/main --oneline | wc -l | tr -d ' ')
[ "$stranded" -eq 0 ] || { echo "STRANDED: $stranded commit(s) on main not on dev:"; \
  git log origin/dev..origin/main --oneline; converged=0; }
[ "$converged" -eq 1 ] || { echo "sync incomplete — resolve before Step 11"; exit 1; }
echo "branches converged — OK"
```

### Step 11: Sync the Homebrew Tap Repo

The `coleam00/homebrew-archon` repository hosts the actual tap formula that Homebrew reads when users run `brew tap coleam00/archon && brew install coleam00/archon/archon`. The file `coleam00/Archon/homebrew/archon.rb` is the source-of-truth template; the file `coleam00/homebrew-archon/Formula/archon.rb` is what users actually install from. These must be kept in sync.

```bash
TAP_DIR=$(mktemp -d)
git clone git@github.com:coleam00/homebrew-archon.git "$TAP_DIR"
cp homebrew/archon.rb "$TAP_DIR/Formula/archon.rb"

cd "$TAP_DIR"
if git diff --quiet; then
  echo "Tap formula already matches — no sync needed"
else
  git add Formula/archon.rb
  git commit -m "chore: sync formula to vx.y.z"
  git push origin main
fi
cd -
rm -rf "$TAP_DIR"
```

If the `git clone` fails with a permissions error, the user running the release skill does not have push access to `coleam00/homebrew-archon`. Ask them to request push access from the repo owner, or to perform the sync manually via the GitHub web UI. Do not skip this step silently — the release is not complete until the tap is synced.

### Step 12: Verify the Release End-to-End

After the formula is synced, the final verification step is to actually install the released binary via Homebrew and run smoke tests. Use the `test-release` skill:

```
/test-release brew x.y.z
```

This will:
- Install via `brew tap coleam00/archon && brew install coleam00/archon/archon`
- Verify the binary reports the correct version and `Build: binary`
- Verify bundled workflows load
- Verify the SDK spawn path works (a minimal assist workflow)
- Verify the env-leak gate is active (if shipped in this release)
- Uninstall cleanly
- Produce a PASS/FAIL report

**If `/test-release brew` fails, the release is not ready to announce.** File a hotfix issue for whatever broke, cut `x.y.z+1` with the fix, and re-run this skill. Do NOT advertise a release that fails `test-release`.

Also run `/test-release curl-mac x.y.z` to cover the curl install path. The two install paths test slightly different things (Homebrew tests the tap formula, curl tests `install.sh` and checksums from the release) and both need to work for users to have a reliable install experience.

If you have a VPS available, also run `/test-release curl-vps x.y.z <vps-target>` to verify the Linux binary.

## Recovery: deterministic release CI failure

Reached here because Step 10 detected two consecutive workflow failures. The tag `vx.y.z` is pushed, the GitHub release exists, but assets are missing or incomplete. Every `install.sh` run currently resolves `releases/latest` to this broken release and 404s on download. Homebrew users are safe because Step 10's atomic formula update was blocked.

**Do not re-run the release workflow a third time hoping it succeeds.** If the failure was reproducible twice, it's a code bug — you need to ship code to fix it.

### Immediate mitigation (restore `install.sh`)

Delete the GitHub Release so `releases/latest` falls back to the previous version. Keep the git tag — tag immutability matters and there are no shipped artifacts pointing at it anyway.

```bash
gh release delete "vx.y.z" --yes
# Do NOT delete the tag:
#   git push --delete origin vx.y.z   ← do not run
# Tag stays so git history records the attempt; no release means no assets
# means releases/latest resolves to the prior working release.
```

Verify:

```bash
gh api repos/coleam00/Archon/releases/latest --jq '.tag_name'
# should now print the prior version (e.g. v0.3.6), not vx.y.z
```

### Diagnose

The release workflow logs tell you which target failed and at what stage (compile vs. smoke-test vs. upload):

```bash
gh run list --workflow release.yml --limit 2 --json databaseId,conclusion
gh run view <RUN_ID> --log-failed
```

Common causes:
- **Bundler/bytecode bug** — Bun `--bytecode` produces invalid output for the current module graph. Symptom: `TypeError: Expected CommonJS module to have a function wrapper` at binary startup. Historically caused by a new dependency's CJS/ESM shape interacting with `--bytecode` — dropping the flag or lazy-importing the offending module has been the fix.
- **Module-init crash** — a dependency does `readFileSync('package.json')` or similar at module top level via a path that exists in `node_modules/` but not next to a compiled binary. Symptom: every binary subcommand crashes immediately; error typically mentions a missing file adjacent to `process.execPath`. Fix by lazy-importing the dependency behind the code path that actually uses it.
- **Smoke-test timeout on Windows** — not actually a bug in the code; the Windows runner is slow. Rerun once; if it recurs, bump the test timeout.

Step 1.5 now runs a local compiled-binary smoke test before any user-visible step. If the failure mode above reproduces locally, you've found it. If it doesn't, the bug is platform-specific (Windows cross-compile, Linux glibc, etc.) and you need the CI logs.

### Fix and re-release as the NEXT patch

**Do not reuse `vx.y.z`.** Cut `vx.y.(z+1)` (or next-minor if warranted) with the fix. Rationale:
- Tag immutability: `vx.y.z` is already recorded in git history and release cache
- Semver clarity: users and tooling should see a new version number when the bits change
- Audit trail: "v0.3.7 was cut but had no shipped binaries; v0.3.8 is the first release with <fix>" is cleaner than rewriting v0.3.7

Steps:

1. Cut a fix branch off dev, implement the fix, PR to dev, merge.
2. Re-run `/release` (it will bump to the next patch — e.g. `0.3.8` — automatically).
3. Step 1.5's pre-flight smoke will catch the same bug locally if the fix didn't actually fix it. Iterate until it passes before tagging.

### CHANGELOG note for the hotfix release

Include a line in the new release's CHANGELOG that references the broken prior version so users understand why there's no binary artifact under that tag:

```markdown
### Fixed

- **First release with working compiled binaries after vx.y.z's <bug>.** vx.y.z was tagged but its binary smoke test failed deterministically (see RUN_ID in CI history). The tag is preserved for history; this release (vx.y.(z+1)) is the first with shipped binaries. `install.sh` and Homebrew were never updated to vx.y.z, so users were not exposed to the broken state.
```

### What NOT to do

- **Do not force-push or rewrite the tag.** Once a tag exists, it's a public promise of that SHA. Deleting and re-creating to a different SHA is tag-spoofing and breaks any downstream that cached the original.
- **Do not skip this recovery path to "just push more binaries to the broken release".** The release exists with a specific commit SHA; uploading binaries built from a newer SHA creates binary/source drift that is hard to diagnose later.
- **Do not update the Homebrew formula before v0.3.(z+1) is fully shipped.** The formula should always point at a version with all 7 assets uploaded and `/test-release brew` passing.

## Important Rules

- NEVER force push
- **NEVER derive the changelog from `git log main..dev`.** main squash-merges, so
  that range accumulates every previously-released commit and grows each release
  (61 vs 25 actual on 0.7.1). Use dev's last `Release x.y.z` commit as the
  boundary, and cross-check the result against the previous version's changelog
  entries — any PR number appearing in both means the boundary is wrong.
- **ALWAYS pass `--no-rebase` to `git pull`.** The bare form aborts with
  `Need to specify how to reconcile divergent branches` unless `pull.rebase` is
  configured, and a `pull.rebase=true` config would rewrite dev's history.
- **ALWAYS verify sync convergence rather than assuming it.**
  `git merge-base --is-ancestor origin/main origin/dev` after every sync step.
  A commit made directly to main stays stranded silently otherwise.
- **NEVER trust a clean `homebrew/archon.rb` merge.** The CI `update-homebrew`
  job edits the same `sha256` lines on dev that you edit on main; the merge can
  succeed and still be wrong. Diff the four values against the published
  `checksums.txt` before pushing.
- **Flag a version bump that contradicts the commit range.** If `patch` was
  requested but the range contains `feat:` commits or new user-facing CLI
  surface, say so at the Step 7 review and let the user decide — do not silently
  ship features as a patch.
- **NEVER skip Step 1.5 (pre-flight compiled-binary smoke).** If the stack is a Bun/Node project with a build-binaries script, the `bun build --compile` smoke test runs before version bump, PR, or tag. Skipping it means every bundler regression or module-init crash only surfaces after the tag is pushed — by which point `releases/latest` is already 404-ing for every user. The ~30s cost is paid to keep the failure mode local.
- If Step 1.5 fails, **abort the release** and fix the underlying issue on a feature branch. Do not "just skip it" and hope CI doesn't repro the problem.
- NEVER skip the review step — always show the changelog before committing
- NEVER include "Co-Authored-By: Claude" or any AI attribution in the commit
- NEVER add emoji to changelog entries unless the user asks
- If the user says "ship it" without specifying bump type, default to patch
- The commit message is just `Release x.y.z` — clean and simple
- **NEVER update `homebrew/archon.rb` version field without also updating the `sha256` values**. They must move together atomically. The correct SHAs only exist after the release workflow finishes building binaries — see Step 10. Updating the version field alone produces a stale formula that looks valid but causes checksum mismatches on install.
- **NEVER skip Step 11 (tap sync).** The `coleam00/Archon/homebrew/archon.rb` file is only a template; users install from `coleam00/homebrew-archon/Formula/archon.rb`. If you update one without the other, users get stale or wrong data.
- **NEVER announce a release that failed `/test-release brew`.** A release that installs but crashes on first invocation is worse than no release — it burns user trust. If the release verification fails, cut a hotfix before telling anyone the release exists.
