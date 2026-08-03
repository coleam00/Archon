# Authoring Command Files

Commands are plain Markdown files containing AI prompt templates. They are the atomic unit of AI instruction — each command file defines what a single AI agent does in one step of a workflow.

## File Location

Commands are discovered from three scopes, highest-precedence first:

```
<repoRoot>/.archon/commands/     # 1. Repo-scoped (wins)
├── my-command.md                #    Custom command for this repo
├── archon-assist.md             #    Overrides the bundled archon-assist
└── triage/                      #    Subfolders allowed, 1 level deep
    └── review.md                #    Resolves as 'review', not 'triage/review'

~/.archon/commands/              # 2. Home-scoped (user-level, shared across all repos)
├── review-checklist.md          #    Personal helper available in every repo
└── pr-style-guide.md

<bundled defaults>                # 3. Shipped with Archon (archon-assist, etc.)
```

**Resolution rules:**

- Filename-without-extension is the command name (e.g. `my-command.md` → `my-command`).
- 1-level subfolders are supported for grouping; resolution is still by filename (`triage/review.md` → `review`).
- Repo scope overrides home scope overrides bundled, by name.
- Duplicate basenames **within a scope** (e.g. two different `review.md` files in `triage/` and `security/`) are a user error — keep names unique within each scope.

Commands are referenced by name (without `.md`) in workflow YAML files.

## File Format

```markdown
---
description: One-line description of what this command does
argument-hint: <issue-number> or (no arguments)
---

# Command Title

**Workflow ID**: $WORKFLOW_ID

---

## Phase 1: LOAD

[Instructions for gathering context]

## Phase 2: EXECUTE

[Instructions for doing the work]

## Phase 3: GENERATE

[Instructions for writing artifacts]

### PHASE_3_CHECKPOINT
- [ ] Artifact written to `$ARTIFACTS_DIR/output.md`
- [ ] Summary prepared

## Phase 4: REPORT

[Instructions for the final output message]
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `description` | Recommended | Human-readable description (shown in listings) |
| `argument-hint` | Optional | Expected arguments hint (e.g., `<issue-number>`, `(no arguments)`) |

The frontmatter is metadata for discovery. The entire file content (including frontmatter) becomes the prompt sent to the AI.

## Variable Substitution

Variables are replaced at execution time. See `references/variables.md` for the complete list.

Most commonly used:
- `$ARGUMENTS` — the user's input message
- `$ARTIFACTS_DIR` — write artifacts here (pre-created directory)
- `$WORKFLOW_ID` — for tracking
- `$BASE_BRANCH` — for git operations

## Name Validation Rules

Command names must:
- Not contain `/`, `\`, or `..`
- Not start with `.`
- Not be empty

## Discovery and Priority

When a workflow references `command: my-command`, Archon searches in this order:

1. `<repoRoot>/.archon/commands/my-command.md` (repo scope)
2. `~/.archon/commands/my-command.md` (home scope — shared across every repo on the machine)
3. Bundled defaults (shipped with Archon)

First match wins. To override a bundled command, drop a file with the same name at either scope. To override a home-scoped command for a specific repo, drop a file with the same name in that repo's `.archon/commands/`.

> **Web UI note**: Home-scoped commands appear in the workflow builder's node palette under a dedicated "Global (~/.archon/commands/)" section, distinct from project and bundled entries.

## Referencing Commands from Workflows

In workflow YAML, use the `command:` field on a node:
```yaml
nodes:
  - id: review
    command: my-command       # Loads .archon/commands/my-command.md
    depends_on: [implement]
```

## Phase-Based Organization Pattern

The recommended structure for complex commands:

1. **LOAD** — Read inputs, gather context, load artifacts from previous steps
2. **EXPLORE/ANALYZE** — Research the codebase, understand the problem
3. **EXECUTE/GENERATE** — Do the work, write code, create artifacts
4. **VALIDATE** — Run tests, type-check, verify
5. **REPORT** — Summarize results for the user

Each phase should have a `PHASE_N_CHECKPOINT` with a checklist to keep the AI on track.

## Artifact Conventions

Artifacts are how steps communicate in multi-step workflows. Write outputs to `$ARTIFACTS_DIR/`:

| Convention | Purpose |
|------------|---------|
| `$ARTIFACTS_DIR/plan.md` | Implementation plan |
| `$ARTIFACTS_DIR/investigation.md` | Bug investigation results |
| `$ARTIFACTS_DIR/implementation.md` | Implementation summary |
| `$ARTIFACTS_DIR/validation.md` | Test/lint results |
| `$ARTIFACTS_DIR/pr-body.md` | PR description content |
| `$ARTIFACTS_DIR/.pr-number` | PR number (metadata) |
| `$ARTIFACTS_DIR/.pr-url` | PR URL (metadata) |
| `$ARTIFACTS_DIR/review/` | Review agent outputs (subdirectory) |

## Anti-Patterns

- **Vague instructions** — "Fix the code" is too vague. Be specific about what to investigate, which tools to use, what output to produce.
- **No artifact output** — If a command produces no artifacts, downstream steps have nothing to work from.
- **Assuming prior context** — When `context: fresh` is set on the calling node, the AI starts fresh. It must read artifacts explicitly.
- **Giant monolithic commands** — Split complex work into focused phases. Each command should have one clear responsibility.
- **Hardcoded paths** — Use `$ARTIFACTS_DIR` instead of hardcoded paths for portability.

## Simple Command Example

```markdown
---
description: General-purpose AI assistant
argument-hint: <any request>
---

You are a helpful coding assistant working on this project.

**Request**: $ARGUMENTS

Analyze the codebase and help the user with their request. Use Read, Grep, Glob, and Bash tools to explore the code. Provide clear, actionable answers.
```

## Complex Command Example

```markdown
---
description: Validate implementation against the plan
argument-hint: (no arguments - reads from workflow artifacts)
---

# Validate Implementation

**Workflow ID**: $WORKFLOW_ID

---

## Phase 1: LOAD

Read the plan context:
- Read `$ARTIFACTS_DIR/plan-context.md` for the implementation plan
- Read `$ARTIFACTS_DIR/implementation.md` for what was implemented

## Phase 2: VALIDATE

Run the full validation suite:

```bash
bun run type-check
bun run lint
bun run test
```

Record all failures with file paths and error messages.

### PHASE_2_CHECKPOINT
- [ ] Type-check results recorded
- [ ] Lint results recorded
- [ ] Test results recorded

## Phase 3: REPORT

Write validation results to `$ARTIFACTS_DIR/validation.md` with:
- Pass/fail status for each check
- Specific error details for failures
- Summary recommendation (proceed / needs fixes)
```
