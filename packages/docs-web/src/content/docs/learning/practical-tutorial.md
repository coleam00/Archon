---
title: Archon Practical Tutorial
description: A source-backed learning path from first install to supervised issue-to-PR workflows.
category: learning
audience: [user, operator]
status: current
sidebar:
  order: 1
---

This tutorial teaches Archon as a practical harness for real software projects.
It is written for a learner on Windows who wants cross-platform commands,
the CLI and Web UI, Codex plus Gemini through Pi, a disposable sandbox
repository, personal local usage first, team usage later, and human approval
gates enabled while learning.

## Setup Profile Used In This Tutorial

- Operating system: Windows-first, with macOS, Linux, and WSL notes.
- Recommended Windows mode: WSL2 for full workflow compatibility; native
  PowerShell is fine for basic server, Web UI, and simple workflows.
- Interfaces: CLI plus Web UI.
- Assistants: Codex first; Pi for Gemini and other community-provider routing.
- Repository: disposable sandbox before any real project.
- Usage goal: personal local usage first, team usage later.
- Safety posture: human approval gates enabled; no autonomous merge as the
  learning default.

> Security warning
>
> Do not paste API keys, GitHub tokens, OAuth tokens, or `.env` contents into
> chat. Use placeholders in notes, and enter secrets locally in Archon-owned
> environment files or setup screens.

## Source And Verification Notes

Official source of truth:

- `README.md`
- `CONTRIBUTING.md`
- `.archon/workflows/defaults/`
- `.archon/commands/defaults/`
- `.claude/skills/archon/`
- `packages/docs-web/src/content/docs/`
- `packages/cli/`
- `packages/providers/`
- `packages/server/`
- `packages/adapters/`

Additional verification:

- The current remote default branch was checked dynamically with
  `git remote show origin`; it is `dev` at the time this tutorial was written.
- Context7 resolved Archon docs to `/websites/archon_diy`.
- The published URLs `https://archon.diy/llms.txt`,
  `https://archon.diy/llms-small.txt`, and
  `https://archon.diy/llms-full.txt` returned 404 during this review, so they
  are not used as evidence here.

Transcript sources in `transcripts/` are used only as case studies. Official
repo documentation overrides any transcript claim.

## Curriculum Map

Use this map to choose a pace. The full path is designed for a careful first
week, but each milestone can also stand alone as a workshop session.

| Milestone | Parts | Time | Outcome |
| --- | --- | --- | --- |
| Orientation | 0-1 | 45-60 minutes | You can explain Archon's harness model and choose the safe starting path. |
| Local setup | 2-3 | 60-120 minutes | Archon runs locally against a disposable sandbox repository. |
| First workflows | 4-5 | 90-150 minutes | You can run built-in workflows and inspect runs, worktrees, logs, and artifacts. |
| Authoring basics | 6-7 | 2-4 hours | You can create a custom command and a custom YAML workflow. |
| Supervised automation | 8-10 | 3-6 hours | You can build a Plan-Implement-Validate workflow and route provider work intentionally. |
| Interfaces and operations | 11-14 | 2-5 hours | You can use GitHub, understand adapters, deploy safely, and troubleshoot common failures. |
| Capstone | 15-16 | 2-4 hours | You can complete a supervised issue-to-PR workflow and keep a personal operating checklist. |

Suggested modes:

- Self-study: complete one milestone per day and keep a run journal.
- Workshop: teach one milestone per session, with the capstone as the final lab.
- Team onboarding: assign Parts 0-8 to everyone, then split provider, GitHub,
  deployment, and troubleshooting topics by role.

---

# Part 0 - Executive Overview

## Learning Objective

Understand what Archon is, why it exists, and what it should and should not
automate during your first week.

## Why This Matters

If you treat Archon as "a bigger prompt," you will miss its main value. Archon
is useful because it makes the process repeatable: the same phases, the same
handoffs, and the same validation gates every run.

## Prerequisites

None. This part is conceptual.

## What Archon Is

Archon is a workflow engine for AI coding agents. You write your development
process as YAML workflows, then Archon runs those workflows through coding
assistants such as Claude, Codex, and Pi.

Instead of asking one chat session to remember the whole process, you encode the
process:

```text
investigate -> plan -> approve -> implement -> validate -> review -> approve -> PR
```

The AI still reasons and writes code, but the structure is deterministic and
owned by you.

## Prompt Engineering, Context Engineering, And Harness Engineering

Prompt engineering is writing better instructions for one model call.

Context engineering is choosing the right files, docs, examples, rules, and
prior outputs to give the assistant.

Harness engineering is designing the process around the assistant: separate
steps, fresh sessions, explicit artifacts, deterministic checks, isolation, and
human approval gates.

Archon is mainly a harness engineering tool.

## Vocabulary

Assistant: the coding agent client that executes work, such as Claude Code,
Codex CLI, or Pi.

Model: the specific model used by an assistant, such as a Codex model or a Pi
model reference.

Provider: the Archon workflow provider name, such as `claude`, `codex`, or
`pi`.

Command: a Markdown prompt template in `.archon/commands/`.

Workflow: a YAML file in `.archon/workflows/` that connects nodes into a DAG.

Node: one step in a workflow. A node can be an AI command, inline prompt, bash
script, script node, loop, approval gate, or cancellation.

Artifact: a file written to `$ARTIFACTS_DIR` so another node can read it later.

Worktree: an isolated Git working directory for a workflow run.

Adapter: a user-facing interface such as CLI, Web UI, GitHub, Slack, Telegram,
or Discord.

Human approval gate: a workflow pause where a human approves or rejects the next
step.

## First Week Automation Boundary

During week one, Archon should automate:

- Repository explanation and exploration.
- Planning artifacts.
- Safe branch/worktree setup.
- Repetitive implementation on disposable tasks.
- Deterministic validation commands.
- Draft pull requests.
- Review summaries.

During week one, Archon should not automate:

- Merging to protected branches.
- Rotating or reading secrets unless you explicitly decide it is safe.
- Production deployment.
- Large rewrites in an important repo without a plan approval gate.
- Unreviewed GitHub issue-to-merge loops.

## Mental Model Diagram

```text
User request
  -> Archon workflow
  -> isolated worktree
  -> planning
  -> human plan approval
  -> implementation
  -> deterministic validation
  -> review
  -> human final approval
  -> pull request
```

## Verification Checklist

- You can explain why a workflow is more repeatable than one long chat.
- You can name where commands and workflows live.
- You understand that artifacts, not hidden conversation memory, are the safe
  handoff mechanism.

## Expected Result

You should be able to describe Archon as a workflow harness for coding agents,
not as a replacement for human engineering judgment.

## Common Mistakes

- Treating a workflow as a bigger prompt instead of a process.
- Relying on one AI conversation to remember everything.
- Skipping human gates before implementation.
- Letting transcripts define "official" behavior when repo docs disagree.

## Mini Exercise

Write a one-sentence harness goal for your first sandbox task:

```text
I want Archon to explore a disposable repo, write a plan, pause for review,
implement one small change, run tests, and stop before merging.
```

## Completion Checkpoint

Move on when you can explain the diagram in your own words.

## Source References

- `README.md`
- `packages/docs-web/src/content/docs/book/what-is-archon.md`
- `packages/docs-web/src/content/docs/getting-started/concepts.md`
- `packages/docs-web/src/content/docs/guides/authoring-workflows.md`
- `packages/docs-web/src/content/docs/guides/authoring-commands.md`

---

# Part 1 - Choose The Correct Starting Path

## Learning Objective

Choose the setup path that gets you to a safe first run quickly.

## Why This Matters

The wrong starting path makes Archon feel more complex than it is. A local
source setup gives you visibility into workflows and commands while keeping
deployment concerns out of the first lesson.

## Prerequisites

You should know which operating system and assistant path you intend to use.

## Recommended Path For You

Use this order:

1. Source-based local setup in WSL2.
2. CLI plus Web UI.
3. Codex configured as the first assistant.
4. Pi configured later for Gemini routing.
5. Disposable Git sandbox.
6. Human approval gates.
7. GitHub issue-to-PR only after local workflows are comfortable.

This gives you the most compatibility for worktrees, shell nodes, Web UI, and
GitHub workflows without starting with VPS complexity.

## Decision Tree

Choose guided full setup if you want Archon to walk you through credentials and
project setup. Avoid it if you want to understand each file manually.

Choose quick CLI installation if you want the fastest `archon` binary. Avoid it
if you want to inspect and modify Archon source while learning.

Choose source-based local development if you want the Web UI, repo examples,
and current workflow files visible. This is the recommended path for this
tutorial.

Choose Web UI first if visual monitoring and approval buttons matter. Avoid it
if you want minimal terminal-only operation.

Choose CLI-only if you want repeatable terminal commands. Avoid it if you are
learning approval gates, because the Web UI makes paused runs easier to see.

## Verification Checklist

- You know which path you are following.
- You know whether you are in native Windows, WSL2, macOS, or Linux.
- You have decided not to use a real production repo for the first run.

## Expected Result

You should choose source-based local setup, CLI plus Web UI, Codex first, Pi
later, and a disposable sandbox repository.

## Common Mistakes

- Running Archon from the Archon repo when the target should be your sandbox
  repo.
- Starting with VPS deployment before local validation.
- Trying mixed-provider workflows before a single-provider workflow works.

## Mini Exercise

Write down your path:

```text
I will use WSL2/source setup, CLI plus Web UI, Codex first, and a disposable sandbox.
```

## Completion Checkpoint

Move on when the starting path is settled and you are not planning to use a real
project for the first workflow.

## Source References

- `README.md`
- `packages/docs-web/src/content/docs/getting-started/overview.md`
- `packages/docs-web/src/content/docs/getting-started/installation.md`
- `packages/docs-web/src/content/docs/deployment/windows.md`

---

# Part 2 - Installation And Safe Verification

## Learning Objective

Install Archon, verify the CLI and Web UI, configure Codex safely, and avoid
secret leakage.

## Why This Matters

Most early Archon failures come from environment setup: missing binaries,
wrong PATH, unclear provider authentication, or secrets in the wrong file.

## Prerequisites

Install:

- Git
- Bun
- GitHub CLI, `gh`, for GitHub workflows and PR creation
- Codex CLI
- Optional but often useful: Claude Code, because many current default
  workflows and docs are Claude-oriented
- Pi, when you reach the Gemini module

## Step-By-Step Summary

1. Install system tools.
2. Clone Archon.
3. Run `bun install`.
4. Link the CLI.
5. Configure Codex.
6. Start the Web UI.
7. Run health checks.
8. Confirm no secrets were placed in the target repo `.env`.

> Current-docs note
>
> The installation docs still describe Claude Code as required for the primary
> path, while the AI Assistants docs say Archon can configure Claude, Codex, and
> Pi. For a Codex-first learner, configure Codex, then treat Claude-only fields
> and Claude-declared default workflows carefully.

## Windows Recommended Setup: WSL2

PowerShell:

```powershell
wsl --install
```

Restart if prompted. Open Ubuntu from the Start menu.

Inside WSL2:

```bash
sudo apt update
sudo apt install -y git curl
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
```

Install GitHub CLI inside WSL2 using the current GitHub CLI instructions for
your distribution, then verify:

```bash
git --version
bun --version
gh --version
```

## Native Windows Basic Setup

PowerShell:

```powershell
git --version
irm bun.sh/install.ps1 | iex
bun --version
winget install GitHub.cli
gh --version
```

Native Windows works for basic server, Web UI, and simple workflows. WSL2 is
recommended for full worktree and shell compatibility.

## Clone And Install Archon From Source

macOS, Linux, or WSL:

```bash
git clone https://github.com/coleam00/Archon
cd Archon
bun install
```

Windows PowerShell:

```powershell
git clone https://github.com/coleam00/Archon
cd Archon
bun install
```

## Link The CLI

From the Archon repo:

```bash
cd packages/cli
bun link
cd ../..
archon version
```

If `archon` is not found, make sure Bun's bin directory is on your `PATH`.

## Configure Codex

Install Codex:

```bash
npm install -g @openai/codex
codex login
```

The current docs describe Codex credential environment variables:

```ini
CODEX_ID_TOKEN=...
CODEX_ACCESS_TOKEN=...
CODEX_REFRESH_TOKEN=...
CODEX_ACCOUNT_ID=...
```

Do not paste these into chat. Prefer `archon setup`, `~/.archon/.env`, or a
private local editor.

Create or edit `~/.archon/config.yaml`:

```yaml
defaultAssistant: codex
assistants:
  codex:
    model: gpt-5.3-codex
    modelReasoningEffort: medium
    webSearchMode: disabled
```

If your installed Codex model names differ, use the model ID that your Codex CLI
currently supports. Do not guess model strings in workflows that other people
will run.

## Optional Claude Setup

Install Claude only if you plan to run Claude-backed defaults as written:

macOS, Linux, WSL:

```bash
curl -fsSL https://claude.ai/install.sh | bash
claude /login
```

Windows PowerShell:

```powershell
irm https://claude.ai/install.ps1 | iex
claude /login
```

For compiled Archon binaries, configure `CLAUDE_BIN_PATH` or
`assistants.claude.claudeBinaryPath`. Source mode usually resolves from the
development environment.

## Start The Web UI

From the Archon repo:

```bash
bun run dev
```

Expected:

```text
API server: http://localhost:3090
Web UI:     http://localhost:5173
```

Verify in a second terminal:

```bash
curl http://localhost:3090/health
curl http://localhost:3090/health/db
```

## Binary Web UI Path

For compiled binary installs, the docs use:

```bash
archon serve
archon serve --port 4000
archon serve --download-only
```

In source development, use `bun run dev` instead of `archon serve`.

## No `archon doctor` In Current CLI

The requested curriculum mentions `archon doctor`, but the current CLI reference
and source list no `doctor` command. Use these supported checks instead:

```bash
archon version
archon workflow list --cwd /path/to/repo
archon validate workflows --cwd /path/to/repo
archon validate commands --cwd /path/to/repo
curl http://localhost:3090/health
curl http://localhost:3090/health/db
```

## What Not To Share

Do not share:

- `~/.archon/.env`
- `<repo>/.archon/.env`
- `~/.codex/auth.json`
- GitHub tokens
- OAuth tokens
- API keys
- full debug logs unless you inspected them for secrets
- terminal history containing token export commands

## Expected Result

You should have `archon version`, `bun run dev`, the API health endpoint, and
Codex authentication working locally.

## Common Mistakes

- Running commands as root on a VPS.
- Putting Archon secrets in the target repo `.env`.
- Assuming `archon doctor` exists in the current CLI.
- Installing Codex but not authenticating it.
- Forgetting that many default workflows are still Claude-oriented unless
  configured otherwise.

## Mini Exercise

Run the supported setup checks:

```bash
archon version
curl http://localhost:3090/health
curl http://localhost:3090/health/db
```

## Verification Checklist

- `archon version` prints a version.
- `bun run dev` starts the local server and Web UI.
- Health checks return OK.
- Codex is installed and authenticated.
- No real secret appears in shell output, chat, or Git diff.

## Completion Checkpoint

You are ready for Part 3 when:

- `archon version` works.
- `bun run dev` starts the Web UI from source.
- `curl http://localhost:3090/health` returns OK.
- Codex is installed and authenticated.
- You know where Archon-owned env files live.

## Source References

- `packages/docs-web/src/content/docs/getting-started/overview.md`
- `packages/docs-web/src/content/docs/getting-started/installation.md`
- `packages/docs-web/src/content/docs/getting-started/ai-assistants.md`
- `packages/docs-web/src/content/docs/reference/cli.md`
- `packages/docs-web/src/content/docs/reference/configuration.md`
- `packages/docs-web/src/content/docs/reference/security.md`
- `packages/docs-web/src/content/docs/deployment/windows.md`
- `packages/cli/src/cli.ts`

---

# Part 3 - Your First Target Repository

## Learning Objective

Create a disposable Git repository, run Archon against it, and inspect the
result without risking important code.

## Why This Matters

The sandbox lets you learn worktrees, artifacts, approvals, and GitHub flows
without risking a real codebase.

## Prerequisites

- Archon CLI works.
- Web UI starts.
- Git can create commits.

## Create A Sandbox Repository

macOS, Linux, WSL:

```bash
mkdir -p ~/archon-sandbox
cd ~/archon-sandbox
git init
cat > README.md <<'EOF'
# Archon Sandbox

This repository exists only for learning Archon.
EOF
mkdir -p src
cat > src/math.js <<'EOF'
export function add(a, b) {
  return a + b;
}
EOF
cat > package.json <<'EOF'
{
  "type": "module"
}
EOF
git add .
git commit -m "Initial sandbox commit"
```

Windows PowerShell:

```powershell
mkdir $HOME\archon-sandbox
cd $HOME\archon-sandbox
git init
"# Archon Sandbox`n`nThis repository exists only for learning Archon." | Set-Content README.md
mkdir src
"export function add(a, b) {`n  return a + b;`n}" | Set-Content src\math.js
'{"type":"module"}' | Set-Content package.json
git add .
git commit -m "Initial sandbox commit"
```

## Run Archon From The Target Repository

The target repository is the repo Archon should inspect or modify. Do not run
your first sandbox workflow from inside the Archon source repo.

```bash
cd ~/archon-sandbox
archon workflow list
```

Read-only exploration:

```bash
archon workflow run archon-assist --no-worktree "Explain this repository structure."
```

If you prefer explicit paths:

```bash
archon workflow run archon-assist --cwd ~/archon-sandbox --no-worktree "Explain this repository structure."
```

## Web UI Project Registration

1. Open `http://localhost:5173`.
2. Add a project from the sidebar or settings.
3. Enter the local sandbox path.
4. Start a new conversation.
5. Ask:

```text
Explain the structure of this sandbox repository.
```

## Expected Result

Archon should explain:

- There is a README.
- There is a small JavaScript source file.
- The repo is intentionally minimal.

## Verification Checklist

- `archon workflow list` shows workflows.
- The sandbox has an initial Git commit.
- The first run did not modify files.
- The Web UI can register the project.

## Common Mistakes

- Running from the Archon repo instead of the sandbox.
- Forgetting the initial commit.
- Hitting a Git identity error on the first commit. If that happens, set a local
  disposable identity with `git config user.name "Archon Learner"` and
  `git config user.email "learner@example.com"` in the sandbox repo.
- Using a real private repo before you understand artifacts and logs.

## Mini Exercise

Ask Archon to describe one file:

```bash
archon workflow run archon-assist --no-worktree "Explain src/math.js and suggest one tiny improvement without editing files."
```

## Completion Checkpoint

Move on when both CLI and Web UI can see the sandbox repository.

## Source References

- `README.md`
- `packages/docs-web/src/content/docs/getting-started/quick-start.md`
- `packages/docs-web/src/content/docs/reference/cli.md`
- `packages/docs-web/src/content/docs/adapters/web.md`

---

# Part 4 - Using Built-In Workflows

## Learning Objective

Know which current built-in workflows exist and which ones to learn first.

## Why This Matters

The workflow catalog is powerful but broad. Beginners get better results by
learning a few workflows deeply before trying specialized automation.

## Prerequisites

- You can run `archon workflow list`.
- You have a sandbox repository.

## Current Default Workflows

At the time this tutorial was reviewed, `.archon/workflows/defaults/` contains
these workflow files:

- `archon-adversarial-dev`
- `archon-architect`
- `archon-assist`
- `archon-comprehensive-pr-review`
- `archon-create-issue`
- `archon-feature-development`
- `archon-fix-github-issue`
- `archon-idea-to-pr`
- `archon-interactive-prd`
- `archon-issue-review-full`
- `archon-piv-loop`
- `archon-plan-to-pr`
- `archon-ralph-dag`
- `archon-refactor-safely`
- `archon-remotion-generate`
- `archon-resolve-conflicts`
- `archon-smart-pr-review`
- `archon-test-loop-dag`
- `archon-validate-pr`
- `archon-workflow-builder`

Always run this for the current catalog:

```bash
archon workflow list
```

## Learning Progression

Start with:

1. `archon-assist` for explanation and exploration.
2. `archon-piv-loop` for guided Plan-Implement-Validate with human review.
3. `archon-refactor-safely` on a disposable small refactor.
4. `archon-idea-to-pr` once you understand PR creation.
5. `archon-fix-github-issue` after GitHub CLI and tokens are set up.
6. `archon-smart-pr-review` after you have a PR.
7. `archon-validate-pr` after you understand ports and test setup.

Treat these as advanced or specialized:

- `archon-adversarial-dev`
- `archon-ralph-dag`
- `archon-issue-review-full`
- `archon-comprehensive-pr-review`
- `archon-remotion-generate`
- `archon-workflow-builder`
- `archon-test-loop-dag`

## Beginner Workflow Examples

Explore:

```bash
archon workflow run archon-assist --no-worktree "What does this repo do?"
```

Guided development with a human loop:

```bash
archon workflow run archon-piv-loop --branch piv/add-subtract "Add a subtract function and tests."
```

Safe refactor:

```bash
archon workflow run archon-refactor-safely --branch refactor/math-module "Refactor the tiny math module without changing behavior."
```

GitHub issue fix:

```bash
archon workflow run archon-fix-github-issue --branch fix/issue-1 "Fix issue #1"
```

PR review:

```bash
archon workflow run archon-smart-pr-review "Review PR #1"
```

## Human Review Placement

For beginners, human review belongs:

- After exploration, before implementation.
- After plan creation.
- After deterministic validation.
- Before PR creation if the workflow supports it.
- Before merge, always.

## Expected Result

You should know which workflow to reach for when exploring, building, fixing a
GitHub issue, reviewing a PR, or validating a PR.

## Verification Checklist

- `archon workflow list` runs in the sandbox.
- You can identify at least three beginner workflows.
- You know which workflows are advanced or specialized.

## Common Mistakes

- Treating every default workflow as beginner-friendly.
- Using a PR workflow before GitHub auth works.
- Running a modifying workflow without a branch.

## Mini Exercise

Pick the best workflow for each prompt:

```text
"What does this repo do?"
"Fix issue #1"
"Review PR #2"
"Refactor this tiny module safely"
```

## Completion Checkpoint

You can move on when:

- You can pick a workflow for exploration, feature work, issue fixing, PR review,
  and validation.
- You understand that `--branch` is the safe default for modifying work.
- You know some built-ins may be Claude-oriented unless changed.

## Source References

- `.archon/workflows/defaults/`
- `README.md`
- `packages/docs-web/src/content/docs/book/essential-workflows.md`
- `packages/docs-web/src/content/docs/reference/cli.md`

---

# Part 5 - Worktrees, Isolation, Artifacts, And Logs

## Learning Objective

Understand where Archon runs work and how to inspect what happened.

## Why This Matters

Worktrees protect your main checkout. Artifacts and logs let you audit what the
AI did after the fact.

## Prerequisites

- A Git repository with an initial commit.
- At least one completed or running workflow.

## Why Worktrees Matter

When a workflow modifies code, it should not write directly into your main
checkout. Git worktrees let Archon create a separate working directory and
branch for a run.

Default workflow runs create isolated worktrees unless you opt out or a workflow
pins `worktree.enabled: false`.

Use:

```bash
archon workflow run archon-assist --branch learn/explain "Explain the project and write a short summary."
```

For read-only questions, `--no-worktree` is acceptable:

```bash
archon workflow run archon-assist --no-worktree "What files define the CLI?"
```

Use `--no-worktree` cautiously for anything that might edit files.

## Where Files Live

Typical user-level layout:

```text
~/.archon/
  workspaces/<owner>/<repo>/
    source/
    worktrees/
    artifacts/
    logs/
  archon.db
  config.yaml
```

Artifacts:

```text
~/.archon/workspaces/<owner>/<repo>/artifacts/runs/<run-id>/
```

Logs:

```text
~/.archon/workspaces/<owner>/<repo>/logs/<run-id>.jsonl
```

## Inspect Active Runs

```bash
archon workflow status
archon workflow status --json
```

## Inspect Worktrees

```bash
archon isolation list
```

Cleanup stale environments:

```bash
archon isolation cleanup
archon isolation cleanup 14
archon isolation cleanup --merged
```

Complete a branch lifecycle after merge:

```bash
archon complete <branch-name>
```

## Inspect JSONL Logs

macOS, Linux, WSL:

```bash
tail -n 50 ~/.archon/workspaces/<owner>/<repo>/logs/<run-id>.jsonl
jq 'select(.type == "node_error" or .type == "workflow_error")' ~/.archon/workspaces/<owner>/<repo>/logs/<run-id>.jsonl
```

Windows PowerShell:

```powershell
Get-Content "$HOME\.archon\workspaces\<owner>\<repo>\logs\<run-id>.jsonl" -Tail 50
```

## Expected Result

You should be able to find a run ID, locate its log file, locate its artifact
directory, and identify the worktree branch.

## CLI Versus Server File Visibility

The CLI reads local commands and workflows directly from the working directory.
It sees uncommitted edits.

The server and adapters read from the workspace clone under `~/.archon/workspaces/`.
For server-based adapters such as GitHub, Slack, and Telegram, commit and push
workflow or command changes before expecting the server clone to see them.

## Mini Exercise

Run an isolated workflow:

```bash
archon workflow run archon-assist --branch learn/artifacts "Explain this repo and mention where artifacts are stored."
archon workflow status
archon isolation list
```

Then locate the run's log and artifact directory.

## Verification Checklist

- `archon workflow status` shows recent run state.
- `archon isolation list` shows or confirms active worktrees.
- You can locate the JSONL log file.
- You can locate the artifact run directory.

## Common Mistakes

- Looking for artifacts inside the Git repo.
- Cleaning up a worktree before checking whether the PR was merged.
- Using `--no-worktree` for implementation work.

## Completion Checkpoint

You can move on when:

- You can find active runs.
- You can find worktrees.
- You can explain why artifacts are outside Git.
- You know when not to use `--no-worktree`.

## Source References

- `packages/docs-web/src/content/docs/book/isolation.md`
- `packages/docs-web/src/content/docs/book/how-it-works.md`
- `packages/docs-web/src/content/docs/reference/archon-directories.md`
- `packages/docs-web/src/content/docs/reference/configuration.md`
- `packages/docs-web/src/content/docs/reference/cli.md`
- `.claude/skills/archon/references/troubleshooting.md`

---

# Part 6 - Custom Commands

## Learning Objective

Create a reusable Archon command and validate it.

## Why This Matters

Commands make reusable AI instructions. They keep workflow nodes focused and
make team processes easier to share.

## Prerequisites

- A repository with `.archon/` available or ready to create.
- `archon validate commands` works.

## Command Location

Repo-specific commands live here:

```text
.archon/commands/
```

Global commands can live here:

```text
~/.archon/commands/
```

## Create A Verification Command

Create:

```text
.archon/commands/sandbox-verify.md
```

Content:

```markdown
---
description: Run the sandbox verification routine and write an artifact summary.
argument-hint: <what changed>
---

# Sandbox Verify

Input: $ARGUMENTS

## Mission

Verify the sandbox repository after a small change.

## Steps

1. Inspect `git status --short`.
2. Inspect the changed files.
3. Run the project's available validation command if one exists.
4. Create `$ARTIFACTS_DIR/sandbox-verification.md`.

## Artifact Requirements

The artifact must include:

- Change summary
- Validation command used
- Validation result
- Remaining risks
- Recommended next action
```

Validate:

```bash
archon validate commands sandbox-verify
```

Run through an inline workflow later, or use it as a command node in Part 7.

## Expected Result

The command validates and clearly instructs the AI to write a verification
artifact.

## Verification Checklist

- The command file has frontmatter.
- It references `$ARGUMENTS`.
- It writes to `$ARTIFACTS_DIR`.
- `archon validate commands sandbox-verify` exits successfully.

## Common Mistakes

- Writing command files that do not tell the AI where to save artifacts.
- Assuming the next node remembers what this command found.
- Putting secrets in command files.
- Forgetting frontmatter is for metadata, not secrets.

## Mini Exercise

Change the command so the artifact also includes "What I did not check." Validate
the command again.

## Completion Checkpoint

You can move on when `archon validate commands sandbox-verify` succeeds.

## Source References

- `packages/docs-web/src/content/docs/guides/authoring-commands.md`
- `packages/docs-web/src/content/docs/reference/variables.md`
- `.archon/commands/defaults/`
- `.claude/skills/archon/references/authoring-commands.md`

---

# Part 7 - Custom YAML Workflows

## Learning Objective

Build a workflow gradually, using only currently documented fields.

## Why This Matters

Workflow authoring is where Archon becomes your process instead of someone
else's defaults.

## Prerequisites

- You have created at least one command.
- You know the difference between an AI node and a deterministic node.

## File Location

Create:

```text
.archon/workflows/sandbox-piv.yaml
```

## Module 7.1 - Minimal Plan And Implement

```yaml
name: sandbox-piv
description: Plan and implement a tiny sandbox change.
provider: codex
model: gpt-5.3-codex

nodes:
  - id: plan
    prompt: |
      Create a concise implementation plan for this request:
      $USER_MESSAGE

      Write the plan to $ARTIFACTS_DIR/plan.md.

  - id: implement
    depends_on: [plan]
    prompt: |
      Read $ARTIFACTS_DIR/plan.md.
      Implement the smallest safe change.
```

Validate:

```bash
archon validate workflows sandbox-piv
```

Run:

```bash
archon workflow run sandbox-piv --branch sandbox/add-subtract "Add a subtract function."
```

## Expected Result

The workflow validates, creates a plan artifact, implements a tiny change, and
can be extended without changing its basic shape.

## Module 7.2 - Add Deterministic Validation

Add:

```yaml
  - id: validate
    depends_on: [implement]
    bash: |
      git status --short
      bun -e "import('./src/math.js').then(m => { if (m.add(2, 3) !== 5) process.exit(1); })"
```

`bash` is deterministic. Its stdout becomes `$validate.output`.

## Module 7.3 - Add Artifact Handoffs

Revise `plan`:

```yaml
  - id: plan
    prompt: |
      Create a concise implementation plan for this request:
      $USER_MESSAGE

      Save it to $ARTIFACTS_DIR/plan.md with:
      - files to change
      - exact validation command
      - risks
```

Revise `implement`:

```yaml
  - id: implement
    depends_on: [plan]
    context: fresh
    prompt: |
      You are in a fresh session.
      Read $ARTIFACTS_DIR/plan.md.
      Implement only the approved plan.
```

## Module 7.4 - Add Fresh Context

Use `context: fresh` on AI `command` or `prompt` nodes when the node should not
inherit prior conversation state. Do not use `context: fresh` on `loop` nodes;
loops use `loop.fresh_context`.

## Module 7.5 - Add Conditional Logic

Use `output_format` for structured data and `when:` for routing:

```yaml
  - id: classify
    prompt: |
      Classify this request: $USER_MESSAGE
    output_format:
      type: object
      properties:
        type:
          type: string
          enum: [READ_ONLY, MODIFY]
      required: [type]

  - id: explain-only
    depends_on: [classify]
    when: "$classify.output.type == 'READ_ONLY'"
    prompt: "Answer without editing files."

  - id: plan
    depends_on: [classify]
    when: "$classify.output.type == 'MODIFY'"
    prompt: "Create $ARTIFACTS_DIR/plan.md for the requested change."
```

## Module 7.6 - Add A Validation Loop

```yaml
  - id: fix-until-valid
    depends_on: [implement]
    loop:
      prompt: |
        Run validation. If it fails, fix the smallest issue.
        When validation passes, output <promise>VALID</promise>.
      until: VALID
      max_iterations: 3
      until_bash: |
        bun -e "import('./src/math.js').then(m => { if (m.add(2, 3) !== 5) process.exit(1); })"
      fresh_context: false
```

Do not put `provider` or `model` on the loop node. Current docs say those fields
are ignored on loops; use workflow-level provider/model or design separate AI
nodes.

## Module 7.7 - Add Human Approval

```yaml
interactive: true

nodes:
  - id: plan
    prompt: |
      Create $ARTIFACTS_DIR/plan.md for: $USER_MESSAGE

  - id: approve-plan
    depends_on: [plan]
    approval:
      message: "Review $ARTIFACTS_DIR/plan.md. Approve to implement."
      capture_response: true
      on_reject:
        prompt: |
          The plan was rejected: $REJECTION_REASON
          Revise $ARTIFACTS_DIR/plan.md.
        max_attempts: 3

  - id: implement
    depends_on: [approve-plan]
    context: fresh
    prompt: |
      Read $ARTIFACTS_DIR/plan.md.
      Additional reviewer note: $approve-plan.output
      Implement the plan.
```

Workflow-level `interactive: true` is required for Web UI approval gates.

## Module 7.8 - Interactive Loops Versus Approval Nodes

Use `approval:` for one clear checkpoint, such as "approve plan before
implementation."

Use `loop.interactive: true` when each iteration needs feedback, such as "revise
this design until I approve it."

## Module 7.9 - DAG And Parallel Nodes

Nodes with no dependency between them can run in parallel:

```yaml
  - id: review-code
    depends_on: [validate]
    prompt: "Review code changes."

  - id: review-tests
    depends_on: [validate]
    prompt: "Review test coverage."

  - id: synthesize
    depends_on: [review-code, review-tests]
    trigger_rule: none_failed_min_one_success
    prompt: "Synthesize review findings."
```

## Completion Checkpoint

You can move on when:

- `archon validate workflows sandbox-piv` succeeds.
- You can explain each node type used.
- You can approve and reject a paused workflow.
- You know which fields are ignored on loops, bash, script, and approval nodes.

## Verification Checklist

- `archon validate workflows sandbox-piv` succeeds.
- The workflow has a plan node and an implement node.
- The validation node is deterministic.
- Approval examples use workflow-level `interactive: true`.

## Common Mistakes

- Setting `provider` or `model` on a loop node and expecting it to work.
- Reading free-form AI text in `when:` conditions instead of using
  `output_format`.
- Forgetting workflow-level `interactive: true`.
- Creating one huge workflow before the two-node version works.

## Mini Exercise

Add one read-only `review` prompt node after validation and make it use
`context: fresh`.

## Source References

- `packages/docs-web/src/content/docs/guides/authoring-workflows.md`
- `packages/docs-web/src/content/docs/guides/loop-nodes.md`
- `packages/docs-web/src/content/docs/guides/approval-nodes.md`
- `packages/docs-web/src/content/docs/guides/script-nodes.md`
- `.claude/skills/archon/references/parameter-matrix.md`

---

# Part 8 - Plan-Implement-Validate As The Core Harness

## Learning Objective

Build a supervised workflow that plans, pauses, implements, validates, reviews,
pauses again, and then prepares a PR.

## Why This Matters

PIV is the practical default for real work because it keeps the AI productive
while reserving judgment calls for a human.

## Prerequisites

- Custom workflow validation works.
- You understand approval nodes.
- You have a sandbox branch you can safely modify.

## Why This Is A Strong Default

Plan-Implement-Validate works because each step has a clear owner:

- AI investigates and drafts a plan.
- Human reviews the plan.
- AI implements from the approved artifact.
- Bash or scripts validate deterministically.
- AI reviews the diff.
- Human approves final state.
- GitHub PR creation is explicit.

## Supervised Workflow Shape

```text
explore
  -> plan artifact
  -> approval gate
  -> implementation in fresh context
  -> deterministic validation
  -> fix loop if validation fails
  -> independent review
  -> final approval gate
  -> create PR
```

## Exercise

Run the current built-in guided workflow first:

```bash
archon workflow run archon-piv-loop --branch piv/sandbox-subtract "Add a subtract function and validate it."
```

Then compare it to your custom `sandbox-piv.yaml`.

## Expected Result

You should have a supervised workflow run where implementation happens only
after plan review.

## Verification Checklist

- A plan artifact exists.
- A human approval gate pauses the workflow.
- Validation is deterministic.
- Final review happens in a separate node or phase.

## Common Mistakes

- Letting implementation start before plan approval.
- Treating AI validation as a substitute for tests.
- Keeping all phases in one shared context.

## Mini Exercise

Reject the plan once with a concrete reason, then verify the workflow revises
before asking again.

## Completion Checkpoint

Move on when you can explain which PIV steps are AI reasoning, which are
deterministic, and which are human decisions.

## Human Role

You stay involved at:

- Scope selection.
- Plan approval.
- Validation review.
- PR review.
- Merge decision.

## Source References

- `.archon/workflows/defaults/archon-piv-loop.yaml`
- `packages/docs-web/src/content/docs/guides/approval-nodes.md`
- `packages/docs-web/src/content/docs/guides/loop-nodes.md`
- `packages/docs-web/src/content/docs/book/first-workflow.md`
- Transcript case study: `Pi Coding Agent + Archon Build ANY AI Coding Workflow (No Claude Code Bloat).txt`

---

# Part 9 - AI Assistants, Providers, And Model Routing

## Learning Objective

Use provider and model routing safely, especially with Codex and Pi/Gemini.

## Why This Matters

Provider routing can reduce cost and improve quality, but only if each node has
an explicit handoff and a verified model string.

## Prerequisites

- Codex works by itself.
- Pi works by itself before mixed-provider workflows.
- You can validate workflow YAML.

## Current Provider Model

Archon docs cover:

- `provider: claude`
- `provider: codex`
- `provider: pi` as a community provider

Provider and model can be set at workflow level:

```yaml
name: codex-workflow
provider: codex
model: gpt-5.3-codex
nodes:
  - id: explain
    prompt: "Explain this repo."
```

Or per AI node:

```yaml
nodes:
  - id: explore
    provider: codex
    model: gpt-5.3-codex
    prompt: "Map the relevant files."

  - id: plan
    provider: pi
    model: google/gemini-2.5-pro
    depends_on: [explore]
    prompt: "Create a plan from $explore.output."
```

## Gemini Through Pi

The docs show Pi model references in this format:

```text
<pi-provider-id>/<model-id>
```

Examples in docs include:

```yaml
model: google/gemini-2.5-pro
```

For Gemini 3.1 Pro, verify the exact Pi model ID locally before using it in a
workflow. Do not invent the model string. Check Pi's model picker or your
`~/.pi/agent/models.json`.

## Routing Heuristic

This is a starting heuristic, not a benchmark result.

| Work type | Suggested route |
| --- | --- |
| Fast repo exploration | Codex medium effort |
| Deep planning | Stronger model through Codex or Pi/Gemini |
| Implementation | Codex, Claude, or a verified Pi backend such as Gemini, Qwen, Kimi, or a local model you trust for edits |
| Deterministic validation | `bash` or `script`, no AI |
| Code review | Separate AI node, fresh context |
| Frontend design | Model/provider you have benchmarked for UI quality |
| Low-risk repetitive tasks | Cheaper/faster model |

For practical role assignments, use
[Model Role Recipes](/learning/model-role-recipes/) after the baseline
single-provider workflow works.

## Mixed-Provider Rule

When providers change between nodes, do not rely on implicit shared
conversation. Write artifacts and read artifacts explicitly.

## Expected Result

You should be able to design a workflow where Codex or Claude plans and reviews,
Gemini, Qwen, Kimi, Codex, or Claude handles inner development, and a
deterministic node validates, with artifacts between each step.

## Provider-Specific Caveats

- Claude supports Claude-only fields such as hooks, MCP per node, skills per
  node, and tool restrictions.
- Codex ignores some Claude-only fields; use Codex CLI config where applicable.
- Pi is community-maintained and has its own capability boundaries.
- `output_format` is reliable for Claude/Codex and best-effort for Pi.

## Verification Checklist

- Every provider name is documented.
- Every model string was verified locally.
- Cross-provider nodes read artifacts or upstream outputs explicitly.
- Planning, implementation, validation, and review roles are assigned by node
  responsibility.

## Common Mistakes

- Guessing a Gemini, Qwen, or Kimi model ID.
- Assuming providers share one conversation.
- Applying Claude-only fields to Codex or Pi nodes.

## Mini Exercise

Write a two-node YAML sketch where Codex maps files and Pi/Gemini writes a plan
from the Codex output. Validate before running.

## Completion Checkpoint

Move on when single-provider Codex and single-provider Pi runs both work.

## Source References

- `packages/docs-web/src/content/docs/getting-started/ai-assistants.md`
- `packages/docs-web/src/content/docs/guides/authoring-workflows.md`
- `packages/providers/src/`
- `.claude/skills/archon/references/parameter-matrix.md`
- Transcript case study: `Plan with Claude Opus, Build with Kimi K2.6 LIVE Mixed-Provider Benchmark.txt`
- Transcript case study: `Pushing My AI Dark Factory to Its Limits with Opus + Kimi Combined.txt`

---

# Part 10 - Pi Integration

## Learning Objective

Use Pi as a community provider, including Gemini routing and extension-aware
workflows, without treating experimental transcript patterns as core guarantees.

## Why This Matters

Pi gives Archon access to many backends, but it is community-maintained and has
different capabilities from Claude and Codex.

## Prerequisites

- Pi is installed or available through Archon's provider dependency.
- Pi authentication or local model configuration works.
- You know the exact model reference you plan to use.

## What Pi Is In Archon

Pi is documented as a community provider integrated under `provider: pi`.
It can route to many backends, including Google/Gemini, OpenAI, Anthropic, Groq,
Mistral, OpenRouter, Hugging Face, and local/custom endpoints.

## Authentication

Pi can use:

- OAuth subscriptions configured by running `pi` and `/login`.
- API keys such as `GEMINI_API_KEY` for Google/Gemini.
- Local/custom providers registered in `~/.pi/agent/models.json`.

Never paste keys into chat.

## Secure Setup Checklist

- Run Pi login locally.
- Store API keys only in Archon-owned env files or Pi's expected local files.
- Keep `~/.pi/agent/auth.json` private.
- Keep `~/.pi/agent/models.json` free of secrets if possible.
- Verify third-party extensions before installing.
- Disable extensions for a workflow if you do not need them:

```yaml
assistants:
  pi:
    enableExtensions: false
```

## Pi Workflow Example: Read-Only Analysis

```yaml
name: pi-readonly-analysis
description: Read-only repository analysis using Pi.
provider: pi
model: google/gemini-2.5-pro
worktree:
  enabled: false

nodes:
  - id: analyze
    prompt: |
      Analyze the repository structure for $USER_MESSAGE.
      Do not edit files.
      Write a summary to $ARTIFACTS_DIR/pi-analysis.md.
```

Before using Gemini 3.1 Pro, replace the model with the exact Pi model ID shown
by your local Pi configuration.

Validate:

```bash
archon validate workflows pi-readonly-analysis
```

Run:

```bash
archon workflow run pi-readonly-analysis --no-worktree "Find the main extension points."
```

## Expected Result

The workflow performs read-only analysis and writes
`$ARTIFACTS_DIR/pi-analysis.md`.

## Verification Checklist

- `provider: pi` validates.
- The Pi model reference is real in your environment.
- No code modification happens in the read-only exercise.

## Experimental Transcript Patterns

The transcripts discuss Pi extensions such as plan review UIs and third-party
approval tooling. Treat those as inspiration unless the current official docs
confirm the exact extension and fields you plan to use.

## Common Mistakes

- Installing third-party Pi extensions without review.
- Assuming a transcript YAML field is officially supported.
- Using a cloud API key where a local model would be enough for a read-only test.

## Mini Exercise

Run Pi against the sandbox with a read-only prompt, then inspect the artifact
before attempting any implementation workflow.

## Completion Checkpoint

Move on when you can explain which parts are official Pi support and which parts
are extension or transcript-inspired.

## Source References

- `packages/docs-web/src/content/docs/getting-started/ai-assistants.md`
- `packages/providers/src/community/pi/`
- Transcript case study: `Pi Coding Agent + Archon Build ANY AI Coding Workflow (No Claude Code Bloat).txt`
- Transcript case study: `Pi is INCREDIBLE - Building a Custom Coding Agent Live.txt`

---

# Part 11 - GitHub, Adapters, And Interfaces

## Learning Objective

Use GitHub safely as both a CLI dependency and a workflow entry point, then
understand optional chat adapters.

## Why This Matters

GitHub is where Archon becomes useful for real team work: issues become
workflow inputs, PRs become review targets, and webhook comments can trigger
automation.

## Prerequisites

- `gh auth status` works.
- Your sandbox is pushed to GitHub if you want to run issue workflows.
- You have a private place to store GitHub tokens.

## CLI

Use the CLI for local learning:

```bash
archon workflow list
archon workflow run archon-assist --no-worktree "Explain this repo."
archon workflow status
archon isolation list
```

## Web UI

Use the Web UI for:

- registering projects
- chatting with a selected project
- running workflows
- watching progress
- approving paused runs
- viewing artifacts

Start from source:

```bash
bun run dev
```

## GitHub CLI Setup

Install and authenticate:

```bash
gh auth login
gh auth status
```

For GitHub-backed workflows, make sure the repository has a remote and issues
or PRs exist.

## GitHub Token Safety

Archon docs use both:

```ini
GH_TOKEN=YOUR_GITHUB_TOKEN
GITHUB_TOKEN=YOUR_GITHUB_TOKEN
```

Use placeholders in documentation. Enter real values only in private local
configuration.

Prefer:

- `~/.archon/.env` for user-wide Archon secrets.
- `<repo>/.archon/.env` for repo-specific Archon secrets.

Do not put Archon secrets in `<repo>/.env`; current docs say Archon strips target
repo `.env` keys at boot to prevent leakage.

## GitHub Issue-To-PR Local Exercise

After creating a GitHub repository for your sandbox:

1. Push the sandbox repo to GitHub.
2. Create issue `#1`, such as "Add subtract function".
3. Run:

```bash
archon workflow run archon-fix-github-issue --branch fix/issue-1 "Fix issue #1"
```

Expected result:

- issue is investigated
- code is changed in an isolated branch/worktree
- validation runs according to the workflow
- a PR may be created if credentials and repo permissions are correct
- you review before merge

## Expected Result

You should be able to run a GitHub issue workflow from the CLI, understand the
branch and PR it creates, and stop before merge for human review.

## Verification Checklist

- The issue exists.
- The branch/worktree is isolated.
- The PR is reviewed by a human before merge.
- No token was printed in chat or committed.

## GitHub Webhook Adapter

Use this after local CLI workflows work.

The GitHub adapter lets you interact with Archon from issue and PR comments by
mentioning the bot.

Development setup requires a public endpoint such as ngrok or Cloudflare Tunnel:

```bash
ngrok http 3090
```

Webhook settings:

```text
Payload URL: https://your-public-url/webhooks/github
Content type: application/json
Secret: same value as WEBHOOK_SECRET
Events: issues, issue_comment, pull_request
```

Generate a webhook secret:

macOS, Linux, WSL:

```bash
openssl rand -hex 32
```

Windows PowerShell:

```powershell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
```

Set:

```ini
WEBHOOK_SECRET=YOUR_WEBHOOK_SECRET
GITHUB_ALLOWED_USERS=your-github-username
```

The whitelist is strongly recommended when exposing any adapter.

## Slack

Slack is an optional adapter. It uses Socket Mode, so it can work without a
public HTTP endpoint.

Secrets:

```ini
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_ALLOWED_USER_IDS=U01ABC,U02DEF
```

Use after the Web UI and CLI are comfortable.

## Telegram

Telegram is an optional adapter.

Secrets:

```ini
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_USER_IDS=123456789
```

## Discord

Discord is documented as a community adapter.

Secrets:

```ini
DISCORD_BOT_TOKEN=...
DISCORD_ALLOWED_USER_IDS=123456789012345678
```

## Jira

Jira appears in the transcript set as an experimental case study. Do not present
Jira as production-ready unless the current official docs add it.

The useful architecture idea is:

```text
ticket -> persistent conversation or workflow entry point -> plan -> implementation -> PR
```

## Completion Checkpoint

You can move on when:

- `gh auth status` works.
- You understand GitHub token placement.
- You can run a GitHub issue workflow from the CLI.
- You know GitHub webhooks require a public endpoint and signature secret.
- You can distinguish core, optional, community, and experimental adapters.

## Common Mistakes

- Forgetting to set both `GH_TOKEN` and `GITHUB_TOKEN` where required.
- Using a webhook without `WEBHOOK_SECRET`.
- Leaving adapter access open to all users on a public endpoint.
- Treating Jira transcript experiments as official adapter docs.

## Mini Exercise

Create a disposable GitHub issue for the sandbox, run the issue workflow, and
stop at the PR review step without merging.

## Source References

- `packages/docs-web/src/content/docs/adapters/github.md`
- `packages/docs-web/src/content/docs/adapters/web.md`
- `packages/docs-web/src/content/docs/adapters/slack.md`
- `packages/docs-web/src/content/docs/adapters/telegram.md`
- `packages/docs-web/src/content/docs/adapters/community/discord.md`
- `packages/docs-web/src/content/docs/reference/security.md`
- `packages/docs-web/src/content/docs/reference/configuration.md`
- Transcript case study: `Archon + Jira Drag a Ticket, Get a Pull Request (Live Build).txt`

---

# Part 12 - Local Development, Docker, VPS, And Deployment

## Learning Objective

Know when local usage is enough and when Docker or VPS deployment is appropriate.

## Why This Matters

Deployment adds security and operational responsibilities. Local usage is the
right default until workflows are proven.

## Prerequisites

- Local CLI and Web UI work.
- You understand secret placement.
- You have completed at least one sandbox workflow.

## Local Is Enough When

- You are learning.
- You are a single user.
- You do not need 24/7 adapters.
- You can start `bun run dev` when needed.
- You use the CLI for local workflows.

## Docker Desktop Local

Use Docker after source mode works:

```bash
git clone https://github.com/coleam00/Archon.git
cd Archon
cp .env.example .env
docker compose up -d
```

On Windows, build from WSL rather than PowerShell if Docker Desktop cannot
follow workspace symlinks.

## VPS Deployment

Delay VPS deployment until after the local capstone.

Core steps:

1. Provision Ubuntu VPS.
2. Create a non-root deployment user.
3. Install Docker and Docker Compose.
4. Clone Archon to `/opt/archon`.
5. Configure `.env` privately.
6. Configure DNS.
7. Open ports 22, 80, and 443.
8. Start Docker Compose profiles.
9. Verify health endpoint.

Do not run Archon as root. Current docs explicitly warn against root usage for
Archon and Claude Code.

## SQLite Versus PostgreSQL

SQLite is the local default and requires no setup.

PostgreSQL is recommended for cloud deployments and team/server use.

## Monitoring And Recovery

Use:

```bash
docker compose ps
docker compose logs -f app
curl http://localhost:3090/health
curl http://localhost:3090/health/db
```

## Expected Result

You should know whether local, Docker, or VPS deployment fits your current
stage.

## Verification Checklist

- Local health checks pass.
- Docker logs can be inspected.
- VPS deployments use a non-root user.

## Common Mistakes

- Exposing the Web UI publicly without auth.
- Running as root.
- Using SQLite for a serious team deployment without considering PostgreSQL.
- Starting with cloud deployment before local workflows work.

## Mini Exercise

Write a deployment decision for yourself:

```text
I will stay local until Capstone 4 passes on a disposable repository.
```

## Completion Checkpoint

Move on when you can explain why VPS deployment is a later step, not the first
step.

## Source References

- `packages/docs-web/src/content/docs/deployment/local.md`
- `packages/docs-web/src/content/docs/deployment/docker.md`
- `packages/docs-web/src/content/docs/deployment/cloud.md`
- `packages/docs-web/src/content/docs/deployment/windows.md`
- `packages/docs-web/src/content/docs/reference/database.md`
- `packages/docs-web/src/content/docs/reference/configuration.md`

---

# Part 13 - Advanced Inspiration

## Learning Objective

Learn from the transcripts without confusing live experiments with supported
core features.

## Why This Matters

The transcripts are valuable because they show real workflow thinking, mistakes,
and experiments. They are risky if treated as current official documentation.

## Prerequisites

- You have read the official docs sections for the feature you want to try.
- You can label a pattern as official, community, or experimental.

## Case Study A - Mixed-Provider Efficiency

Idea: use a stronger reasoning model for planning and a cheaper or faster model
for implementation, validation, or glue.

Risk: wrong provider/model strings, unsupported fields, and noisy comparisons.

Safe experiment: run the same small sandbox issue twice with two explicit
workflow YAML files and compare validation results, time, and review quality.

Transcript sources:

- `Plan with Claude Opus, Build with Kimi K2.6 LIVE Mixed-Provider Benchmark.txt`
- `Pushing My AI Dark Factory to Its Limits with Opus + Kimi Combined.txt`

## Case Study B - Dark Factory Experimentation

Idea: issue intake, triage, implementation, validation, PR review, and possibly
deployment loops.

Risk: too much autonomy too early.

Safe version: issue-to-draft-PR with plan approval and final approval. No
autonomous merge.

Transcript sources:

- `The AI Dark Factory is ALIVE A Codebase That Writes Its Own Code, Live.txt`
- `Pushing My AI Dark Factory to Its Limits with Opus + Kimi Combined.txt`

## Case Study C - Frontend-Specialized Routing

Idea: one model plans accurate content, another generates UI, another handles
integration, and a validator checks the result.

Risk: a pretty UI with broken integration.

Safe version: route only the design draft to the UI-specialized model, then run
deterministic build/test checks and a separate code review.

Transcript source:

- `Claude Plans, Gemini Designs One Workflow for Beautiful Frontends (LIVE).txt`

## Case Study D - Jira-Style Ticket Workflows

Idea: a ticket can become a persistent Archon conversation or workflow entry
point.

Risk: Jira adapter details may be experimental unless official docs add support.

Safe version: manually copy a ticket summary into a GitHub issue or local plan,
then run a supervised workflow.

Transcript source:

- `Archon + Jira Drag a Ticket, Get a Pull Request (Live Build).txt`

## Case Study E - Pi Extensions

Idea: Pi extensions can add specialized review gates, UI flows, and custom
tooling.

Risk: third-party extension trust and unsupported Archon YAML fields.

Safe version: install one extension in a disposable environment, run read-only
analysis first, and keep human approval gates.

Transcript sources:

- `Pi Coding Agent + Archon Build ANY AI Coding Workflow (No Claude Code Bloat).txt`
- `Pi is INCREDIBLE - Building a Custom Coding Agent Live.txt`

## Expected Result

You should have a short list of advanced experiments, each with a safe supervised
version.

## Verification Checklist

- Every experiment has a human gate.
- No experiment is presented as official unless docs confirm it.
- GitHub/Dark Factory experiments stop before autonomous merge.

## Common Mistakes

- Copying live-stream commands without checking current docs.
- Benchmarking providers without controlling the task.
- Installing extension packages without reviewing them.

## Mini Exercise

Pick one case study and rewrite it as a two-node supervised sandbox workflow.

## Completion Checkpoint

Move on when every transcript-derived idea in your notes has a label:
official, community, experimental, historical, or illustrative.

## Source References

- `transcripts/The Next Evolution of AI Coding Is Harnesses - Here's How to Build Them.txt`
- `transcripts/Pi Coding Agent + Archon Build ANY AI Coding Workflow (No Claude Code Bloat).txt`
- `transcripts/Pi is INCREDIBLE - Building a Custom Coding Agent Live.txt`
- `transcripts/Plan with Claude Opus, Build with Kimi K2.6 LIVE Mixed-Provider Benchmark.txt`
- `transcripts/Pushing My AI Dark Factory to Its Limits with Opus + Kimi Combined.txt`
- `transcripts/The AI Dark Factory is ALIVE A Codebase That Writes Its Own Code, Live.txt`
- `transcripts/Claude Plans, Gemini Designs One Workflow for Beautiful Frontends (LIVE).txt`
- `transcripts/Archon + Jira Drag a Ticket, Get a Pull Request (Live Build).txt`

---

# Part 14 - Troubleshooting Guide

## Learning Objective

Diagnose common failures without leaking secrets.

## Why This Matters

Troubleshooting often tempts people to paste logs, env files, or auth files into
chat. A safe diagnostic routine prevents that.

## Prerequisites

- You know where logs and artifacts live.
- You know which files may contain secrets.

| Symptom | Likely cause | Diagnostic command | Safe fix |
| --- | --- | --- | --- |
| `archon` command not found | Bun link path missing | `archon version` | Add Bun bin directory to PATH; rerun `bun link` |
| Bun not found | Bun not installed or shell not reloaded | `bun --version` | Install Bun; reload shell |
| Claude binary not found | Compiled binary needs path | `where claude` or `which claude` | Set `CLAUDE_BIN_PATH` or config path |
| Codex binary not found | Codex CLI not installed or path missing | `codex --version` | Install Codex; set `CODEX_BIN_PATH` or config path if needed |
| Authentication failure | Missing or expired provider credentials | provider CLI status command | Re-login locally; do not paste tokens into chat |
| GitHub clone failure | Missing token or repo permission | `gh auth status` | Fix GitHub auth and token scope |
| Stale worktrees | Old run left environment | `archon isolation list` | `archon isolation cleanup` or `archon complete <branch>` |
| Workflow not discovered | Wrong folder or invalid YAML | `archon workflow list --json` | Put YAML in `.archon/workflows/`; validate |
| Invalid YAML | Syntax error | `archon validate workflows <name>` | Fix indentation and node fields |
| Unknown provider | Provider not configured | `archon validate workflows <name>` | Use `claude`, `codex`, or `pi` as documented |
| Invalid model string | Model ID not supported by provider | provider CLI model list | Replace with verified model ID |
| Missing command file | Workflow references absent command | `archon validate workflows <name>` | Add `.archon/commands/<name>.md` |
| Missing skill directory | Claude-only skill missing | `archon validate workflows <name>` | Install or remove skill reference |
| Missing MCP config | Claude-only MCP path invalid | `archon validate workflows <name>` | Fix config path or remove MCP |
| Approval gate invisible in Web UI | Workflow missing `interactive: true` | inspect YAML | Add workflow-level `interactive: true` |
| Web UI disconnected | Server stopped or port conflict | `curl http://localhost:3090/health` | Restart server; resolve port conflict |
| Port already in use | Stale process | `netstat -ano | findstr :3090` | Kill stale `bun` or `node` process by PID |
| Server not seeing local workflow changes | Server clone has not synced pushed changes | `git status` | Commit and push workflow/command changes |
| Pi auth problem | Pi login/env/model not configured | run `pi`, check local model config | Re-login or fix env privately |
| Secret exposed in terminal history | Token pasted into command | inspect history locally | Rotate token; remove history entry |

## Token Rotation Steps

1. Revoke the exposed token at the provider.
2. Create a new token.
3. Update only private local env files.
4. Restart Archon.
5. Confirm no token is committed:

```bash
git status --short
git diff -- . ':!*.lock'
```

Do not paste the exposed token into an issue, PR, chat, or support request.

## Expected Result

You can diagnose common setup, workflow, provider, GitHub, Web UI, and secret
incidents using supported commands.

## Verification Checklist

- You can get `archon version`.
- You can validate a workflow.
- You can inspect a log tail.
- You can rotate a token if exposed.

## Common Mistakes

- Sharing `~/.codex/auth.json`.
- Using screenshots that reveal tokens.
- Killing active assistant processes when only a stale server process was the
  problem.

## Mini Exercise

Run:

```bash
archon workflow status
archon isolation list
archon validate workflows
```

Then write down where you would look first for a failed run.

## Completion Checkpoint

Move on when you can troubleshoot without exposing secrets.

## Source References

- `packages/docs-web/src/content/docs/reference/troubleshooting.md`
- `packages/docs-web/src/content/docs/reference/security.md`
- `.claude/skills/archon/references/troubleshooting.md`
- `packages/docs-web/src/content/docs/deployment/windows.md`

---

# Part 15 - Capstone Projects

## Learning Objective

Apply the tutorial sequence to four progressively harder projects.

## Why This Matters

Capstones turn reference knowledge into repeatable practice.

## Prerequisites

- Local setup works.
- Sandbox repo exists.
- GitHub sandbox repo exists for Capstone 4.
- Human approval gates are enabled where needed.

## Capstone 1 - Beginner

Goal: run a built-in workflow on the sandbox and inspect results.

```bash
archon workflow run archon-assist --no-worktree "Explain this sandbox repository."
archon workflow status
```

Done when you can explain what ran and where logs live.

## Capstone 2 - Intermediate

Goal: create a custom Plan-Implement-Validate workflow with deterministic tests
and one human approval gate.

Required:

- `.archon/workflows/sandbox-piv.yaml`
- `interactive: true`
- `approval:` node after plan
- `bash:` validation node

Run:

```bash
archon validate workflows sandbox-piv
archon workflow run sandbox-piv --branch capstone/piv "Add subtract and validation."
```

## Capstone 3 - Advanced

Goal: create a mixed-provider workflow with explicit artifacts.

Required:

- Codex exploration node
- Pi/Gemini planning node with verified model ID
- deterministic validation node
- fresh context between provider changes
- artifact handoff through `$ARTIFACTS_DIR`

Do not proceed until each provider works separately.

## Capstone 4 - Supervised GitHub Issue-To-PR

Goal: use GitHub issue intake with human gates and no autonomous merge.

Required:

- disposable GitHub repo
- issue intake
- isolated worktree
- planning artifact
- human plan approval
- implementation
- deterministic validation
- independent review
- final human approval
- pull request creation

Suggested run:

```bash
archon workflow run archon-fix-github-issue --branch capstone/issue-1 "Fix issue #1"
```

Do not enable autonomous merge in the learning version.

## Capstone 5 - Model-Role Guided Project

Goal: complete one guided vibe coding project with explicit model roles.

Required:

- Claude or Codex planning node
- human plan approval
- Gemini, Qwen, Kimi, Codex, or Claude implementation node with verified model
  ID
- deterministic validation node
- Claude or Codex review or test-strategy node
- artifact or explicit node-output handoff across each model boundary
- fallback provider or stop condition

Example role note:

```text
Planner: codex, gpt-5.3-codex, medium reasoning
Inner developer: pi, openrouter/qwen/qwen3-coder
Reviewer: codex, independent from implementation
Fallback: use codex implementation if Pi auth fails; do not skip validation
```

Do not run this capstone in a real repository until the same request works with
one provider first.

## Capstone 6 - Team Remote Operation

Goal: run or simulate a team/server workflow with one exposed interface and
clear operating boundaries.

Required:

- local server, Docker, VPS, or simulated remote runtime
- Web UI, GitHub webhook, Slack, Telegram, or Discord interface selected
- allowed-user or access boundary documented
- secret-handling note
- health endpoint evidence
- workflow status evidence
- log and artifact locations
- rollback or incident response note
- no production deployment and no autonomous merge

Boundary note:

```text
Runtime:
Database:
Interface:
Allowed users:
Secrets:
Health checks:
Logs:
Artifacts:
Rollback:
Stop conditions:
```

This capstone proves operational readiness, not production autonomy.

## Expected Result

After the capstones that match your role, you can safely run a supervised
workflow on a disposable repository and define the boundary for the first real
repository or team/server run.

## Verification Checklist

- Capstone 1: you inspected output and logs.
- Capstone 2: custom PIV validates and pauses.
- Capstone 3: mixed-provider workflow uses explicit artifacts.
- Capstone 4: GitHub PR is created or prepared, but not merged automatically.
- Capstone 5: model roles are explicit and validation is deterministic.
- Capstone 6: runtime boundary, health checks, logs, artifacts, and rollback
  are documented.

## Assessment Rubric

Use this rubric for self-checks, workshops, or team onboarding sign-off.

| Area | Pass | Strong |
| --- | --- | --- |
| Safety | Uses a sandbox, avoids secrets in chat, and keeps human approval before risky changes. | Can explain why each approval gate exists and how to recover from a rejected run. |
| Workflow operation | Runs built-in workflows, checks status, and finds logs and artifacts. | Can diagnose a paused, failed, or abandoned run from CLI output and JSONL logs. |
| Workflow authoring | Creates a valid command and a valid YAML workflow with deterministic validation. | Uses artifacts, fresh context, and conditional or loop nodes only where they reduce real risk. |
| Provider and model-role routing | Runs Codex first and treats Pi/Gemini/Qwen/Kimi model IDs as locally verified configuration. | Separates planning, implementation, validation, and review responsibilities with artifact handoffs and fallback behavior. |
| GitHub practice | Creates or prepares a supervised PR from an issue. | Reviews the PR, documents verification, and refuses autonomous merge while learning. |
| Team/server operation | Can explain where Archon runs, which interface is enabled, and where evidence lives. | Verifies health checks, logs, artifacts, access boundaries, and rollback before broader rollout. |

## Common Mistakes

- Skipping straight to Capstone 4.
- Running mixed-provider workflows before single-provider workflows work.
- Treating a generated PR as merge-ready without human review.
- Exposing a server adapter before access control, secrets, and rollback are
  documented.

## Mini Exercise

After each capstone, write a three-line run report:

```text
What ran:
What changed:
What I verified:
```

## Completion Checkpoint

The learning path is complete when the capstone for your target role produces
secret-free evidence and you can explain every gate in the workflow.

## Source References

- `.archon/workflows/defaults/archon-assist.yaml`
- `.archon/workflows/defaults/archon-piv-loop.yaml`
- `.archon/workflows/defaults/archon-fix-github-issue.yaml`
- `packages/docs-web/src/content/docs/adapters/github.md`

---

# Part 16 - Final Reference Material

## Learning Objective

Keep the operational commands, safety rules, glossary, and source map in one
place.

## Why This Matters

A good reference lets you operate Archon without rereading the full tutorial.

## Prerequisites

You have completed or at least read Parts 0 through 15.

## One-Page Cheat Sheet

```bash
archon version
archon setup
archon workflow list
archon workflow run <workflow> --branch <branch> "<message>"
archon workflow run <workflow> --no-worktree "<read-only message>"
archon workflow status
archon workflow approve <run-id> "approved"
archon workflow reject <run-id> --reason "needs changes"
archon workflow resume <run-id>
archon workflow abandon <run-id>
archon validate workflows <name>
archon validate commands <name>
archon isolation list
archon isolation cleanup
archon complete <branch>
bun run dev
curl http://localhost:3090/health
curl http://localhost:3090/health/db
gh auth status
```

## Safe Operating Checklist

- Use a disposable sandbox first.
- Use `--branch` for modifying workflows.
- Use `--no-worktree` only for read-only tasks.
- Validate workflows before running.
- Put secrets only in Archon-owned env files or provider auth files.
- Keep human plan approval enabled.
- Review PRs before merge.
- Do not expose Web UI publicly without access control.
- Use adapter whitelists.
- Rotate any exposed token immediately.

## Glossary

Artifact: file-based handoff between workflow nodes.

Assistant: coding agent client such as Codex, Claude, or Pi.

Command: Markdown prompt template.

DAG: directed acyclic graph; nodes run according to dependencies.

Provider: Archon execution provider, such as `codex` or `pi`.

Worktree: isolated Git checkout for a branch/run.

Workflow: YAML process definition.

## First Week Practice Plan

Day 1: install, verify, run `archon-assist` on sandbox.

Day 2: inspect worktrees, logs, and artifacts.

Day 3: create one command.

Day 4: create the minimal PIV workflow.

Day 5: add validation and approval.

Day 6: configure GitHub CLI and run a GitHub issue workflow on the sandbox.

Day 7: try a Pi/Gemini read-only analysis workflow.

## What To Learn Next

- Workflow hooks, MCP, and skills if you use Claude nodes.
- Script nodes for deterministic utilities.
- GitHub webhooks for team usage.
- Docker and VPS deployment after local capstones.
- Provider benchmarking on your own repo.

## Expected Result

You have a compact checklist and command set for your first week with Archon.

## Verification Checklist

- You can find the command cheat sheet.
- You can find the source appendix.
- You can explain the safe operating checklist.

## Common Mistakes

- Keeping useful workflows only on one machine and not committing them.
- Forgetting to update docs when a team workflow changes.
- Using transcript experiments without labels.

## Mini Exercise

Adapt the safe operating checklist into your team onboarding notes and remove any
items that do not apply to your environment.

## Completion Checkpoint

The tutorial is complete when you can use the cheat sheet to run, validate,
inspect, and clean up a supervised workflow.

## Source Appendix

Official files and docs:

- `README.md`
- `CONTRIBUTING.md`
- `.archon/workflows/defaults/`
- `.archon/commands/defaults/`
- `.claude/skills/archon/`
- `.claude/skills/archon/references/parameter-matrix.md`
- `.claude/skills/archon/references/troubleshooting.md`
- `packages/docs-web/src/content/docs/getting-started/overview.md`
- `packages/docs-web/src/content/docs/getting-started/installation.md`
- `packages/docs-web/src/content/docs/getting-started/ai-assistants.md`
- `packages/docs-web/src/content/docs/guides/authoring-workflows.md`
- `packages/docs-web/src/content/docs/guides/authoring-commands.md`
- `packages/docs-web/src/content/docs/guides/approval-nodes.md`
- `packages/docs-web/src/content/docs/guides/loop-nodes.md`
- `packages/docs-web/src/content/docs/reference/cli.md`
- `packages/docs-web/src/content/docs/reference/configuration.md`
- `packages/docs-web/src/content/docs/reference/security.md`
- `packages/docs-web/src/content/docs/reference/troubleshooting.md`
- `packages/docs-web/src/content/docs/adapters/web.md`
- `packages/docs-web/src/content/docs/adapters/github.md`
- `packages/docs-web/src/content/docs/adapters/slack.md`
- `packages/docs-web/src/content/docs/adapters/telegram.md`
- `packages/docs-web/src/content/docs/adapters/community/discord.md`
- `packages/docs-web/src/content/docs/deployment/windows.md`
- `packages/docs-web/src/content/docs/deployment/docker.md`
- `packages/docs-web/src/content/docs/deployment/cloud.md`
- `packages/cli/src/cli.ts`
- `packages/providers/src/`
- `packages/server/src/`
- `packages/adapters/src/`

Published docs note:

- `https://archon.diy/llms.txt`, `llms-small.txt`, and `llms-full.txt`
  returned 404 during this review.
- Context7 resolved current docs as `/websites/archon_diy`.

Transcript case studies:

- `The Next Evolution of AI Coding Is Harnesses - Here's How to Build Them.txt`
- `Pi Coding Agent + Archon Build ANY AI Coding Workflow (No Claude Code Bloat).txt`
- `Pi is INCREDIBLE - Building a Custom Coding Agent Live.txt`
- `Plan with Claude Opus, Build with Kimi K2.6 LIVE Mixed-Provider Benchmark.txt`
- `Pushing My AI Dark Factory to Its Limits with Opus + Kimi Combined.txt`
- `The AI Dark Factory is ALIVE A Codebase That Writes Its Own Code, Live.txt`
- `Claude Plans, Gemini Designs One Workflow for Beautiful Frontends (LIVE).txt`
- `Archon + Jira Drag a Ticket, Get a Pull Request (Live Build).txt`
- `🔴LIVE - My AI Coding Workflow has 10x'd Again with Archon - See it in Action.txt`
