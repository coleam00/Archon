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
git pull origin dev
git status --porcelain  # must be empty
git fetch origin main
```

If not on dev or working tree is dirty, abort with a clear message.

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

```bash
# Get all commits on dev that aren't on main
git log main..dev --oneline --no-merges
```

If no new commits, abort: "Nothing to release — dev is up to date with main."

### Step 5: Draft Changelog Entries

Read the commit messages and the actual diffs (`git diff main..dev`) to understand what changed.

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
git pull origin main
git push origin dev
```

> **Important**: This sync ensures dev has the merge commit from main. Without it,
> dev and main diverge. The CI `update-homebrew` job only pushes the formula
> commit to dev — it does not bring the PR merge commit onto dev. This manual
> `git pull origin main` is what ensures dev has the merge commit.

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
for i in {1..30}; do
  ASSET_COUNT=$(gh release view "vx.y.z" --repo coleam00/Archon --json assets --jq '.assets | length')
  # Expect 7 assets: 5 binaries (darwin-arm64, darwin-x64, linux-arm64, linux-x64, windows-x64.exe) + archon-web.tar.gz + checksums.txt
  if [ "$ASSET_COUNT" -ge 7 ]; then
    echo "All $ASSET_COUNT assets uploaded"
    break
  fi
  echo "  Assets so far: $ASSET_COUNT/7 — waiting 30s (attempt $i/30)..."
  sleep 30
done

if [ "$ASSET_COUNT" -lt 7 ]; then
  echo "ERROR: Release workflow did not finish uploading assets after 15 minutes"
  echo "Check https://github.com/coleam00/Archon/actions for the release workflow run"
  exit 1
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
git pull origin main
git add homebrew/archon.rb
git commit -m "chore(homebrew): update formula to vx.y.z"
git push origin main

# Sync dev with main so the formula update is on both branches
git checkout dev
git pull origin main
git push origin dev
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

## Important Rules

- NEVER force push
- NEVER skip the review step — always show the changelog before committing
- NEVER include "Co-Authored-By: Claude" or any AI attribution in the commit
- NEVER add emoji to changelog entries unless the user asks
- If the user says "ship it" without specifying bump type, default to patch
- The commit message is just `Release x.y.z` — clean and simple
- **NEVER update `homebrew/archon.rb` version field without also updating the `sha256` values**. They must move together atomically. The correct SHAs only exist after the release workflow finishes building binaries — see Step 10. Updating the version field alone produces a stale formula that looks valid but causes checksum mismatches on install.
- **NEVER skip Step 11 (tap sync).** The `coleam00/Archon/homebrew/archon.rb` file is only a template; users install from `coleam00/homebrew-archon/Formula/archon.rb`. If you update one without the other, users get stale or wrong data.
- **NEVER announce a release that failed `/test-release brew`.** A release that installs but crashes on first invocation is worse than no release — it burns user trust. If the release verification fails, cut a hotfix before telling anyone the release exists.
