<p align="center">
  <img src="assets/logo.png" alt="HarneesLab" width="160" />
</p>

<h1 align="center">HarneesLab</h1>

<p align="center">
  The first open-source harness builder for AI coding. Make AI coding deterministic and repeatable.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a>
  <a href="https://github.com/NewTurn2017/HarneesLab/actions/workflows/test.yml"><img src="https://github.com/NewTurn2017/HarneesLab/actions/workflows/test.yml/badge.svg" alt="CI" /></a>
  <a href="https://harneeslab.codewithgenie.com"><img src="https://img.shields.io/badge/docs-harneeslab.codewithgenie.com-blue" alt="Docs" /></a>
</p>

---

HarneesLab is a workflow engine for AI coding agents. Define your development processes as YAML workflows - planning, implementation, validation, code review, PR creation - and run them reliably across all your projects.

HarneesLab is the NewTurn2017 fork of Archon. It keeps upstream Archon workflow and CLI compatibility while giving the fork its own repository, release line, docs, and Korean-first product surface.

Like what Dockerfiles did for infrastructure and GitHub Actions did for CI/CD - HarneesLab does for AI coding workflows. Think n8n, but for software development.

## Why HarneesLab?

When you ask an AI agent to "fix this bug", what happens depends on the model's mood. It might skip planning. It might forget to run tests. It might write a PR description that ignores your template. Every run is different.

HarneesLab fixes this. Encode your development process as a workflow. The workflow defines the phases, validation gates, and artifacts. The AI fills in the intelligence at each step, but the structure is deterministic and owned by you.

- **Repeatable** - Same workflow, same sequence, every time. Plan, implement, validate, review, PR.
- **Isolated** - Every workflow run gets its own git worktree. Run 5 fixes in parallel with no conflicts.
- **Fire and forget** - Kick off a workflow, go do other work. Come back to a finished PR with review comments.
- **Composable** - Mix deterministic nodes (bash scripts, tests, git ops) with AI nodes (planning, code generation, review). The AI only runs where it adds value.
- **Portable** - Define workflows once in `.archon/workflows/`, commit them to your repo. They work the same from CLI, Web UI, Slack, Telegram, or GitHub.

## What It Looks Like

Here's an example of a HarneesLab workflow that plans, implements in a loop until tests pass, gets your approval, then creates the PR:

```yaml
# .archon/workflows/build-feature.yaml
nodes:
  - id: plan
    prompt: "Explore the codebase and create an implementation plan"

  - id: implement
    depends_on: [plan]
    loop:                                      # AI loop - iterate until done
      prompt: "Read the plan. Implement the next task. Run validation."
      until: ALL_TASKS_COMPLETE
      fresh_context: true                      # Fresh session each iteration

  - id: run-tests
    depends_on: [implement]
    bash: "bun run validate"                   # Deterministic - no AI

  - id: review
    depends_on: [run-tests]
    prompt: "Review all changes against the plan. Fix any issues."

  - id: approve
    depends_on: [review]
    loop:                                      # Human approval gate
      prompt: "Present the changes for review. Address any feedback."
      until: APPROVED
      interactive: true                        # Pauses and waits for human input

  - id: create-pr
    depends_on: [approve]
    prompt: "Push changes and create a pull request"
```

Tell your coding agent what you want, and HarneesLab handles the rest:

```
You: Use hlab to add dark mode to the settings page

Agent: I'll run the archon-idea-to-pr workflow for this.
       → Creating isolated worktree on branch hlab/task-dark-mode...
       → Planning...
       → Implementing (task 1/4)...
       → Implementing (task 2/4)...
       → Tests failing - iterating...
       → Tests passing after 2 iterations
       → Code review complete - 0 issues
       → PR ready: https://github.com/you/project/pull/47
```

## Previous Version

Looking for the original Python-based Archon (task management + RAG)? It's fully preserved on the [`archive/v1-task-management-rag`](https://github.com/coleam00/Archon/tree/archive/v1-task-management-rag) branch.

## Getting Started

> **Most users should start with the [Full Setup](#full-setup-5-minutes)** - it walks you through credentials, installs the HarneesLab skill into your projects, and gives you the web dashboard.
>
> **Already have Claude Code and just want the CLI?** Jump to the [Quick Install](#quick-install-30-seconds).

### Full Setup (5 minutes)

Clone the repo and use the guided setup wizard. This configures credentials, platform integrations, and copies the HarneesLab skill into your target projects.

<details>
<summary><b>Prerequisites</b> - Bun, Claude Code, and the GitHub CLI</summary>

**Bun** - [bun.sh](https://bun.sh)

```bash
# macOS/Linux
curl -fsSL https://bun.sh/install | bash

# Windows (PowerShell)
irm bun.sh/install.ps1 | iex
```

**GitHub CLI** - [cli.github.com](https://cli.github.com/)

```bash
# macOS
brew install gh

# Windows (via winget)
winget install GitHub.cli

# Linux (Debian/Ubuntu)
sudo apt install gh
```

**Claude Code** - [claude.ai/code](https://claude.ai/code)

```bash
# macOS/Linux/WSL
curl -fsSL https://claude.ai/install.sh | bash

# Windows (PowerShell)
irm https://claude.ai/install.ps1 | iex
```

</details>

```bash
git clone https://github.com/NewTurn2017/HarneesLab
cd HarneesLab
bun install
claude
```

Then say: **"Set up HarneesLab"**

The setup wizard walks you through everything: CLI installation, authentication, platform selection, and copies the HarneesLab skill to your target repo.

### Quick Install (30 seconds)

Already have Claude Code set up? Install the standalone CLI binary and skip the wizard.

**macOS / Linux**
```bash
curl -fsSL https://harneeslab.codewithgenie.com/install | bash
```

**Windows (PowerShell)**
```powershell
irm https://harneeslab.codewithgenie.com/install.ps1 | iex
```

**Homebrew**
```bash
brew install <tap>/hlab
```

> **Compiled binaries need a `CLAUDE_BIN_PATH`.** The quick-install binaries
> don't bundle Claude Code. Install it separately, then point HarneesLab at it:
>
> ```bash
> # macOS / Linux / WSL
> curl -fsSL https://claude.ai/install.sh | bash
> export CLAUDE_BIN_PATH="$HOME/.local/bin/claude"
>
> # Windows (PowerShell)
> irm https://claude.ai/install.ps1 | iex
> $env:CLAUDE_BIN_PATH = "$env:USERPROFILE\.local\bin\claude.exe"
> ```
>
> Or set `assistants.claude.claudeBinaryPath` in `~/.archon/config.yaml`.
> The Docker image ships Claude Code pre-installed. See [AI Assistants → Binary path configuration](https://harneeslab.codewithgenie.com/getting-started/ai-assistants/#binary-path-configuration-compiled-binaries-only) for details.

### Start Using HarneesLab

Once you've completed either setup path, go to your project and start working:

```bash
cd /path/to/your/project
claude
```

```
Use hlab to fix issue #42
```

```
What hlab workflows do I have? When would I use each one?
```

The coding agent handles workflow selection, branch naming, and worktree isolation for you. Projects are registered automatically the first time they're used.

> **Important:** Always run Claude Code from your target repo, not from the HarneesLab repo. The setup wizard copies the HarneesLab skill into your project so it works from there.

## Web UI

HarneesLab includes a web dashboard for chatting with your coding agent, running workflows, and monitoring activity. Binary installs: run `hlab serve` to download and start the web UI in one step. From source: ask your coding agent to run the frontend from the HarneesLab repo, or run `bun run dev` from the repo root yourself.

Register a project by clicking **+** next to "Project" in the chat sidebar - enter a GitHub URL or local path. Then start a conversation, invoke workflows, and watch progress in real time.

**Key pages:**
- **Chat** - Conversation interface with real-time streaming and tool call visualization
- **Dashboard** - Mission Control for monitoring running workflows, with filterable history by project, status, and date
- **Workflow Builder** - Visual drag-and-drop editor for creating DAG workflows with loop nodes
- **Workflow Execution** - Step-by-step progress view for any running or completed workflow

**Monitoring hub:** The sidebar shows conversations from **all platforms** - not just the web. Workflows kicked off from the CLI, messages from Slack or Telegram, GitHub issue interactions - everything appears in one place.

See the [Web UI Guide](https://harneeslab.codewithgenie.com/adapters/web/) for full documentation.

## What Can You Automate?

HarneesLab ships with workflows for common development tasks:

| Workflow | What it does |
|----------|-------------|
| `archon-assist` | General Q&A, debugging, exploration - full Claude Code agent with all tools |
| `archon-fix-github-issue` | Classify issue → investigate/plan → implement → validate → PR → smart review → self-fix |
| `archon-idea-to-pr` | Feature idea → plan → implement → validate → PR → 5 parallel reviews → self-fix |
| `archon-plan-to-pr` | Execute existing plan → implement → validate → PR → review → self-fix |
| `archon-issue-review-full` | Comprehensive fix + full multi-agent review pipeline for GitHub issues |
| `archon-smart-pr-review` | Classify PR complexity → run targeted review agents → synthesize findings |
| `archon-comprehensive-pr-review` | Multi-agent PR review (5 parallel reviewers) with automatic fixes |
| `archon-create-issue` | Classify problem → gather context → investigate → create GitHub issue |
| `archon-validate-pr` | Thorough PR validation testing both main and feature branches |
| `archon-resolve-conflicts` | Detect merge conflicts → analyze both sides → resolve → validate → commit |
| `archon-feature-development` | Implement feature from plan → validate → create PR |
| `archon-architect` | Architectural sweep, complexity reduction, codebase health improvement |
| `archon-refactor-safely` | Safe refactoring with type-check hooks and behavior verification |
| `archon-ralph-dag` | PRD implementation loop - iterate through stories until done |
| `archon-remotion-generate` | Generate or modify Remotion video compositions with AI |
| `archon-test-loop-dag` | Loop node test workflow - iterative counter until completion |
| `archon-piv-loop` | Guided Plan-Implement-Validate loop with human review between iterations |

HarneesLab ships 17 default workflows - run `hlab workflow list` or describe what you want and the router picks the right one.

**Or define your own.** Default workflows are great starting points - copy one from `.archon/workflows/defaults/` and customize it. Workflows are YAML files in `.archon/workflows/`, commands are markdown files in `.archon/commands/`. Same-named files in your repo override the bundled defaults. Commit them - your whole team runs the same process.

See [Authoring Workflows](https://harneeslab.codewithgenie.com/guides/authoring-workflows/) and [Authoring Commands](https://harneeslab.codewithgenie.com/guides/authoring-commands/).

## Add a Platform

The Web UI and CLI work out of the box. Optionally connect a chat platform for remote access:

| Platform | Setup time | Guide |
|----------|-----------|-------|
| **Telegram** | 5 min | [Telegram Guide](https://harneeslab.codewithgenie.com/adapters/telegram/) |
| **Slack** | 15 min | [Slack Guide](https://harneeslab.codewithgenie.com/adapters/slack/) |
| **GitHub Webhooks** | 15 min | [GitHub Guide](https://harneeslab.codewithgenie.com/adapters/github/) |
| **Discord** | 5 min | [Discord Guide](https://harneeslab.codewithgenie.com/adapters/community/discord/) |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Platform Adapters (Web UI, CLI, Telegram, Slack,       │
│                    Discord, GitHub)                      │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                     Orchestrator                        │
│          (Message Routing & Context Management)         │
└─────────────┬───────────────────────────┬───────────────┘
              │                           │
      ┌───────┴────────┐          ┌───────┴────────┐
      │                │          │                │
      ▼                ▼          ▼                ▼
┌───────────┐  ┌────────────┐  ┌──────────────────────────┐
│  Command  │  │  Workflow  │  │    AI Assistant Clients  │
│  Handler  │  │  Executor  │  │      (Claude / Codex)    │
│  (Slash)  │  │  (YAML)    │  │                          │
└───────────┘  └────────────┘  └──────────────────────────┘
      │              │                      │
      └──────────────┴──────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│              SQLite / PostgreSQL (7 Tables)             │
│   Codebases • Conversations • Sessions • Workflow Runs  │
│    Isolation Environments • Messages • Workflow Events  │
└─────────────────────────────────────────────────────────┘
```

## Documentation

Full documentation is available at **[harneeslab.codewithgenie.com](https://harneeslab.codewithgenie.com)**.

| Topic | Description |
|-------|-------------|
| [Getting Started](https://harneeslab.codewithgenie.com/getting-started/overview/) | Setup guide (Web UI or CLI) |
| [The Book of HarneesLab](https://harneeslab.codewithgenie.com/book/) | 10-chapter narrative tutorial |
| [CLI Reference](https://harneeslab.codewithgenie.com/reference/cli/) | Full CLI reference |
| [Authoring Workflows](https://harneeslab.codewithgenie.com/guides/authoring-workflows/) | Create custom YAML workflows |
| [Authoring Commands](https://harneeslab.codewithgenie.com/guides/authoring-commands/) | Create reusable AI commands |
| [Configuration](https://harneeslab.codewithgenie.com/reference/configuration/) | All config options, env vars, YAML settings |
| [AI Assistants](https://harneeslab.codewithgenie.com/getting-started/ai-assistants/) | Claude and Codex setup details |
| [Deployment](https://harneeslab.codewithgenie.com/deployment/) | Docker, VPS, production setup |
| [Architecture](https://harneeslab.codewithgenie.com/reference/architecture/) | System design and internals |
| [Troubleshooting](https://harneeslab.codewithgenie.com/reference/troubleshooting/) | Common issues and fixes |

## Telemetry

HarneesLab sends a single anonymous event — `workflow_invoked` — each time a workflow starts, so maintainers can see which workflows get real usage and prioritize accordingly. **No PII, ever.**

**What's collected:** the workflow name, the workflow description (both authored by you in YAML), the platform that triggered it (`cli`, `web`, `slack`, etc.), the HarneesLab version, and a random install UUID stored at `~/.archon/telemetry-id`. Nothing else.

**What's *not* collected:** your code, prompts, messages, git remotes, file paths, usernames, tokens, AI output, workflow node details — none of it.

**Opt out:** set any of these in your environment:

```bash
ARCHON_TELEMETRY_DISABLED=1
DO_NOT_TRACK=1        # de facto standard honored by Astro, Bun, Prisma, Nuxt, etc.
```

Self-host PostHog or use a different project by setting `POSTHOG_API_KEY` and `POSTHOG_HOST`.

## Contributing

Contributions welcome! See the open [issues](https://github.com/NewTurn2017/HarneesLab/issues) for things to work on.

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a pull request.

## License

[MIT](LICENSE)
