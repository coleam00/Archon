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

CI is the full validation gate. While working, choose checks for the files and packages
you changed: package `type-check` and `test` scripts, `bun run lint`,
or `bun run test <path>` for root scripts. Keep package tests isolated through their runners.

Optional `bun run validate` runs `cli-import-boundary`, `package-edges`,
`generated-files`, `type-check`, `lint`, `ratchet`, `format`, `installer` (POSIX only),
`package-tests`, `cli-tests`, `core-tests`, and `script-tests`.
The generated group checks the Pi vendor map, the capability matrix, the merge sweep contract,
provider and chat contract schemas, and API types. Tests default to 20 seconds on every
platform. Lint runs Biome (`biome.jsonc`) after TypeScript-API checks for test-cleanup
drift, the workflow persistence boundary, and SDK type restatements. Install the Biome
extension for in-editor lint and formatting; disable Prettier for this repository.
Formatting uses two spaces, single quotes, semicolons, a 100-column width, and LF line
endings on every OS. On Windows, `bun run format` converts CRLF working files to LF;
Git still normalizes text through the existing `.gitattributes`. `.archon/**` remains
excluded from formatting while its TypeScript scripts remain linted. Markdown and HTML
are hand-formatted. After resolving conflicts in an in-flight PR, run `bun run format`.

The ratchet (`bun run check:ratchet`) lets code grow up to a ceiling and holds what is above
it, compared with the merge base with `origin/dev` (fetch it locally). A touched function is
refused when it ends above cognitive complexity 15 and scores higher than at the merge base. A
touched source file is refused when it ends above 800 lines and has more lines than at the
merge base. Test files have no line ceiling. It scores the TS/JS files
Biome lints. To land an increase above a ceiling on purpose, add a trailer to one of the
change's commits:
`Ratchet-Allow: <path>` for a file's length, `Ratchet-Allow: <path>:<function>` for a function,
using the names the failure prints.

The SDK check reads exported types from installed provider SDK declarations and scans
tracked and untracked TypeScript sources outside `packages/providers/`. Import SDK
types instead of declaring copies. Independent same-name types and necessary SDK-free
boundary copies belong in `scripts/sdk-type-exceptions.ts`, one named type per entry
with a reason. Boundary entries identify the SDK module and the required relationship:
matching declared fields, an SDK subset, or a local subset. Their conformance test is
`scripts/sdk-type-conformance.test.ts`, which generates TypeScript assertions importing
the exact named local declaration and SDK export from each entry. Comparisons compile
as implementation source; arbitrary proof files and keyed placeholder assertions are
not accepted. Removed collisions must lose their ledger entries; stale entries fail lint. The generated Codex protocol
is excluded with the provider package; `generate:codex-protocol` owns it.

```bash
bun run validate                            # optional local checks
bun run validate --only generated-files     # generated artifacts
bun run validate --only format              # formatting, also run by the staged-file hook
bun run validate --only workflow-fixtures   # when changing a workflow or its fixtures
bun run test --plan pack                    # when changing .archon/workflows or .archon/scripts
```

`scripts/validate.ts` owns the check commands and CI selects them by ID.
CI runs formatting and every default check on ready pull requests, except that a change
touching only prose or files no check reads skips the test, service and binary jobs.
`scripts/should-run-test-suite.ts` decides which files those are: Markdown and the docs site
count as prose unless `BUILD_INPUTS` or `isPackPrompt` names them (pack `commands/` and
`.shared/` documents). `BUILD_INPUTS` is the authoritative list of other exceptions, including
Markdown read by tests, bundled skills, generated docs, and the docs manifest. A conformance test
requires every tracked Markdown path with a directory named in a test file to run the suite,
even when the mention is only in a comment. Bare filenames such as `README.md` are excluded.
`INERT_PATHS`
lists the non-prose files no check reads. On a pull request, `workspaceTestInputs` in the same
file decides whether the `cli` and `packages` legs of the `test` job run: a change limited to
root `scripts/` files that no package test or CI entry point reads skips them, the
`test-scripts` job still runs, and the `test-suite` check accepts the skip because the gate
said so. A push to `dev` or `main` skips those jobs only when
a pull request run already passed every job on the same tree, and otherwise runs them, so a
prose change's test-visible effects are checked on `dev`.

CI does not run the tests under `.archon/scripts/` (the SDLC pack's script tests) or the
workflow fixtures on pull requests or pushes. Run them with `bun run test --plan pack` and
`bun run validate --only workflow-fixtures` when you change `.archon/workflows/` or
`.archon/scripts/`; a single test file runs with
`bun run test .archon/scripts/__tests__/<file>.test.ts`. To run them in CI, dispatch the
Test Suite workflow with `pack-tests` or `pack-fixtures` set:
`gh workflow run test.yml --ref <branch> -f pack-tests=true -f pack-fixtures=true`.

Local validation has no fixed duration: tests and typed analysis dominate, and machine
load matters. The audit for [#3985](https://github.com/coleam00/Archon/issues/3985)
estimated the previous total at about 25 minutes under load, including fixtures and
formatting. Workflow fixtures require explicit selection; formatting runs by default.
Each validate run prints its actual elapsed time per check. A local success does not predict service, build,
or other-platform CI results.

**Important:** Use `bun run test` (not `bun test` from the repo root) to avoid mock pollution across packages.

**macOS:** tests that compile a fresh binary with `bun build --compile` skip on macOS and print a line saying so. Running them locally has preceded a stuck `syspolicyd` that stalls every new process on the machine until a reboot. CI runs them on Linux and Windows. Do not compile binaries locally on macOS. A new test that compiles a binary gates itself on `skipCompiledBinaryTests()` from `@archon/paths/test-utils`. One exception: the file-store lock tests compile their probe only under GitHub Actions, on every OS, and skip it everywhere else whatever `ARCHON_TEST_COMPILED_BINARIES` says. The `file-store-primitives-macos` job runs the file-store group and database-free CLI lifecycle on a disposable Mac so the persistence behavior and compiled probe are also proved on macOS.

#### What `bun run validate` deliberately leaves out

These additional PR-gating jobs need services or build environments a contributor may
not have. Run applicable service checks only against scratch databases you create and
drop; never run destructive verification against a configured live database.

| CI job | Needs | Run it yourself |
| --- | --- | --- |
| `schema-upgrade` | a live PostgreSQL; the SQLite half also reads every release tag | `bun run check:schema-upgrades` (`PGHOST`/`PGUSER`/… or `DATABASE_URL`) and `bun run check:sqlite-vintages` |
| `postgres-parity` | a PostgreSQL service; conformance creates and drops scratch databases and requires `CREATE DATABASE` permission | `ARCHON_TEST_PG_URL=postgres://… bun test packages/core/src/db/isolation-environments.live-run.postgres.integration.test.ts`, then the same for `packages/core/src/db/resource-slots.postgres.integration.test.ts`, `packages/core/src/db/provider-attempts.postgres.integration.test.ts`, `packages/core/src/db/workflows.postgres.integration.test.ts`, `packages/core/src/db/workflow-events.provider-events.postgres.integration.test.ts`, `packages/core/src/db/workflow-store.conformance.postgres.integration.test.ts`, `packages/core/src/db/state-documents.postgres.integration.test.ts`, and `packages/core/src/db/codebase-rename.postgres.integration.test.ts`; then `ARCHON_TEST_PG_URL=postgres://… bun run --cwd packages/core test src/db/users.postgres.integration.test.ts` and `ARCHON_TEST_PG_URL=postgres://… bun run --cwd packages/core test src/db/codebase-delete.postgres.integration.test.ts` |
| `docker-build` | a Docker daemon, and ~14GB of free disk for the image | `docker build .` |
| Linux `test` Slack conformance and smoke | compiled Slack plugin with a stubbed client for conformance, and the unmodified release binary for initialization and missing-token smoke | CI only; source conformance runs in `cd packages/chat-slack && bun run test` |
| `serve-binary` | compiled CLI and server artifacts; CI runs the build and smoke on Linux and Windows | CI only; no local compilation on macOS |
| `docs-build` | Node (Astro's CLI does not run under Bun); path-filtered to `packages/docs-web/` | `bun run build:docs` — run it when you change the docs site |
| `file-store-primitives-macos` | GitHub Actions for the compiled probe, and a macOS runner for filesystem behavior; ordinary tests also run under `validate` | `bun run --cwd packages/workflows test src/file-store` and `bun run --cwd packages/cli test src/commands/workflow-file-store.integration.spec.ts`; the compiled probe skips locally |

The `serve-binary` CI job builds matching CLI and server executables on Linux and
Windows, then checks `archon serve` against `/api/health` and the console. The
release workflow runs the same smoke with its release artifacts. These compiled
checks, and the server-free bundle assertion (including a restored-import
negative proof), run in CI. Local `check:cli-import-boundary` still checks startup
and policy import boundaries. Do not compile these binaries locally on macOS.

**Schema changes**: run `bun run check:schema-upgrades` and `bun run check:sqlite-vintages`
yourself if you touched `migrations/000_combined.sql`. A statement that applies cleanly to a fresh install can
abort the whole apply on an upgrade, and nothing before that job catches it.

**SDLC workflows**: We do not accept pull requests from outside contributors
that change `.archon/workflows/sdlc/`. Open an issue instead and describe the
problem or change you want the maintainers to consider. Maintainers change the
pack through pull requests that deliver an accepted issue.

### Publishing the container image

The `Publish` workflow checks provenance and SBOM attestations on the pushed image
digest. Keep `provenance: mode=max` and `sbom: true` enabled.
Build arguments are published in the attestation; secrets must use `secrets:`, whose values are excluded.
See [Verify image attestations](packages/docs-web/src/content/docs/deployment/docker.md#verify-image-attestations)
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
- Use inferred types where they are clear; annotate boundaries when needed to express a meaningful contract.
- Do not use `any` without justification.
- Follow existing patterns in the codebase.

Before proposing a major feature, read
[`.archon/direction.md`](./.archon/direction.md). Pull requests that conflict
with the documented product direction will be closed.

## Architecture

See [`.archon/architecture.md`](./.archon/architecture.md) for the package map, main flows, extension points and enforced boundaries.

## Sharing workflows

Publish a workflow pack from your own GitHub repository: add an `archon-plugin.json` with `"kind": "workflow-pack"` and users install it with `archon plugin add owner/repo[/path][@tag]`. The layout and manifest are described in the [installed workflow packs guide](https://archon.diy/guides/global-workflows/#installed-workflow-packs).


## Questions?

Open an [issue](https://github.com/coleam00/Archon/issues) or start a [discussion](https://github.com/coleam00/Archon/discussions).
