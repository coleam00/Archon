---
name: archon
description: |
  Use when: User wants to run Archon workflows, CREATE workflows or commands,
  set up Archon, or manage Archon configuration.
  Triggers (run): "use archon to", "run archon", "archon workflow", "use archon for",
            "have archon", "let archon", "ask archon to".
  Triggers (create): "create a workflow", "write a workflow", "make a command",
            "author a workflow", "new workflow", "new command", "archon workflow yaml".
  Triggers (setup): "set up archon", "install archon", "how to use archon",
            "configure archon", "archon setup", "get started with archon".
  Triggers (config): "change my archon config", "modify archon config", "archon config",
            "change archon settings", "update my config", "help me change my config",
            "edit archon config", "archon configuration".
  Triggers (init): "initialize archon", "set up .archon", "archon init", "add archon to repo".
  Capability: Runs AI workflows in isolated git worktrees for parallel development.
  Also: Creates and manages workflow YAML files, command files, and configuration.
  NOT for: Direct Claude Code work - only for delegating to Archon CLI.
argument-hint: "[workflow] [message or issue number]"
---

# Archon CLI Skill

Archon is a remote agentic coding platform that runs AI workflows in isolated git worktrees. This skill teaches you how to run workflows, create new workflows and commands, and manage Archon configuration.

## Available Workflows (live)

!`archon workflow list 2>&1 || echo "Archon CLI not installed. Read guides/setup.md to set it up."`

## Routing

Determine the user's intent and dispatch to the appropriate guide:

| Intent | Action |
|--------|--------|
| **Setup / install / "how to use"** | Read `guides/setup.md` — interactive setup wizard |
| **Config / settings** | Read `guides/config.md` — interactive config editor |
| **Initialize .archon/ in a repo** | Read `references/repo-init.md` |
| **Create a workflow** | Read `references/workflow-dag.md` — the complete workflow authoring guide |
| **Advanced features (hooks/MCP/skills)** | Read `references/dag-advanced.md` |
| **Create a command file** | Read `references/authoring-commands.md` |
| **Variable substitution reference** | Read `references/variables.md` |
| **CLI command reference** | Read `references/cli-commands.md` |
| **Run an interactive workflow** | Read `references/interactive-workflows.md` — transparent relay protocol |
| **Run a workflow (default)** | Continue with "Running Workflows" below |

If the intent is ambiguous, ask the user to clarify.

---

## Running Workflows

### Core Command

```bash
archon workflow run <workflow-name> --branch <branch-name> "<message>"
```

**CRITICAL RULES**:

1. **Always run in background** — Archon workflows are long-running. Always invoke the Bash tool with `run_in_background: true`. Use `/tasks` or the TaskOutput tool to check on progress.

2. **Always use worktree isolation** — Use the `--branch` flag unless the user explicitly requests otherwise. This creates an isolated environment so Archon works without affecting the main branch.

3. **One workflow per shell** — Each workflow blocks its shell. Run multiple workflows as separate background tasks.

### Isolation Modes

| Mode | Flag | When to Use |
|------|------|-------------|
| **Worktree (Default)** | `--branch <name>` | Always use this unless told otherwise |
| **Custom start-point** | `--branch <name> --from <base>` | Start from a specific branch |
| **Direct checkout** | `--no-worktree` | Only if user explicitly requests no isolation |
| **Resume failed run** | `--resume` | Resume from the last failure point |

### Workflow Selection

Match the user's intent to a workflow from the live list above. Common patterns:

| User Intent | Typical Workflow | Branch Pattern |
|-------------|-----------------|----------------|
| "Fix issue #X" / "Resolve bug" | `archon-fix-github-issue` | `fix/issue-{N}` |
| "Review PR #X" / "Full review" | `archon-comprehensive-pr-review` | `review/pr-{N}` |
| "Quick review PR #X" | `archon-smart-pr-review` | `review/pr-{N}` |
| "Validate PR #X" / "Check PR" | `archon-validate-pr` | `review/pr-{N}` |
| "Implement from plan" | `archon-feature-development` | `feat/{name}` |
| "Plan and implement feature" | `archon-idea-to-pr` | `feat/{name}` |
| "Execute plan file" | `archon-plan-to-pr` | `feat/{name}` |
| "Run ralph" / "Implement PRD" | `archon-ralph-dag` | `feat/{name}` |
| "Resolve conflicts" | `archon-resolve-conflicts` | `resolve/pr-{N}` |
| "Create issue" / "File a bug" | `archon-create-issue` | `issue/{name}` |
| "Review issue #X fully" | `archon-issue-review-full` | `review/issue-{N}` |
| "Refactor safely" | `archon-refactor-safely` | `refactor/{name}` |
| "Architecture review" | `archon-architect` | `review/{name}` |
| "PIV loop" / "guided dev" | `archon-piv-loop` ⚡ | `piv/{name}` |
| "Create a PRD" / "interactive PRD" | `archon-interactive-prd` ⚡ | `prd/{name}` |
| General / debugging | `archon-assist` | `assist/{description}` |

⚡ = **Interactive workflow** — requires the transparent relay protocol. Read `references/interactive-workflows.md` before running.

If no specific workflow matches, use `archon-assist` as the fallback. The live workflow list above is always authoritative — it may include workflows not in this table.

### Multi-Issue Invocation

When the user mentions multiple issues, PRs, or tasks — run each as a **separate background task**:

```bash
# Each gets its own worktree — they won't conflict
archon workflow run archon-fix-github-issue --branch fix/issue-10 "Fix issue #10"
archon workflow run archon-fix-github-issue --branch fix/issue-11 "Fix issue #11"
archon workflow run archon-fix-github-issue --branch fix/issue-12 "Fix issue #12"
```

Never combine multiple issues into a single command.

---

## Other CLI Commands

```bash
archon workflow list              # List all available workflows
archon workflow list --json       # Machine-readable JSON
archon isolation list             # Show active worktree environments
archon isolation cleanup          # Remove stale worktrees (default: 7 days)
archon isolation cleanup --merged # Remove branches merged into main
archon complete <branch>          # Complete branch lifecycle (remove worktree + branches)
archon version                    # Show version info
```

For the full CLI reference with all flags: Read `references/cli-commands.md`

---

## Authoring Quick Start

Archon uses a single workflow format: **nodes** (DAG). Workflows are YAML files in `.archon/workflows/`.

**IMPORTANT**: The examples below are starting points. Always design the workflow around what the user actually needs — the number of nodes, their types, dependencies, and configuration should match the user's requirements, not these templates.

### Workflow Structure

```yaml
name: my-workflow
description: What this workflow does
provider: claude          # Optional: 'claude' or 'codex'
model: sonnet             # Optional: model override
nodes:
  - id: first-node
    command: my-command    # Loads .archon/commands/my-command.md
  - id: second-node
    prompt: "Use the output: $first-node.output"
    depends_on: [first-node]
```

### Node Types

Each node has exactly ONE of: `command`, `prompt`, `bash`, `script`, `loop`, `approval`, or `cancel`.

**Command node** — runs a `.archon/commands/*.md` file:
```yaml
- id: investigate
  command: investigate-issue
```

**Prompt node** — inline AI prompt:
```yaml
- id: classify
  prompt: "Classify this issue: $ARGUMENTS"
  model: haiku
  allowed_tools: []
```

**Bash node** — shell script, no AI, stdout captured as output:
```yaml
- id: fetch-data
  bash: "gh issue view 42 --json title,body"
  timeout: 15000
```

**Script node** — TypeScript/JavaScript (via `bun`) or Python (via `uv`), no AI, stdout captured as output:
```yaml
- id: transform
  script: |
    const raw = process.argv.slice(2).join(' ') || '{}';
    console.log(JSON.stringify({ parsed: JSON.parse(raw) }));
  runtime: bun           # 'bun' (.ts/.js) or 'uv' (.py) — REQUIRED
  timeout: 30000         # Optional, ms, default 120000

# Or reference a named script from .archon/scripts/ or ~/.archon/scripts/
- id: analyze
  script: analyze-metrics   # loads .archon/scripts/analyze-metrics.py
  runtime: uv
  deps: ["pandas>=2.0"]     # Optional, uv only — 'uv run --with <dep>'
```

**Loop node** — iterates AI prompt until completion:
```yaml
- id: implement
  loop:
    prompt: "Implement next story. When done: <promise>COMPLETE</promise>"
    until: COMPLETE
    max_iterations: 10
    fresh_context: true
    until_bash: "bun run test"    # Optional: exit 0 = done
```

For the full authoring guide with all fields, conditions, trigger rules, and patterns: Read `references/workflow-dag.md`

### Creating a Command File

Commands are `.md` files in `.archon/commands/` containing AI prompt templates:

```markdown
---
description: What this command does
argument-hint: <expected arguments>
---

# My Command

User request: $ARGUMENTS
Workflow artifacts: $ARTIFACTS_DIR

[Instructions for the AI agent]
```

For the full command authoring guide: Read `references/authoring-commands.md`

### Key Variables

| Variable | Description |
|----------|-------------|
| `$ARGUMENTS` | User's input message |
| `$ARTIFACTS_DIR` | Pre-created directory for workflow artifacts |
| `$BASE_BRANCH` | Base branch (auto-detected from git) |
| `$WORKFLOW_ID` | Unique workflow run ID |
| `$nodeId.output` | Output from upstream node |

Full variable reference: Read `references/variables.md`

### Advanced Features (Command/Prompt Nodes, Claude Only)

`hooks` (tool interception), `mcp` (external tool servers), `skills` (domain knowledge injection), `output_format` (structured JSON output), `allowed_tools`/`denied_tools` (tool restrictions).

For details: Read `references/dag-advanced.md`

### Example Files

- `examples/dag-workflow.yaml` — workflow with conditions, bash + script + loop nodes, structured output
- `examples/command-template.md` — Command file skeleton with all variables

---

## Example Interactions

**User**: "Use Archon to fix issue #42"
```bash
archon workflow run archon-fix-github-issue --branch fix/issue-42 "Fix issue #42"
```

**User**: "Have Archon review PR #15"
```bash
archon workflow run archon-comprehensive-pr-review --branch review/pr-15 "Review PR #15"
```

**User**: "Create a workflow that reviews code and runs tests"
→ Read `references/workflow-dag.md` and create a workflow with parallel review nodes.

**User**: "Make a workflow with conditional routing"
→ Read `references/workflow-dag.md` and create nodes with `when:` conditions and `output_format`.

**User**: "Write a command file for investigating bugs"
→ Read `references/authoring-commands.md` and create an `.md` file in `.archon/commands/`.

**User**: "Set up Archon in this repo"
→ Read `references/repo-init.md` to create the `.archon/` directory structure.

**User**: "Initialize .archon and create a custom workflow"
→ First read `references/repo-init.md`, then the appropriate workflow reference.
