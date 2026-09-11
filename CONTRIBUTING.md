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

`bun run validate` is the gate. Run it before opening a pull request: it runs every
check that gates a pull request except the four listed below, so a green run means CI's
`test` and `workflow-fixtures` jobs will pass. It needs no network and no
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

#### What `bun run validate` deliberately leaves out

These PR-gating jobs need something a contributor may not have, so they stay in CI only.
If you touched what they cover, run them yourself.

| CI job | Needs | Run it yourself |
| --- | --- | --- |
| `schema-upgrade` | a live PostgreSQL; the SQLite half also reads every release tag | `bun run check:schema-upgrades` (`PGHOST`/`PGUSER`/… or `DATABASE_URL`) and `bun run check:sqlite-vintages` |
| `postgres-parity` | a live PostgreSQL | `ARCHON_TEST_PG_URL=postgres://… bun test packages/core/src/db/isolation-environments.live-run.postgres.integration.test.ts` |
| `docker-build` | a Docker daemon, and ~14GB of free disk for the image | `docker build .` |
| `docs-build` | Node (Astro's CLI does not run under Bun); path-filtered to `packages/docs-web/` | `bun run build:docs` — run it when you change the docs site |
| `marketplace-lint` | 9 unauthenticated github.com API calls against a 60/hour per-IP quota, which seven `validate` runs an hour would exhaust | `bun packages/docs-web/scripts/lint-marketplace.ts` — run it when you change `packages/docs-web/src/data/marketplace.ts` |

**Schema changes**: run `bun run check:schema-upgrades` and `bun run check:sqlite-vintages`
yourself if you touched `migrations/000_combined.sql`. A statement that applies cleanly to a fresh install can
abort the whole apply on an upgrade, and nothing before that job catches it.

`scripts/validate-ci-parity.test.ts` holds the same exclusions as a machine-checked list,
so another PR-gating command cannot appear without a deliberate decision to leave it out.

**SDLC workflows**: We do not accept pull requests that change
`.archon/workflows/sdlc/`. Open an issue instead and describe the problem or
change you want the maintainers to consider.

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

## Contributing Workflows to the Marketplace

Share your Archon workflows with the community by adding an entry to the marketplace registry at [`packages/docs-web/src/data/marketplace.ts`](packages/docs-web/src/data/marketplace.ts).

### How to Submit

1. Keep your workflow in a **public GitHub repository** — either as a single YAML file or a directory
2. Pin it to a specific commit SHA (ensures immutability after merge)
3. Fork Archon and add an entry to `packages/docs-web/src/data/marketplace.ts`
4. Open a PR — automated lint validates your entry before review

### Submission Formats

**Single-file workflow** — a standalone `.yaml` file:

```
sourceUrl: "https://github.com/you/repo/blob/main/my-workflow.yaml"
```

**Directory workflow** — a folder containing the workflow YAML plus supporting commands, scripts, or skills:

```
sourceUrl: "https://github.com/you/repo/tree/main/my-workflow/"
```

Directory structure convention:

```
my-workflow/
├── README.md          # Describe what the workflow does and any prereqs a user needs to run it
├── my-workflow.yaml   # Main workflow (must match slug or be the only .yaml)
├── commands/          # → installed to .archon/commands/
│   └── helper.md
├── scripts/           # → installed to .archon/scripts/
│   └── analyze.ts
└── skills/            # → installed to .archon/skills/
    └── my-skill/
```

Use a directory when your workflow references custom commands, scripts, or other resources that users need locally.

### Entry Requirements

| Field | Requirement |
|-------|-------------|
| `slug` | Lowercase, hyphens only (e.g. `my-review-workflow`) — must be unique |
| `name` | Human-readable display name |
| `author` | Your GitHub username |
| `description` | 1–3 sentences: what it does and when to use it |
| `sourceUrl` | GitHub blob URL (single file) or tree URL (directory) |
| `sha` | Full 40-character commit SHA pinning the exact version |
| `tags` | At least one from: `development`, `review`, `automation`, `planning` |
| `archonVersionCompat` | Semver range (e.g. `>=0.3.0`) |

### Self-Attestation

By submitting, you attest that:

- [ ] The workflow does not exfiltrate data, credentials, or secrets
- [ ] The workflow does not execute destructive operations without user confirmation
- [ ] You have the right to share this workflow publicly
- [ ] The pinned SHA points to a reviewed, stable version of your workflow

## Questions?

Open an [issue](https://github.com/coleam00/Archon/issues) or start a [discussion](https://github.com/coleam00/Archon/discussions).
