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

Before submitting a PR, ensure:

```bash
bun run check:bundled  # Bundled defaults are up to date (see note below)
bun run type-check     # TypeScript types
bun run lint           # ESLint
bun run format         # Prettier
bun run test           # All tests (per-package isolation)

# Or run the full validation suite:
bun run validate
```

**Bundled defaults**: If you added, removed, or edited a file under
`.archon/commands/defaults/` or `.archon/workflows/defaults/`, run
`bun run generate:bundled` to refresh the embedded bundle before committing.

**Important:** Use `bun run test` (not `bun test` from the repo root) to avoid mock pollution across packages.

### Commit Messages

- Use present tense ("Add feature" not "Added feature")
- Keep the first line under 72 characters
- Reference issues when applicable

### Pull Requests

1. Create a feature branch from `dev`
2. Make your changes
3. Ensure all checks pass
4. Submit a PR using the template at [`.github/PULL_REQUEST_TEMPLATE.md`](./.github/PULL_REQUEST_TEMPLATE.md). GitHub fills it in automatically when you open a PR through the web UI. If you use `gh pr create`, copy the template into the body — leaving it empty or partially filled slows review.
5. Link the issue your PR addresses with `Closes #<number>` (or `Fixes #<number>` / `Resolves #<number>`) in the description so it auto-closes on merge.

## Code Style

- TypeScript strict mode is enforced
- All functions require explicit return types
- No `any` types without justification
- Follow existing patterns in the codebase

## Architecture

See [CLAUDE.md](./CLAUDE.md) for detailed architecture documentation.

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
