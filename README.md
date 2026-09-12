<p align="center">
  <img src="assets/logo.png" alt="Archon" width="160" />
</p>

<h1 align="center">Archon</h1>

<p align="center">
  The first open-source harness builder for AI coding. Make AI coding deterministic and repeatable.
</p>

<p align="center">
  <a href="https://trendshift.io/repositories/13964" target="_blank"><img src="https://trendshift.io/api/badge/repositories/13964" alt="coleam00%2FArchon | Trendshift" style="width: 250px; height: 55px;" width="250" height="55"/></a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a>
  <a href="https://github.com/coleam00/Archon/actions/workflows/test.yml"><img src="https://github.com/coleam00/Archon/actions/workflows/test.yml/badge.svg" alt="CI" /></a>
  <a href="https://archon.diy/docs/"><img src="https://img.shields.io/badge/docs-archon.diy-blue" alt="Docs" /></a>
</p>

---

Archon is a workflow engine for AI coding agents. Define your development processes as YAML workflows - planning, implementation, validation, code review, PR creation - and run them reliably across all your projects.

Like what Dockerfiles did for infrastructure and GitHub Actions did for CI/CD - Archon does for AI coding workflows. Think n8n, but for software development.

## Why Archon?

When you ask an AI agent to "fix this bug", what happens depends on the model's mood. It might skip planning. It might forget to run tests. It might write a PR description that ignores your template. Every run is different.

Archon fixes this. Encode your development process as a workflow. The workflow defines the phases, validation gates, and artifacts. The AI fills in the intelligence at each step, but the structure is deterministic and owned by you.

- **Repeatable** - Same workflow, same sequence, every time. Plan, implement, validate, review, PR.
- **Isolated** - Every workflow run gets its own git worktree. Run 5 fixes in parallel with no conflicts.
- **Fire and forget** - Kick off a workflow, go do other work. Come back to a finished PR with review comments.
- **Composable** - Mix deterministic nodes (bash scripts, tests, git ops) with AI nodes (planning, code generation, review). The AI only runs where it adds value.
- **Portable** - Define workflows once in `.archon/workflows/`, commit them to your repo. They work the same from CLI, Web UI, Slack, Telegram, or GitHub.

## What It Looks Like

Here's an example of an Archon workflow that plans, implements in a loop until tests pass, gets your approval, then creates the PR:

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

Tell your coding agent what you want, and Archon handles the rest:

```
You: Use archon to add dark mode to the settings page

Agent: I'll run the archon-idea-to-pr workflow for this.
       → Creating isolated worktree on branch archon/task-dark-mode...
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

> **Most users should start with the [Full Setup](#full-setup-5-minutes)** - it walks you through credentials, installs the Archon skill into your projects, and gives you the web dashboard.
>
> **Already have Claude Code and just want the CLI?** Jump to the [Quick Install](#quick-install-30-seconds).

### Full Setup (5 minutes)

Clone the repo and use the guided setup wizard. This configures credentials, platform integrations, and copies the Archon skill into your target projects.

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
git clone https://github.com/coleam00/Archon
cd Archon
bun install
claude
```

Then say: **"Set up Archon"**

The setup wizard walks you through everything: CLI installation, authentication, platform selection, and copies the Archon skill to your target repo.

### Quick Install (30 seconds)

Already have Claude Code set up? Install the standalone CLI binary and skip the wizard.

**macOS / Linux**
```bash
curl -fsSL https://archon.diy/install | bash
```

> **x64 compatibility:** The macOS/Linux quick install requires AVX2 on x64
> CPUs. Older Intel/AMD hardware and virtual machines that mask AVX2 should use
> the [source installation guide](https://archon.diy/getting-started/installation/#from-source).
> ARM64 quick installs are unaffected.

**Windows (PowerShell)**
```powershell
irm https://archon.diy/install.ps1 | iex
```

**Homebrew**
```bash
brew install coleam00/archon/archon
```

> **Compiled binaries need a `CLAUDE_BIN_PATH`.** The quick-install binaries
> don't bundle Claude Code. Install it separately, then point Archon at it:
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
> The Docker image ships Claude Code pre-installed. See [AI Assistants → Binary path configuration](https://archon.diy/getting-started/ai-assistants/#binary-path-configuration-compiled-binaries-only) for details.

### Start Using Archon

Once you've completed either setup path, go to your project and start working:

```bash
cd /path/to/your/project
claude
```

```
Use archon to fix issue #42
```

```
What archon workflows do I have? When would I use each one?
```

The coding agent handles workflow selection, branch naming, and worktree isolation for you. Projects are registered automatically the first time they're used.

> **Important:** Always run Claude Code from your target repo, not from the Archon repo. The setup wizard copies the Archon skill into your project so it works from there.

## Web UI

Archon includes a web dashboard for chatting with your coding agent, running workflows, and monitoring activity. Run `archon serve` to start it, whichever way you installed. A binary downloads the matching web UI on first run. A source checkout serves the copy you build: run `bun run build:web` once from the repo root, then `archon serve`.

Register a project by clicking **+** next to "Project" in the chat sidebar - enter a GitHub URL or local path. Then start a conversation, invoke workflows, and watch progress in real time.

**Key pages:**
- **Chat** - Conversation interface with real-time streaming and tool call visualization
- **Dashboard** - Mission Control for monitoring running workflows, with filterable history by project, status, and date
- **Workflow Builder** - Visual drag-and-drop editor for creating DAG workflows with loop nodes
- **Workflow Execution** - Step-by-step progress view for any running or completed workflow

**Monitoring hub:** The sidebar shows conversations from **all platforms** - not just the web. Workflows kicked off from the CLI, messages from Slack or Telegram, GitHub issue interactions - everything appears in one place.

See the [Web UI Guide](https://archon.diy/adapters/web/) for full documentation.

## What Can You Automate?

Archon ships with workflows for common development tasks:

| Workflow | What it does |
|----------|-------------|
| `archon-assist` | General Q&A, debugging, exploration - full Claude Code agent with all tools |
| `archon-fix-github-issue` | Classify issue → investigate/plan → implement → validate → PR → smart review → self-fix |
| `archon-create-issue` | Classify problem → gather context → investigate → create GitHub issue |
| `archon-issue-review-full` | Comprehensive fix + full multi-agent review pipeline for GitHub issues |
| `archon-piv-loop` | Guided Plan-Implement-Validate loop with human review between iterations |
| `archon-idea-to-pr` | Feature idea → plan → implement → validate → PR → 5 parallel reviews → self-fix |
| `archon-plan-to-pr` | Execute existing plan → implement → validate → PR → review → self-fix |
| `archon-feature-development` | Implement feature from plan → validate → create PR |
| `archon-adversarial-dev` | Build a complete application from scratch using adversarial development |
| `archon-smart-pr-review` | Classify PR complexity → run targeted review agents → synthesize findings |
| `archon-comprehensive-pr-review` | Multi-agent PR review (5 parallel reviewers) with automatic fixes |
| `archon-validate-pr` | Thorough PR validation testing both main and feature branches |
| `archon-architect` | Architectural sweep, complexity reduction, codebase health improvement |
| `archon-refactor-safely` | Safe refactoring with type-check hooks and behavior verification |
| `archon-interactive-prd` | Create a PRD through guided conversation |
| `archon-ralph-dag` | PRD implementation loop - iterate through stories until done |
| `archon-workflow-builder` | Generate a new Archon workflow YAML for your project |
| `archon-remotion-generate` | Generate or modify Remotion video compositions with AI |
| `archon-resolve-conflicts` | Detect merge conflicts → analyze both sides → resolve → validate → commit |

Archon ships 19 default workflows - run `archon workflow list` or describe what you want and the router picks the right one.

**Or define your own.** Keep a workflow copyable by placing its YAML, commands, and scripts together under `.archon/workflows/<pack>/<workflow>/`; both directory names are yours. The same tree works in target repos and under `~/.archon/workflows/`. Existing flat workflows and shared `.archon/commands/` / `.archon/scripts/` remain supported. Same-named workflow files in your repo override bundled defaults.

See [Authoring Workflows](https://archon.diy/guides/authoring-workflows/) and [Authoring Commands](https://archon.diy/guides/authoring-commands/).

## Add a Platform

The Web UI and CLI work out of the box. Optionally connect a chat platform for remote access:

| Platform | Setup time | Guide |
|----------|-----------|-------|
| **Telegram** | 5 min | [Telegram Guide](https://archon.diy/adapters/telegram/) |
| **Slack** | 15 min | [Slack Guide](https://archon.diy/adapters/slack/) |
| **GitHub Webhooks** | 15 min | [GitHub Guide](https://archon.diy/adapters/github/) |
| **Discord** | 5 min | [Discord Guide](https://archon.diy/adapters/community/discord/) |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Platform Adapters (Web UI, CLI, Telegram, Slack,       │
│                    Discord, GitHub)                     │
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
│  Handler  │  │  Executor  │  │   (Claude / Codex / Pi)  │
│  (Slash)  │  │  (YAML)    │  │                          │
└───────────┘  └────────────┘  └──────────────────────────┘
      │              │                      │
      └──────────────┴──────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│          SQLite / PostgreSQL (14 core tables)           │
│  Codebases • Conversations • Sessions • Workflow Runs   │
│   Isolation Environments • Messages • Workflow Events   │
│    Users • User Identities • Workflow Node Sessions     │
│         Codebase Env Vars • User GitHub Tokens          │
│           User Provider Keys • User AI Prefs            │
│          (+ Better Auth tables, Postgres only)          │
└─────────────────────────────────────────────────────────┘
```

## Documentation

Full documentation is available at **[archon.diy/docs](https://archon.diy/docs/)**.

| Topic | Description |
|-------|-------------|
| [Getting Started](https://archon.diy/getting-started/overview/) | Setup guide (Web UI or CLI) |
| [The Book of Archon](https://archon.diy/book/) | 10-chapter narrative tutorial |
| [CLI Reference](https://archon.diy/reference/cli/) | Full CLI reference |
| [Authoring Workflows](https://archon.diy/guides/authoring-workflows/) | Create custom YAML workflows |
| [Authoring Commands](https://archon.diy/guides/authoring-commands/) | Create reusable AI commands |
| [Configuration](https://archon.diy/reference/configuration/) | All config options, env vars, YAML settings |
| [AI Assistants](https://archon.diy/getting-started/ai-assistants/) | Claude, Codex, and Pi setup details |
| [Deployment](https://archon.diy/deployment/) | Docker, VPS, production setup |
| [Architecture](https://archon.diy/reference/architecture/) | System design and internals |
| [Troubleshooting](https://archon.diy/reference/troubleshooting/) | Common issues and fixes |

**For AI tools:** Point your LLM at [`/llms.txt`](https://archon.diy/llms.txt) for an index of all documentation, [`/llms-full.txt`](https://archon.diy/llms-full.txt) for the complete docs in a single file, or [`/llms-small.txt`](https://archon.diy/llms-small.txt) for a condensed version.

## Telemetry

Archon sends a few anonymous events so maintainers can see which workflows get real usage, on what platforms, and whether runs succeed — and prioritize accordingly. **No PII, ever.** Events: `archon_started` (once per CLI invocation / server boot), `archon_active` (daily heartbeat while a server is running, so long-running installs stay counted), `chat_turn_handled` (each direct AI chat turn — platform, provider, model, duration, and usage totals; never message content), `workflow_invoked` (each workflow start), `workflow_completed` / `workflow_failed` (each run outcome), `workflow_approval_resolved` (each human approve/reject decision — the binary resolution only, never comments or reasons), and `codebase_registered` (a pure count when a project is registered — no name, path, or URL).

**What's collected (categorical only):**
- **Workflow name** — the real name for *bundled* (Archon-authored) workflows; `"custom"` for your own workflows, so private names never leave your machine.
- **Run shape & outcome** — platform (`cli`/`web`/`slack`/…), provider id (plus the model id on `workflow_invoked`), node count, which node types and features are used (loop/approval/script/bash, structured output, persisted sessions, MCP, skills, fresh-context loops), success/failure, duration, a categorical failure reason, and a fixed-enum failure class (`fatal`/`transient`/`unknown` — never raw error text) plus the failed node's type.
- **Chat activity** — one event per direct-chat AI turn with platform, provider, model, duration, and completed/failed. Message content, prompts, and conversation ids are never sent.
- **Aggregate usage** — provider-reported gross input, output, optional cache-read/cache-write token totals (with a flag when those totals are a floor), and cost (USD) per workflow run, plus direct-chat usage and total loop iterations. Numeric totals only — never the content the tokens represent.
- **Machine context** — OS, architecture, Archon version, runtime, whether it's a binary build, and a CI flag.
- **Deployment shape** (server only) — which adapters are enabled (booleans), database kind (`sqlite`/`postgresql`), whether web auth and multi-user mode are on, and the GitHub auth mode. Configuration *values* (tokens, URLs, hosts) are never sent.
- A random install UUID stored at `~/.archon/telemetry-id`. Nothing else.

**What's *not* collected:** your code, prompts, messages, custom workflow names, workflow descriptions, git remotes, file paths, usernames, tokens, AI output, error message text, your IP address, your geographic location — none of it.

**Opt out:** set any of these in your environment:

```bash
ARCHON_TELEMETRY_DISABLED=1
DO_NOT_TRACK=1        # de facto standard honored by Astro, Bun, Prisma, Nuxt, etc.
POSTHOG_API_KEY=off   # off | 0 | false | disabled | "" all disable
```

CI environments (`CI=true`) are auto-disabled — forks running fixtures in GitHub Actions, CircleCI, etc. do not send events.

**Check the current state:** run `archon telemetry status` to see whether telemetry is enabled, why (if not), the install UUID, and the active host. Run `archon telemetry reset` to rotate the install UUID. `archon doctor` also surfaces the current state in its check list.

Shutdown gives pending telemetry a 75 ms flush window, then cancels outstanding requests. Slow or unreachable ingestion can lose events; it does not hold up command exit.

Self-host PostHog or use a different project by setting `POSTHOG_API_KEY` and `POSTHOG_HOST`.

## Contributing

Contributions welcome! See the open [issues](https://github.com/coleam00/Archon/issues) for things to work on.

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a pull request.

## Star History

[![Star History Chart](https://api.star-history.com/chart?repos=coleam00/Archon&type=date&legend=top-left)](https://www.star-history.com/?repos=coleam00%2FArchon&type=date&legend=top-left)

## License

[MIT](LICENSE)


## 🌐 Web Resources & Interactive Index
- [CATEGORY MANAGEMENT209](https://theknowledgequests9.pages.dev/category-management209.html)
- [BATTLE FOR THE GALAXY](https://mindcampus-es.pages.dev/battle-for-the-galaxy.html)
- [CATEGORY HAPARA](https://eduquests.pages.dev/category-hapara.html)
- [BUS STOP COLOR JAM](https://brainquestses.pages.dev/bus-stop-color-jam.html)
- [DEATH BALL](https://mindquest-zh.pages.dev/death-ball.html)
- [CATEGORY FLASH](https://jangkhangkr.pages.dev/category-flash.html)
- [SWORD RUN 3D](https://brainquestsfr.pages.dev/sword-run-3d.html)
- [3D BASKETBALLIO DUNK SPORT](https://quizzesarena.web.app/3d-basketballio-dunk-sport.html)
- [CATEGORY AGILITY 3](https://brainquestses.pages.dev/category-agility-3.html)
- [SCP 173 ESCAPE](https://brainquestsfr.pages.dev/scp-173-escape.html)
- [MEME MYTHWUKONG](https://thestudyquests9.pages.dev/meme-mythwukong.html)
- [WONDERS OF EGYPT MATCH](https://brainquestspt.pages.dev/wonders-of-egypt-match.html)
- [GOOD SORT MASTER TRIPLE MATCH](https://brainquestsfr.pages.dev/good-sort-master-triple-match.html)
- [BMG CRASHDAY 2025](https://theplayandlearns9.pages.dev/bmg-crashday-2025.html)
- [IDLE HOTEL EMPIRE](https://thelearnplays-pt.pages.dev/idle-hotel-empire.html)
- [CATEGORY GOGUARDIAN](https://thestudyquests-ja.pages.dev/category-goguardian.html)
- [STICKMAN JAILBREAK STORY](https://brainquestsfr.pages.dev/stickman-jailbreak-story.html)
- [FOOTBALL LEGENDS 2026](https://brainquestsfr.pages.dev/football-legends-2026.html)
- [MR THROW](https://thestudyquests9.pages.dev/mr-throw.html)
- [ZOO ANOMALY SIMULATION](https://quizzesarena.onrender.com/zoo-anomaly-simulation.html)
- [CATEGORY SPOT THE DIFFERENCE6](https://brainquest-hi.pages.dev/category-spot-the-difference6.html)
- [CATEGORY HALLOWEEN45](https://quizzesarena.onrender.com/category-halloween45.html)
- [CATEGORY CASUAL 11](https://quizzesarena.onrender.com/category-casual-11.html)
- [CATEGORY COLLECT565](https://brainquest-hi.pages.dev/category-collect565.html)
- [CATEGORY MMO24](https://eduquest-ko.pages.dev/category-mmo24.html)
- [CATEGORY LOVE12](https://brainquestsfr.pages.dev/category-love12.html)
- [CYBER ARROW](https://eduquestsfr.pages.dev/cyber-arrow.html)
- [CANDY MATCH 4](https://eduquestkr.pages.dev/candy-match-4.html)
- [MEDIEVAL ESCAPE](https://themindquests9.pages.dev/medieval-escape.html)
- [CATEGORY POOL 3](https://eduquestses.pages.dev/category-pool-3.html)
- [CATEGORY SNIPER](https://studyarcade-vi.pages.dev/category-sniper.html)
- [AVENGER GUARD](https://brainquestsfr.pages.dev/avenger-guard.html)
- [STICKMAN MINERS WARS](https://eduquestkr.pages.dev/stickman-miners-wars.html)
- [KINGS AND QUEENS MAHJONG](https://thebrainquests9.pages.dev/kings-and-queens-mahjong.html)
- [SUM MASTER](https://thebrainquests9.pages.dev/sum-master.html)
- [BALLERINA CAPPUCCINA FIRST DATE](https://thelearnquests9.pages.dev/ballerina-cappuccina-first-date.html)
- [FASHION HEROES ACADEMY](https://brainquestsfr.pages.dev/fashion-heroes-academy.html)
- [CATEGORY MATCH 3](https://eduplay-es.pages.dev/category-match-3.html)
- [CATEGORY IDLE448](https://learnplay-pt.pages.dev/category-idle448.html)
- [PORTAL HOP](https://brainquestspt.pages.dev/portal-hop.html)
- [ARROW SLIDE PUZZLE](https://brainquestsfr.pages.dev/arrow-slide-puzzle.html)
- [CATEGORY MAKEUP51](https://brainquest-hi.pages.dev/category-makeup51.html)
- [THE BODYGUARD](https://theplayandlearns9.pages.dev/the-bodyguard.html)
- [COLOR MIX JELLY MERGE](https://theplayandlearns9.pages.dev/color-mix-jelly-merge.html)
- [STALKER STRIKE](https://brainquestsfr.pages.dev/stalker-strike.html)
- [CATEGORY QUIZ40](https://quizzesarena.web.app/category-quiz40.html)
- [COINS](https://eduquest-ko.pages.dev/coins.html)
- [BACK 2 SCHOOL MAKEOVER](https://brainquest-hi.pages.dev/back-2-school-makeover.html)
- [KISS O NECK](https://brainquestsfr.pages.dev/kiss-o-neck.html)
- [MUSCLE CHALLENGE](https://eduquest-ko.pages.dev/muscle-challenge.html)
- [FUN SORTING THROUGH THE SHELVES](https://eduquestkr.pages.dev/fun-sorting-through-the-shelves.html)
- [CATEGORY FREE](https://theeduquests9.pages.dev/category-free.html)
- [POPCORN STACK](https://brainquestses.pages.dev/popcorn-stack.html)
- [MAX CRUSHER 2 DESTRUCTION DRIFT AND RACING](https://thebrainquests9.pages.dev/max-crusher-2-destruction-drift-and-racing.html)
- [EMOJI SORT FUN PUZZLE GAME](https://eduplay-es.pages.dev/emoji-sort-fun-puzzle-game.html)
- [CATEGORY DEFENSE176](https://quizzesarena.onrender.com/category-defense176.html)
- [TIP TAP](https://thestudyquests9.pages.dev/tip-tap.html)
- [DRAW TO KILL](https://eduquestsjp.pages.dev/draw-to-kill.html)
- [JEWEL MONSTERS](https://eduquestkr.pages.dev/jewel-monsters.html)
- [INDEX31](https://eduquestsjp.pages.dev/index31.html)
- [PHONE CASE DIY 5](https://eduquestses.pages.dev/phone-case-diy-5.html)
- [MURDER MYSTERY](https://thelearnquests9.pages.dev/murder-mystery.html)
- [BUILDING MODS FOR MINECRAFT](https://eduquestsjp.pages.dev/building-mods-for-minecraft.html)
- [CATEGORY PARTY23](https://learnquest-ru.pages.dev/category-party23.html)
- [EASTER SHADOW MATCH](https://eduquestses.pages.dev/easter-shadow-match.html)
- [INDEX16](https://thebrainquests9.pages.dev/index16.html)
- [CATEGORY JIGSAW10](https://learnquest-ru.pages.dev/category-jigsaw10.html)
- [INDEX7](https://eduquestsjp.pages.dev/index7.html)
- [SAVE HER TOUR](https://thelearnquests9.pages.dev/save-her-tour.html)
- [NOSE HOSPITAL](https://brainquestsfr.pages.dev/nose-hospital.html)
- [CATEGORY HERO72](https://themindquests9.pages.dev/category-hero72.html)
- [WATER SORT PUZZLE 3](https://studyarcade-vi.pages.dev/water-sort-puzzle-3.html)
- [HORROR SCHOOL DETECTIVE STORY](https://quizzesarena.web.app/horror-school-detective-story.html)
- [CATEGORY SURVIVAL366](https://learnplay-pt.pages.dev/category-survival366.html)
- [TERRA CRAFT WORLD](https://brainquestspt.pages.dev/terra-craft-world.html)
- [SHELL STRIKERS](https://learnquest-ru.pages.dev/shell-strikers.html)
- [CATEGORY PUZZLE 2](https://brainquestses.pages.dev/category-puzzle-2.html)
- [BYEPASSHUB](https://brainquestspt.pages.dev/byepasshub.html)
- [CATEGORY THINKY](https://theplayandlearns9.pages.dev/category-thinky.html)
- [TILE SORT MATCH 3](https://brainquestspt.pages.dev/tile-sort-match-3.html)
- [MAD TRUCK](https://eduquestsjp.pages.dev/mad-truck.html)
- [CIRCLE SHOOTER MASTER](https://thelearnquests9.pages.dev/circle-shooter-master.html)
- [FISH FEEDING](https://eduquest-ko.pages.dev/fish-feeding.html)
- [ENERGY SUPERMAN 3D](https://eduquestses.pages.dev/energy-superman-3d.html)
- [HALLOWEEN MATCH TRIO](https://eduquestkr.pages.dev/halloween-match-trio.html)
- [STICKMAN RESCUE DRAW 2 SAVE](https://brainquestspt.pages.dev/stickman-rescue-draw-2-save.html)
- [CATEGORY CARE](https://themindquests9.pages.dev/category-care.html)
- [STICK WAR SAGA](https://eduquestses.pages.dev/stick-war-saga.html)
- [SCALA 40](https://theeduquests9.pages.dev/scala-40.html)
- [CATEGORY BIKE](https://learnplay-pt.pages.dev/category-bike.html)
- [ARROW COUNT MASTER](https://brainquestsfr.pages.dev/arrow-count-master.html)
- [ARROW SURVIVAL 15 SECONDS](https://eduquestsjp.pages.dev/arrow-survival-15-seconds.html)
- [STRIKE FORCE ACTION PLATFORMER](https://brainquestspt.pages.dev/strike-force-action-platformer.html)
- [MY CITY HOSPITAL](https://eduquestses.pages.dev/my-city-hospital.html)
- [CATEGORY 3 PLAYER26](https://thelearnquests9.pages.dev/category-3-player26.html)
- [SAVE THE BEAUTY](https://thestudyquests9.pages.dev/save-the-beauty.html)
- [CATEGORY PUZZLE 2](https://learnquest-ru.pages.dev/category-puzzle-2.html)
- [BROTHERFOLLOW ME MERGE MEN](https://eduquestsfr.pages.dev/brotherfollow-me-merge-men.html)
- [CATEGORY ART](https://learnplay-pt.pages.dev/category-art.html)
- [AIM NINJA](https://theplayandlearns9.pages.dev/aim-ninja.html)
- [SHOOT THE BOTTLE](https://eduquestses.pages.dev/shoot-the-bottle.html)
- [CARS VS ZOMBIES](https://theeduquests9.pages.dev/cars-vs-zombies.html)
- [CATEGORY MONSTER206](https://learnquest-ru.pages.dev/category-monster206.html)
- [TCG CARD CLICKER](https://brainquestsfr.pages.dev/tcg-card-clicker.html)
- [MOTO STUNTS DRIVING RACING](https://eduquestsfr.pages.dev/moto-stunts-driving-racing.html)
- [GEAR WARS](https://eduquestsfr.pages.dev/gear-wars.html)
- [SMASH THE CAR TO PIECES](https://brainquestspt.pages.dev/smash-the-car-to-pieces.html)
- [INDEX12](https://themindquests9.pages.dev/index12.html)
- [CATEGORY SPEED158](https://learnquest-ru.pages.dev/category-speed158.html)
- [BLOCK BLAST JEWEL PUZZLE](https://brainquestspt.pages.dev/block-blast-jewel-puzzle.html)
- [BOMBER FRIENDS](https://theplayandlearns9.pages.dev/bomber-friends.html)
- [CATEGORY HORROR 3](https://brainquestspt.pages.dev/category-horror-3.html)
- [NINJA OBBY PARKOUR](https://brainquestspt.pages.dev/ninja-obby-parkour.html)
- [CATEGORY SOCCER 3](https://quizzesarena.onrender.com/category-soccer-3.html)
- [VIBE COLOURING](https://brainquestspt.pages.dev/vibe-colouring.html)
- [CATEGORY CASUAL 2](https://brainquestspt.pages.dev/category-casual-2.html)
- [FROGGY HOP](https://thelearnquests9.pages.dev/froggy-hop.html)
- [CATEGORY 3D1 371](https://brainquestspt.pages.dev/category-3d1-371.html)
- [MY PURRFECT CAT HOTEL](https://eduquestsfr.pages.dev/my-purrfect-cat-hotel.html)
- [SUSTAINABLE](https://thestudyquests9.pages.dev/sustainable.html)
- [ARROWS PUZZLE ESCAPE](https://theplayandlearns9.pages.dev/arrows-puzzle-escape.html)
- [CAPYBARA JUMP](https://brainquest-hi.pages.dev/capybara-jump.html)
- [INDEX28](https://brainquestspt.pages.dev/index28.html)
- [INDEX41](https://eduquestsjp.pages.dev/index41.html)
- [CATEGORY INTERSTELLARUNBLOCKER](https://theeduquests9.pages.dev/category-interstellarunblocker.html)
- [CATEGORY MANAGEMENT209](https://learnquest-ru.pages.dev/category-management209.html)
- [TRAVEL STORY MATCH](https://theeduquests9.pages.dev/travel-story-match.html)
- [MATCHING PUZZLE](https://brainquestspt.pages.dev/matching-puzzle.html)
- [BUBBLE PLOPPER](https://brainquestsfr.pages.dev/bubble-plopper.html)
- [DICE FUSION](https://eduquestkr.pages.dev/dice-fusion.html)
