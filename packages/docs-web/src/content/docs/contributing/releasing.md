---
title: Releasing
description: How to create a new release of the Archon CLI — version management, release process, and troubleshooting.
category: contributing
area: infra
audience: [developer]
status: current
sidebar:
  order: 3
---

This guide covers how to create a new release of the Archon CLI.

## Version Management

Versions follow [Semantic Versioning](https://semver.org/):
- **Major** (1.0.0): Breaking changes to CLI interface or workflow format
- **Minor** (0.1.0): New features, new workflows, new commands
- **Patch** (0.0.1): Bug fixes, documentation updates

Version is stored in the root `package.json` only -- this is the single source of truth.

## Release Process

Releases are created by merging `dev` into `main`. Never commit directly to `main`.

### 1. Prepare the Release

Use the `/release` skill (or follow these manual steps):

```bash
# Ensure dev is up to date
git checkout dev
git pull origin dev

# Run full validation
bun run validate
```

The `/release` skill automates the following:
1. Compares `dev` to `main` to generate changelog entries
2. Bumps the version in root `package.json` (patch by default; use `/release minor` or `/release major` for other increments)
3. Updates `CHANGELOG.md` following Keep a Changelog format
4. Creates a PR from `dev` to `main`

### 2. Merge and Tag

Once the release PR is reviewed and merged:

```bash
# Create and push the tag from main
git checkout main
git pull origin main
git tag vX.Y.Z
git push origin vX.Y.Z
```

This triggers the GitHub Actions release workflow which:
1. Builds binaries for all platforms (macOS arm64/x64, Linux arm64/x64, Windows x64)
2. Generates checksums
3. Creates a GitHub Release with all artifacts

### 3. Update Homebrew Formula (Optional)

After the release workflow completes:

```bash
# Update checksums in the Homebrew formula
./scripts/update-homebrew.sh vX.Y.Z

# Review and commit
git diff homebrew/archon.rb
git add homebrew/archon.rb
git commit -m "chore: update Homebrew formula for vX.Y.Z"
git push origin main
```

If you maintain a Homebrew tap (`homebrew-archon`), copy the updated formula there.

### 4. Verify the Release

```bash
# Test the install script (only works if repo is public)
curl -fsSL https://raw.githubusercontent.com/coleam00/Archon/main/scripts/install.sh | bash

# Verify version
archon version
```

> **Note: Private Repository Installation**
>
> If the repository is private, the curl install script won't work for anonymous users.
> Use the GitHub CLI instead:
>
> ```bash
> # Download and install using gh (requires GitHub authentication)
> gh release download v0.2.0 --repo coleam00/Archon \
>   --pattern "archon-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')" \
>   --dir /tmp/archon-install
>
> # Install the binary
> chmod +x /tmp/archon-install/archon-*
> sudo mv /tmp/archon-install/archon-* /usr/local/bin/archon
>
> # Verify
> archon version
> ```

## Manual Release (When GitHub Actions Unavailable)

If GitHub Actions can't run (billing issues, private repo limits), create the release manually:

```bash
# 1. Build binaries locally (only builds for your current platform)
./scripts/build-binaries.sh

# 2. Create the release with binaries
gh release create vX.Y.Z dist/binaries/* \
  --title "Archon CLI vX.Y.Z" \
  --generate-notes

# 3. Verify the release
gh release view vX.Y.Z
```

> **Note:** Local builds only create binaries for your current platform.
> For cross-platform binaries, you need GitHub Actions or access to each platform.

## Manual Build (for Testing)

To build binaries locally without creating a release:

```bash
# Build all platform binaries
./scripts/build-binaries.sh

# Binaries are in dist/binaries/
ls -la dist/binaries/

# Generate checksums
./scripts/checksums.sh
```

## Release Workflow Details

The `.github/workflows/release.yml` workflow:

1. **Triggers on**:
   - Push of tags matching `v*`
   - Manual workflow dispatch with version input

2. **Build job** (runs in parallel for each platform):
   - Sets up Bun
   - Installs dependencies
   - Compiles binary with `bun build --compile`
   - Uploads as artifact

3. **Release job** (runs after all builds complete):
   - Downloads all artifacts
   - Generates SHA256 checksums
   - Creates GitHub Release with:
     - All binaries attached
     - checksums.txt
     - Auto-generated release notes
     - Installation instructions

## Troubleshooting

### Build Fails on GitHub Actions

Check the Actions tab for specific errors. Common issues:
- Dependency installation failure: Check `bun.lock` is committed
- Type errors: Run `bun run type-check` locally first

### Install Script Fails

The install script requires:
- `curl` for downloading
- `sha256sum` or `shasum` for verification
- Write access to `/usr/local/bin` (or custom `INSTALL_DIR`)

### Checksums Don't Match

If users report checksum failures:
1. Check the release artifacts are complete
2. Verify checksums.txt was generated correctly
3. Ensure binaries weren't modified after checksum generation

## Pre-release Versions

For testing releases before public announcement:

```bash
# Create a pre-release tag
git tag v0.3.0-beta.1
git push origin v0.3.0-beta.1
```

Pre-releases (tags containing `-`) are marked as such on GitHub.

## Hotfix Process

For urgent fixes to a released version:

```bash
# Create hotfix branch from tag
git checkout -b hotfix/0.2.1 v0.2.0

# Make fixes, then tag
git tag v0.2.1
git push origin v0.2.1

# Merge fixes back to dev
git checkout dev
git merge hotfix/0.2.1
git push origin dev
```
