# Harness Lab Full Rebrand Plan

## Goal

Replace the remaining Archon-branded product, CLI, package, release, path, and repository surfaces with Harness Lab branding.

## Naming Decisions

Use these names unless the owner explicitly changes them before implementation:

- Public display name: `Harness Lab`
- Repository/display slug: `HarnessLab`
- CLI command: `harnesslab`
- npm package scope: `@harnesslab`
- Docker image/release asset prefix: `harnesslab`
- User home directory: `~/.harnesslab`
- Docker home directory: `/.harnesslab`
- Environment variable prefix: `HARNESSLAB_`
- GitHub bot mention default: `@HarnessLab`
- Legacy compatibility: keep `archon` aliases only where needed for migration, then remove after a compatibility window.

## Current State

- Branch prepared for implementation: `codex/harness-lab-full-rebrand`
- Base commit: `e27d2c4e`
- `dev` has no unmerged local branches or stashes at preparation time.
- Existing public docs already use `harnesslab.codewithgenie.com`.
- Existing package scope and CLI binary still use `archon` / `@archon`.

## Scope Inventory

Primary code and package surfaces:

- `package.json`
- `packages/*/package.json`
- `packages/cli/package.json`
- `packages/cli/src/**`
- `packages/paths/src/archon-paths.ts`
- `packages/paths/src/archon-paths.test.ts`
- `packages/core/src/config/**`
- `packages/core/src/orchestrator/**`
- `packages/server/src/**`
- `packages/adapters/src/**`
- `packages/workflows/src/**`
- `.archon/commands/defaults/**`
- `.archon/workflows/defaults/**`

Release, install, and deployment surfaces:

- `.github/workflows/release.yml`
- `.github/workflows/harnesslab-release.yml`
- `.github/workflows/test.yml`
- `scripts/build-binaries.sh`
- `scripts/checksums.sh`
- `scripts/install.sh`
- `scripts/install.ps1`
- `scripts/update-homebrew.sh`
- `homebrew/archon.rb`
- `Dockerfile`
- `docker-compose.yml`
- `deploy/**`

Docs and user-facing surfaces:

- `README.md`
- `SECURITY.md`
- `CONTRIBUTING.md`
- `CLAUDE.md`
- `packages/docs-web/**`
- `packages/web/**`
- `auth-service/server.js`

## Implementation Phases

1. Package and import rename
   - Rename workspace package scope from `@archon/*` to `@harnesslab/*`.
   - Update all internal imports and tests.
   - Update root scripts that use `bun --filter @archon/...`.
   - Run `bun install` to update `bun.lock`.

2. CLI and binary rename
   - Change `packages/cli/package.json` bin from `archon` to `harnesslab`.
   - Update CLI examples, help text, tests, install scripts, checksum scripts, release assets, and Homebrew formula.
   - Decide whether to ship an `archon` compatibility shim for one release.

3. Runtime path and environment rename
   - Rename `ARCHON_HOME`, `ARCHON_DOCKER`, and `ARCHON_DATA` to `HARNESSLAB_HOME`, `HARNESSLAB_DOCKER`, and `HARNESSLAB_DATA`.
   - Rename default directories from `.archon` to `.harnesslab`.
   - Add migration or fallback logic so existing users with `~/.archon` are not stranded.
   - Update tests for local, Docker, and custom env paths.

4. Workflow and command namespace rename
   - Rename bundled command/workflow names from `archon-*` to `harnesslab-*`.
   - Update router suffix/substring tests, default generated bundle, and workflow references.
   - Run `bun run generate:bundled` and `bun run check:bundled`.

5. Release and deployment rename
   - Rename binary assets from `archon-*` to `harnesslab-*`.
   - Rename Homebrew formula file from `homebrew/archon.rb` to `homebrew/harnesslab.rb`.
   - Update GHCR image names, Docker service names, volumes, network names, and CI smoke container names.
   - Update GitHub release notes/install snippets.

6. Repository and local folder rename
   - Rename GitHub repository from `NewTurn2017/Archon` to `NewTurn2017/HarnessLab` after code PR is ready.
   - Update local remote URLs after GitHub rename.
   - Rename local checkout folder from `/Users/genie/dev/lab/archon` to `/Users/genie/dev/lab/harnesslab` after the active branch is pushed and no process depends on the old path.

## Validation Gates

Run these before publishing the full rebrand PR:

```bash
bun install
bun run generate:bundled
bun run check:bundled
bun run type-check
bun run lint --max-warnings 0
bun run format:check
bun run test
DOCS_SITE_URL=https://harnesslab.codewithgenie.com bun run build:docs
bun run build:binaries
```

Targeted checks that should be added or updated:

- CLI help and command invocation for `harnesslab`.
- Backward compatibility behavior for `ARCHON_HOME` and `~/.archon`, if compatibility is kept.
- Docker compose path/env behavior for `HARNESSLAB_DATA`.
- Release checksum lookup for `harnesslab-web.tar.gz` and platform binaries.
- Workflow discovery with `harnesslab-*` bundled workflows.

## Risks

- A blind text replace will break package imports, generated bundles, install scripts, and tests.
- Renaming `.archon` to `.harnesslab` changes user data location; migration needs an explicit policy.
- Release assets and Homebrew formula names must change together or installs will break.
- Repository rename should happen after the code PR is green so GitHub redirects do not hide broken hard-coded URLs.
