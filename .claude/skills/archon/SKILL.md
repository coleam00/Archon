---
name: archon
description: |
  Use when: User wants to run Archon workflows, create workflows or commands, set up Archon, or change Archon configuration.
  Triggers (run): "use archon to", "run archon", "archon workflow", "have archon", "ask archon to".
  Triggers (create): "create a workflow", "new workflow", "author a workflow", "make a command", "new command".
  Triggers (setup/init): "set up archon", "archon setup", "install archon", "initialize archon", "archon init", "add archon to repo".
  Triggers (config): "archon config", "change archon config", "edit archon config", "archon configuration".
  Capability: Runs AI workflows in isolated git worktrees for parallel development. Also manages workflow YAML files, command files, and configuration.
  NOT for: Direct Claude Code work, only for delegating tasks to the Archon CLI.
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
| **Quick parameter lookup — which field works on which node type** | Read `references/parameter-matrix.md` — master matrix, intent-based lookup, silent-failure catalog |
| **Advanced features (hooks/MCP/skills)** | Read `references/dag-advanced.md` |
| **Create a command file** | Read `references/authoring-commands.md` |
| **Variable substitution reference** | Read `references/variables.md` |
| **CLI command reference** | Read `references/cli-commands.md` |
| **Run an interactive workflow** | Read `references/interactive-workflows.md` — transparent relay protocol |
| **Workflow good practices / anti-patterns** | Read `references/good-practices.md` — read before designing a non-trivial workflow |
| **Troubleshoot a failing / stuck workflow** | Read `references/troubleshooting.md` — log locations, common failure modes |
| **Run a workflow (default)** | Continue with "Running Workflows" below |

If the intent is ambiguous, ask the user to clarify.

---

## Richer Context: [archon.diy](https://archon.diy)

The references in this skill are a distilled subset. The full, canonical docs live at **[archon.diy](https://archon.diy)** (Starlight site from `packages/docs-web/`). If the skill's reference pages don't cover what you need — an edge case, a worked example, a diagram, a deeper section on a feature — fetch the matching page from archon.diy.

### When to reach for the live docs

- You need an end-to-end example that's longer than what the skill shows (e.g. full patterns for hooks, MCP config, sandbox schema, approval flows)
- You're explaining a concept to the user and want the most readable framing (the `book/` series is written as a tutorial, not a reference)
- You hit a feature the skill only mentions in passing (e.g. `agents:` inline sub-agents, advanced Codex options, the full SyncHookJSONOutput schema)
- The user asks "where is this documented?" — point them at the archon.diy URL, not a skill file path

### URL map

| Topic | URL |
|-------|-----|
| Landing + install | [archon.diy](https://archon.diy) |
| Getting started (installation, quick start, concepts) | [archon.diy/getting-started/](https://archon.diy/getting-started/overview/) |
| The book (tutorial-style walkthrough) | [archon.diy/book/](https://archon.diy/book/) |
| Workflow authoring guide | [archon.diy/guides/authoring-workflows/](https://archon.diy/guides/authoring-workflows/) |
| Command authoring guide | [archon.diy/guides/authoring-commands/](https://archon.diy/guides/authoring-commands/) |
| Node type guides | [archon.diy/guides/loop-nodes/](https://archon.diy/guides/loop-nodes/), [/approval-nodes/](https://archon.diy/guides/approval-nodes/), [/script-nodes/](https://archon.diy/guides/script-nodes/) |
| Per-node features (Claude only) | [/hooks/](https://archon.diy/guides/hooks/), [/mcp-servers/](https://archon.diy/guides/mcp-servers/), [/skills/](https://archon.diy/guides/skills/) |
| Global workflows/commands/scripts | [archon.diy/guides/global-workflows/](https://archon.diy/guides/global-workflows/) |
| Variables reference | [archon.diy/reference/variables/](https://archon.diy/reference/variables/) |
| CLI reference | [archon.diy/reference/cli/](https://archon.diy/reference/cli/) |
| Security model (env, sandbox, target-repo `.env` stripping) | [archon.diy/reference/security/](https://archon.diy/reference/security/) |
| Architecture | [archon.diy/reference/architecture/](https://archon.diy/reference/architecture/) |
| Configuration (`.archon/config.yaml` full schema) | [archon.diy/reference/configuration/](https://archon.diy/reference/configuration/) |
| Troubleshooting | [archon.diy/reference/troubleshooting/](https://archon.diy/reference/troubleshooting/) |
| Adapter setup (Slack/Telegram/GitHub/Web/Discord/Gitea/GitLab) | [archon.diy/adapters/](https://archon.diy/adapters/) |
| Deployment (Docker, cloud, Windows) | [archon.diy/deployment/](https://archon.diy/deployment/) |

URL shape is `archon.diy/<section>/<page>/` — the paths mirror the filenames under `packages/docs-web/src/content/docs/`.

### Precedence

This skill's reference pages are the primary source for routine workflow authoring, CLI use, and setup. Reach for archon.diy when the skill is incomplete for your case — don't go to the live docs first by default (skill refs load into context faster and are tuned for agents).

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

**Approval node** — pauses the workflow for human review. Requires `interactive: true` at the workflow level for Web UI delivery:
```yaml
interactive: true   # workflow level — required for web UI

nodes:
  - id: review-gate
    approval:
      message: "Review the plan above before proceeding."
      capture_response: true      # Optional: user's comment → $review-gate.output
      on_reject:                  # Optional: AI rework on rejection instead of cancel
        prompt: "Revise based on feedback: $REJECTION_REASON"
        max_attempts: 3           # Range 1-10, default 3
    depends_on: [plan]
```

**Cancel node** — terminates the workflow with a reason. Typically gated with `when:`:
```yaml
- id: stop-if-unsafe
  cancel: "Refusing to proceed: input flagged UNSAFE."
  depends_on: [classify]
  when: "$classify.output != 'SAFE'"
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
