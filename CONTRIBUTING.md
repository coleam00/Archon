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

## Questions?

Open an [issue](https://github.com/coleam00/Archon/issues) or start a [discussion](https://github.com/coleam00/Archon/discussions).
