# Contributing

Thank you for your interest in contributing to Archon!

## Getting Started

1. Fork the repository
2. Clone your fork
3. Install dependencies: `bun install`
4. Copy `.env.example` to `.env` and configure
5. Start development: `bun run dev`

## Development Workflow

### Code Quality

Packages using the shared test runner without legacy `testGroups` discover tests
under `src` automatically (`*.test.ts`, `*.spec.ts`, and their `.tsx` equivalents).
Core uses this default. A test that uses `mock.module()`, directly
or through a helper, must start with the exact line `// @archon-test-isolated`;
discovery fails on a direct call without it.
Use the same directive for any other test requiring a fresh process. Unmarked tests
share one process. Run package test scripts to preserve isolation; requested selectors
are forwarded to Bun verbatim and bypass default grouping.

`bun run validate` is the gate. Run it before opening a pull request: it runs every
check that gates a pull request except the jobs listed below. A green run means CI's `test`
and `workflow-fixtures` jobs will pass on your OS. CI runs the `static` job on Linux only; a
green run on another OS predicts it because type-check, lint and format do not depend on the
OS, and the generated-file checks run on both Linux and Windows. It needs no network and no
services, takes a couple of minutes, and prints what each check cost so you can see
where the time goes.

```bash
bun run validate                            # the whole gate
bun run validate --only workflow-fixtures   # one check, while iterating
```

`scripts/validate.ts` owns the list of checks, and the CI jobs call that script instead
of restating its commands, so the two cannot describe different work.

While you work, run the narrow check instead — `bun run type-check`, `bun run lint`,
`bun run test <path>`, `bun run check:bundled` — and keep the full gate for the end.

**Important:** Use `bun run test` (not `bun test` from the repo root) to avoid mock pollution across packages.

**macOS:** tests that compile a fresh binary with `bun build --compile` skip on macOS and print a line saying so. Running them locally has preceded a stuck `syspolicyd` that stalls every new process on the machine until a reboot. CI runs them on Linux and Windows. Set `ARCHON_TEST_COMPILED_BINARIES=1` to run them on a Mac anyway. A new test that compiles a binary gates itself on `skipCompiledBinaryTests()` from `@archon/paths/test-utils`.

#### What `bun run validate` deliberately leaves out

These PR-gating jobs need something a contributor may not have, so they stay in CI only.
If you touched what they cover, run them yourself.

| CI job | Needs | Run it yourself |
| --- | --- | --- |
| `schema-upgrade` | a live PostgreSQL; the SQLite half also reads every release tag | `bun run check:schema-upgrades` (`PGHOST`/`PGUSER`/… or `DATABASE_URL`) and `bun run check:sqlite-vintages` |
| `postgres-parity` | a PostgreSQL service; conformance creates and drops scratch databases and requires `CREATE DATABASE` permission | `ARCHON_TEST_PG_URL=postgres://… bun test packages/core/src/db/isolation-environments.live-run.postgres.integration.test.ts`, then the same for `packages/core/src/db/resource-slots.postgres.integration.test.ts`, `packages/core/src/db/provider-attempts.postgres.integration.test.ts`, `packages/core/src/db/workflows.postgres.integration.test.ts`, `packages/core/src/db/workflow-events.provider-events.postgres.integration.test.ts`, and `packages/core/src/db/workflow-store.conformance.postgres.integration.test.ts` |
| `docker-build` | a Docker daemon, and ~14GB of free disk for the image | `docker build .` |
| `serve-binary` | compiled CLI and server artifacts; CI runs the build and smoke on Linux and Windows | CI only; no local compilation on macOS |
| `docs-build` | Node (Astro's CLI does not run under Bun); path-filtered to `packages/docs-web/` | `bun run build:docs` — run it when you change the docs site |

The `serve-binary` CI job builds matching CLI and server executables on Linux and
Windows, then checks `archon serve` against `/api/health` and the console. The
release workflow runs the same smoke with its release artifacts. These compiled
checks, and the server-free bundle assertion (including a restored-import
negative proof), run in CI. Local `check:cli-import-boundary` still checks startup
and policy import boundaries. Do not compile these binaries locally on macOS.

**Schema changes**: run `bun run check:schema-upgrades` and `bun run check:sqlite-vintages`
yourself if you touched `migrations/000_combined.sql`. A statement that applies cleanly to a fresh install can
abort the whole apply on an upgrade, and nothing before that job catches it.

`scripts/validate-ci-parity.test.ts` holds the same exclusions as a machine-checked list,
so another PR-gating command cannot appear without a deliberate decision to leave it out.

**SDLC workflows**: We do not accept pull requests that change
`.archon/workflows/sdlc/`. Open an issue instead and describe the problem or
change you want the maintainers to consider.

### Publishing the container image

The `Publish` workflow checks provenance and SBOM attestations on the pushed image
digest. Keep `provenance: mode=max` and `sbom: true` enabled.
Build arguments are published in the attestation; secrets must use `secrets:`, whose values are excluded.
See [Verifying image attestations](packages/docs-web/src/content/docs/deployment/docker.md#verifying-image-attestations)
for the consumer inspection commands.

### Commit messages

Follow the repository's Conventional Commit style. Write a concise,
human-readable subject that explains the meaningful outcome. Commit subjects
may become changelog entries or pull request titles, so they must make sense
without the diff.

Use plain language and the repository's exact terms. Cut filler and vague verbs.
Do not present a mechanical change as a larger outcome. Treat Git history as
evidence of valid structure, not as the writing-quality standard.

Never add AI attribution, generated-by text, robot emoji, or
`Co-Authored-By: $Agent`.

**Bad:** `refactor(prp-pr): update skill instructions`

**Good:** `refactor(prp-pr): PR creation now uses one focused workflow`

### Pull requests

1. Create a feature branch from `dev`.
2. Keep the pull request focused on one coherent slice or concern. Split broad
   work into reviewable pull requests organized by product slices or concerns.
   Pull requests that combine too many concerns will be closed.
3. Ensure all checks pass.
4. Use the template at
   [`.github/pull_request_template.md`](./.github/pull_request_template.md).
   GitHub fills it in when you open a pull request through the Web UI. If you
   use `gh pr create`, copy the template into the body. Keep **Problem and
   outcome**, **Review guidance**, **Solution**, and **Validation**. Delete
   conditional sections that do not apply instead of filling them with "N/A".
   Bot-authored dependency pull requests (`renovate[bot]`) are exempt because
   Renovate generates the body.
5. Link the issue the pull request addresses with `Closes #<number>`,
   `Fixes #<number>`, or `Resolves #<number>` in the description. Pull requests
   without a linked issue will be closed.

Treat repository rules as syntax constraints, not as the writing-quality
standard. Write in plain, natural language. Use the repository's exact terms
and name concrete behavior and validation evidence. Cut filler, generic praise,
formulaic transitions, and vague claims.

#### Title

Write a concise, human-readable title that describes the meaningful outcome.
Follow the repository's Conventional Commit style, but do not copy vague or
implementation-focused titles from its history.

**Bad:** `feat(core): add child run traversal and parent event aggregation`

**Good:** `feat(core): workflows can now include a child workflow in the parent run`

#### Description

Preserve the pull request template's structure and fill every applicable section
with concrete information from the issue, diff, commits, and validation
evidence. Lead with the problem and outcome, not an implementation inventory.

### Changelog entries

Writing a hand-written entry under `[Unreleased]` in `CHANGELOG.md` is optional.
At release time, the release skill keeps their substance, drafts entries
for merged PRs they do not cover, and removes duplicates.

## Code style

- Follow [`AGENTS.md`](./AGENTS.md) and
  [`.archon/engineering.md`](./.archon/engineering.md).
- TypeScript strict mode is enforced.
- All functions require explicit return types.
- Do not use `any` without justification.
- Follow existing patterns in the codebase.

Before proposing a major feature, read
[`.archon/direction.md`](./.archon/direction.md). Pull requests that conflict
with the documented product direction will be closed.

## Architecture

See [AGENTS.md](./AGENTS.md) for detailed architecture documentation.

## Sharing workflows

Publish a workflow pack from your own GitHub repository: add an `archon-plugin.json` with `"kind": "workflow-pack"` and users install it with `archon plugin install owner/repo[/path][@tag]`. The layout and manifest are described in the [installed workflow packs guide](https://archon.diy/guides/global-workflows/#installed-workflow-packs).


## Questions?

Open an [issue](https://github.com/coleam00/Archon/issues) or start a [discussion](https://github.com/coleam00/Archon/discussions).
