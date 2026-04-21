# HarneesLab Full Rebrand Plan

## Goal

Replace the remaining Archon-branded product, CLI, package, release, path, and repository surfaces with HarneesLab branding.

## Naming Decisions

Use these names unless the owner explicitly changes them before implementation:

- Public display name: `HarneesLab`
- Repository/display slug: `HarneesLab`
- CLI command: `hlab`
- Long CLI alias: `harneeslab` if a compatibility alias is useful for installers/docs
- npm package scope: `@harneeslab`
- Docker image prefix: `harneeslab`
- Release asset prefix: `hlab`
- User home directory: `~/.harneeslab`
- Docker home directory: `/.harneeslab`
- Environment variable prefix: `HARNEESLAB_`
- GitHub bot mention default: `@HarneesLab`
- Legacy compatibility: keep `archon` aliases only where needed for migration, then remove after a compatibility window.

## Current State

- Branch prepared for implementation: `codex/harneeslab-full-rebrand`
- Base commit: `e27d2c4e`
- `dev` has no unmerged local branches or stashes at preparation time.
- This branch targets `harneeslab.codewithgenie.com`; DNS and GitHub Pages custom-domain activation should be coordinated before merge.
- Phase 1 changes package scope to `@harneeslab/*` and CLI binary to `hlab`.

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
- `.github/workflows/harneeslab-release.yml`
- `.github/workflows/test.yml`
- `scripts/build-binaries.sh`
- `scripts/checksums.sh`
- `scripts/install.sh`
- `scripts/install.ps1`
- `scripts/update-homebrew.sh`
- `homebrew/hlab.rb`
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
   - Rename workspace package scope from `@archon/*` to `@harneeslab/*`.
   - Update all internal imports and tests.
   - Update root scripts that use `bun --filter @harneeslab/...`.
   - Run `bun install` to update `bun.lock`.

2. CLI and binary rename
   - Change `packages/cli/package.json` bin from `archon` to `hlab`.
   - Update CLI examples, help text, tests, install scripts, checksum scripts, release assets, and Homebrew formula.
   - Decide whether to ship an `archon` compatibility shim for one release.

3. Runtime path and environment rename
   - Rename `ARCHON_HOME`, `ARCHON_DOCKER`, and `ARCHON_DATA` to `HARNEESLAB_HOME`, `HARNEESLAB_DOCKER`, and `HARNEESLAB_DATA`.
   - Rename default directories from `.archon` to `.harneeslab`.
   - Add migration or fallback logic so existing users with `~/.archon` are not stranded.
   - Update tests for local, Docker, and custom env paths.

4. Workflow and command namespace rename
   - Rename bundled command/workflow names from `archon-*` to `harneeslab-*`.
   - Update router suffix/substring tests, default generated bundle, and workflow references.
   - Run `bun run generate:bundled` and `bun run check:bundled`.

5. Release and deployment rename
   - Rename binary assets from `archon-*` to `hlab-*`, with the installed executable named `hlab`.
   - Rename Homebrew formula file from `homebrew/hlab.rb` to `homebrew/hlab.rb`.
   - Update GHCR image names, Docker service names, volumes, network names, and CI smoke container names.
   - Update GitHub release notes/install snippets.

6. Repository and local folder rename
   - Rename GitHub repository from `NewTurn2017/Archon` to `NewTurn2017/HarneesLab` after code PR is ready.
   - Update local remote URLs after GitHub rename.
   - Rename local checkout folder from `/Users/genie/dev/lab/archon` to `/Users/genie/dev/lab/harneeslab` after the active branch is pushed and no process depends on the old path.

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
DOCS_SITE_URL=https://harneeslab.codewithgenie.com bun run build:docs
bun run build:binaries
```

Targeted checks that should be added or updated:

- CLI help and command invocation for `hlab`.
- Backward compatibility behavior for `ARCHON_HOME` and `~/.archon`, if compatibility is kept.
- Docker compose path/env behavior for `HARNEESLAB_DATA`.
- Release checksum lookup for `hlab-web.tar.gz` and platform binaries.
- Workflow discovery with `harneeslab-*` bundled workflows.

## Risks

- A blind text replace will break package imports, generated bundles, install scripts, and tests.
- Renaming `.archon` to `.harneeslab` changes user data location; migration needs an explicit policy.
- Release assets and Homebrew formula names must change together or installs will break.
- Repository rename should happen after the code PR is green so GitHub redirects do not hide broken hard-coded URLs.
