---
title: The Essential Workflows
description: A catalog of every built-in Archon workflow with usage examples and guidance on when to use each one.
category: book
part: core-workflows
audience: [user]
sidebar:
  order: 4
---

You now know how Archon works. The question becomes: which workflow do I reach for?

Archon ships with workflows for every major development activity. This chapter maps your intent to the right workflow — and gives you enough detail to use each one confidently.

---

## Which Workflow Should I Use?

```
What do you want to do?
│
├── Ask a question or explore the codebase
│   └── archon-assist
│
├── File a bug issue with reproduction evidence
│   └── archon-create-issue
│
├── Fix a bug from a GitHub issue
│   ├── Smart routing (conditional review)   →  archon-fix-github-issue
│   └── Full parallel review (all 5 agents)  →  archon-issue-review-full
│
├── Build a new feature
│   ├── Interactive (3 human approval gates)  →  archon-piv-loop
│   ├── From an idea or description           →  archon-idea-to-pr
│   ├── From an existing plan file            →  archon-plan-to-pr
│   ├── Simple implement + PR                 →  archon-feature-development
│   └── New standalone app (GAN loop)         →  archon-adversarial-dev
│
├── Review or validate a pull request
│   ├── Adaptive (skips irrelevant agents)      →  archon-smart-pr-review
│   ├── All agents, always                      →  archon-comprehensive-pr-review
│   └── Dual-branch validation + E2E testing    →  archon-validate-pr
│
├── Improve codebase architecture
│   └── archon-architect
│
├── Safely refactor or extract code
│   └── archon-refactor-safely
│
├── Create a PRD through structured conversation
│   └── archon-interactive-prd
│
├── Implement a PRD story by story
│   └── archon-ralph-dag
│
├── Build a reusable automation workflow
│   └── archon-workflow-builder
│
├── Generate a Remotion video composition
│   └── archon-remotion-generate
│
└── Resolve merge conflicts
    └── archon-resolve-conflicts
```

---

## Workflow Catalog

### For Questions and Exploration

#### `archon-assist`

The starting point for anything that doesn't fit elsewhere. It runs a single full-capability Claude Code session against your codebase.

**When to use it**: Questions about the codebase, debugging sessions, one-off tasks, general help when no other workflow applies.

```bash
archon workflow run archon-assist "What does the orchestrator do?"
archon workflow run archon-assist "Why are tests failing in the auth module?"
archon workflow run archon-assist "Explain the isolation system to me"
```

**What it produces**: A direct answer. No PR, no artifacts — just the AI working through your question with full access to your code.

---

### For Bug Fixes

#### `archon-fix-github-issue`

The workflow you ran in Chapter 2. Classifies the issue first (bug vs. feature vs. enhancement), then routes to investigation (bugs) or planning (features). Implements, validates, creates a draft PR, runs smart conditional review agents, auto-fixes findings, simplifies changes, and posts a completion report back to the GitHub issue.

**When to use it**: Any GitHub issue. This is your default for bugs, features, and enhancements alike.

```bash
archon workflow run archon-fix-github-issue --branch fix/login-crash "#142"
```

**What it produces**: A draft PR with the fix, conditional review (code review always runs; error handling, test coverage, docs impact, and comment quality run only when needed), auto-fixes applied, and a summary comment on the issue.

---

#### `archon-create-issue`

Investigates a reported bug, attempts to reproduce it using area-specific playbooks (browser, API, CLI, database, and more), and creates a GitHub issue only if it can reproduce the problem — otherwise reports back what was tried and asks for more detail.

**When to use it**: When you've found a bug and want the issue filed with reproduction evidence already attached. For bugs and problems only — the workflow explicitly rejects feature requests and enhancements. Give it your description of what's wrong; Archon classifies the problem area, searches the relevant code, and attempts reproduction before touching GitHub.

```bash
archon workflow run archon-create-issue "The workflow list shows a spinner forever when no workflows exist"
```

**What it produces**: One of two outcomes, determined by whether reproduction succeeds:
- **Reproduced** (or partially reproduced): a GitHub issue with full context — title, structured body using the repo's issue template if one exists, reproduction steps with evidence files (screenshots, command output, logs), suggested labels, and a duplicate-check against existing issues.
- **Not reproduced**: a failure report explaining what was tried, what the investigation found in the code, and next steps to help you provide better reproduction information. No issue is created.

---

#### `archon-issue-review-full`

Fixes a GitHub issue end-to-end — investigate, implement, create a PR — then runs all five review agents in parallel unconditionally before auto-fixing findings and writing a final summary.

**When to use it**: When you need the most thorough review possible and are willing to pay the extra time cost. Unlike `archon-fix-github-issue`, which skips review agents that aren't relevant to the change, this workflow always runs all five agents (code review, error handling, test coverage, comment quality, docs impact) regardless of what changed. Reach for this on high-stakes fixes, security-sensitive changes, or any time you want a complete audit trail rather than a smart-but-partial review.

```bash
archon workflow run archon-issue-review-full "#142"
```

**What it produces**: A draft PR with the fix applied; a full parallel review from all five agents (code-review, error-handling, test-coverage, comment-quality, docs-impact — none skipped); auto-fixes applied for any critical or high findings from the review; and a final summary artifact written by `archon-workflow-summary` covering the decision matrix and follow-up recommendations.

---

### For Feature Development

#### `archon-piv-loop`

A fully interactive Plan-Implement-Validate development cycle that requires human input at three separate gates — explore, plan approval, and validation approval — before it pushes code and creates a draft PR.

**When to use it**: When you want to stay in the driver's seat throughout development. Unlike `archon-idea-to-pr` or `archon-feature-development`, which run autonomously once started, this workflow stops and waits for you at three points: after exploration (you confirm the approach), after planning (you approve the task list), and after implementation (you test and approve the result). Use it for features where the approach isn't obvious, the scope needs negotiation, or you want to review the plan before any code is written. Requires an interactive session — cannot be run as a background job.

```bash
archon workflow run archon-piv-loop "Add paginated export to the reports page"
```

**What it produces**: A `plan.md` artifact in the run's artifact directory, written after the exploration phase and refined based on your feedback; a series of commits (one per task) pushed to the feature branch after you approve the plan; and a draft PR created once you approve the implementation after the built-in code review. The plan file remains as a permanent artifact alongside the PR.

---

#### `archon-idea-to-pr`

End-to-end feature development from a description. Creates a plan, verifies it's still valid against the current codebase, implements, validates, creates a PR, runs five parallel review agents, fixes findings, and posts a final summary.

**When to use it**: You have a feature idea and want Archon to handle everything from plan to reviewed PR.

```bash
archon workflow run archon-idea-to-pr --branch feat/export-csv "Add CSV export to the reports page"
```

**What it produces**: A PR ready for merge — plan artifact, implementation artifact, validation results, five-agent review, and a decision matrix posted as a GitHub comment.

---

#### `archon-plan-to-pr`

The same pipeline as `archon-idea-to-pr` — but it skips the planning phase. It takes an existing plan file and executes it.

**When to use it**: You already have a plan (from a previous `archon-assist` session, an `.agents/plans/` file, or a planning workflow) and want to execute it.

```bash
archon workflow run archon-plan-to-pr --branch feat/export-csv "Execute .archon/plans/csv-export.md"
```

**What it produces**: The same PR and review output as `archon-idea-to-pr`, minus the planning step.

---

#### `archon-feature-development`

A lighter-weight alternative. Two steps: implement from a plan, then create a PR. No review pipeline.

**When to use it**: When you need a quick implement-and-ship without the full review overhead. Good for straightforward changes with an existing plan.

```bash
archon workflow run archon-feature-development --branch feat/update-readme "Implement .archon/plans/readme-update.md"
```

**What it produces**: A PR with committed changes.

---

#### `archon-adversarial-dev`

Builds a new standalone application from a description using a GAN-inspired loop: a Generator writes code sprint by sprint while an Evaluator actively tries to break it, scoring each criterion out of 10 — a sprint only passes when all scores reach 7 or above.

**When to use it**: When you want to build a new application from scratch and have the quality adversarially tested at each step. The Generator and Evaluator run as separate agents with no shared context, so the evaluator has no incentive to be charitable — it runs the code, tries to break it, and scores honestly. The built application ends up in the run's artifact directory, not in your current repository — no PR is opened against your existing code. Not for bug fixes, refactoring, or PR work on an existing codebase.

```bash
archon workflow run archon-adversarial-dev "A task management app with a REST API and a React frontend"
```

**What it produces**: A working application committed to an isolated git repository at `$ARTIFACTS_DIR/app/` (separate from your current repo); a `spec.md` with the full product specification and sprint plan; and a `report.md` summarizing the build result — per-sprint breakdown, criteria scores, retry counts, and instructions for running the finished application. If a sprint fails all retry attempts (default 3), the report records the failure and stops.

---

### For Code Review

#### `archon-smart-pr-review`

Reviews the current PR with adaptive agent selection. Classifies the PR complexity first (trivial/small/medium/large), then runs only the agents that matter for that PR. A three-line typo fix skips test-coverage and docs-impact analysis.

**When to use it**: Most PR reviews. Faster than comprehensive because it skips irrelevant agents.

```bash
archon workflow run archon-smart-pr-review "Review PR #87"
```

**What it produces**: Synthesized review findings, auto-fixes for critical/high issues, and an optional push notification when complete.

---

#### `archon-comprehensive-pr-review`

Always runs all five review agents in parallel — code review, error handling, test coverage, comment quality, and docs impact — regardless of PR size.

**When to use it**: Pre-merge reviews on significant PRs where you want every angle covered. Also useful when you want a consistent baseline for a team review process.

```bash
archon workflow run archon-comprehensive-pr-review "Review PR #87"
```

**What it produces**: Parallel five-agent review, synthesized findings, and auto-fixes applied.

---

#### `archon-validate-pr`

Validates a pull request by running code review on both the base branch (bug present) and feature branch (fix applied), then — for UI changes — running end-to-end browser tests on both branches to confirm the bug reproduces on main and the fix works on the feature branch.

**When to use it**: When you have a PR that fixes a bug and want proof it works — not just a code read. Runs code review on both sides of the change so you can see exactly what regressed vs. what improved. The E2E test step is conditional: it runs only when the PR touches UI code (components, hooks, API routes the frontend consumes, SSE events). For backend-only or non-UI PRs, it stops after code review. Multiple instances can run simultaneously without port conflicts — each run allocates its own ports automatically. Use `archon-fix-github-issue` or `archon-issue-review-full` when you need to *fix* an issue rather than validate a PR that already exists.

```bash
archon workflow run archon-validate-pr "#89"
```

**What it produces**: A validation report (`archon-validate-pr-report`) covering code review findings on both the base branch and feature branch; E2E test results from both branches when the PR is classified as UI-testable (with browser evidence that the bug reproduces on main and the fix holds on the feature branch); and a cleanup confirmation that all test processes were terminated. For non-UI changes, the report covers code review only.

---

### For Codebase Health

#### `archon-architect`

Scans for complexity hotspots (large files, import fan-out, function length), analyzes them with an architectural lens, plans targeted simplifications, makes changes with quality feedback hooks, validates, and opens a PR.

**When to use it**: Periodic codebase health passes. When a specific area has grown unwieldy. When you want principled simplification, not just cleanup.

```bash
archon workflow run archon-architect --branch refactor/simplify-orchestrator "Focus on the orchestrator package"
```

**What it produces**: A PR with targeted simplifications, each justified and independently revertible.

---

#### `archon-refactor-safely`

Splits or extracts code into smaller modules with a layered safety architecture: two read-only analysis nodes map the impact before any file is touched, a hook forces a type-check after every single edit, and a third read-only node verifies no logic was changed before the PR is created.

**When to use it**: When you need to split a large file, extract a module, or decompose a tightly-coupled component — and you cannot afford behavior changes. The analysis and verification phases are denied write access by design, and the execution phase commits one task at a time so each extraction is independently revertible. Not for bug fixes or feature development; not for architectural sweeps or simplification (use `archon-architect` for those). Purely structural: code moves, no logic changes.

```bash
archon workflow run archon-refactor-safely "Split the orchestrator into smaller modules"
```

**What it produces**: A PR with a before/after file structure comparison in the body and one commit per extraction task (each independently revertible); an artifact confirming behavior verification passed (read-only audit that no function logic changed); and validation results showing type-check, lint, format, and tests all pass after the refactor.

---

### For PRD Creation

#### `archon-interactive-prd`

Guides you through three rounds of structured conversation — foundation, research, and scope — before generating a PRD, then validates every technical claim in the document against the actual codebase and edits the file directly to fix any inaccuracies.

**When to use it**: When you want a PRD that reflects real decisions, not guesswork. Unlike autonomous PRD generation, this workflow doesn't write anything until you've answered three sets of questions — who has the problem, what you saw in the research, and what the MVP scope is. The final document is then validated against file paths, API endpoints, database schemas, and UI components before it's handed to you. Requires an interactive session where you can respond to the three conversation gates.

```bash
archon workflow run archon-interactive-prd "Export conversation history as CSV"
```

**What it produces**: A `.prd.md` file saved to the run's artifact directory under `prds/{kebab-name}.prd.md`, with 12 required sections filled from your conversation answers; a `Validation Notes` section at the bottom documenting every technical reference checked against the codebase (file paths, endpoints, DB schemas, UI components) and any corrections that were applied directly to the document.

---

### For PRD Implementation

#### `archon-ralph-dag`

Implements a **product requirements document** (PRD) story by story, in a loop, until all stories pass.

**When to use it**: Executing a PRD end-to-end with iterative progress tracking.

```bash
archon workflow run archon-ralph-dag "Implement .archon/ralph/notifications/prd.md"
```

**What it produces**: Committed stories one by one, a final PR when all stories pass.

---

### For Merge Conflicts

#### `archon-resolve-conflicts`

Fetches the latest base branch, analyzes conflicts, auto-resolves simple cases, and presents options for complex ones. Commits and pushes the resolution.

**When to use it**: Your PR has merge conflicts and you want help resolving them with full codebase context.

```bash
archon workflow run archon-resolve-conflicts "Resolve conflicts on PR #94"
```

**What it produces**: A committed conflict resolution pushed to the PR branch.

---

### For Tooling & Automation

#### `archon-workflow-builder`

Generates a new Archon workflow YAML for your project — scans your existing commands and workflows, extracts structured intent from your description, writes the YAML, validates it, and saves it to `.archon/workflows/`.

**When to use it**: When you want to automate a multi-step process as a reusable workflow for your project. Describe what the workflow should do; Archon will figure out the node types, DAG structure, and trigger phrases. For creating new workflows only — it cannot edit or modify existing ones.

```bash
archon workflow run archon-workflow-builder "Run lint and type-check, then run tests, and post a Slack message with the results"
```

**What it produces**: A validated `.yaml` file saved to `.archon/workflows/{name}.yaml`, immediately usable; the trigger phrases that will invoke it via the router; and the exact `workflow run` command to test it right away.

---

#### `archon-remotion-generate`

Generates or modifies a Remotion video composition in an existing Remotion project — writes React/TypeScript code using Remotion's animation APIs, renders three preview stills, then renders the full video to `out/video.mp4`.

**When to use it**: When you're inside an existing Remotion project directory and want to generate or change a composition with AI assistance. The workflow checks for `src/index.ts` and `src/Root.tsx` at startup and exits immediately if either is missing — it requires a Remotion project, it does not create one. For best results, install the optional `remotion-best-practices` skill first (`npx skills add remotion-dev/skills`), which guides the AI to follow Remotion-specific coding conventions.

```bash
# Run from inside a Remotion project directory
archon workflow run archon-remotion-generate "A 10-second animated title card with a fade-in headline"
```

**What it produces**: Modified or new composition source files in `src/` (using `useCurrentFrame`, `interpolate`, `spring`, and `AbsoluteFill`); three preview still images — `out/preview-early.png`, `out/preview-mid.png`, `out/preview-late.png` — rendered at the start, middle, and late points of the video; and `out/video.mp4` rendered with the h264 codec.

---

## Quick Reference

| Workflow | Use When | Creates PR? | Uses Isolation? |
|----------|----------|-------------|-----------------|
| `archon-assist` | Questions, exploration, debugging | No | No |
| `archon-fix-github-issue` | Fix a GitHub issue (smart routing) | Yes (draft) | Yes |
| `archon-create-issue` | File a bug with automated reproduction | No | No |
| `archon-issue-review-full` | Fix a GitHub issue, full 5-agent review | Yes (draft) | Yes |
| `archon-piv-loop` | Interactive feature development (3 human gates) | Yes (draft) | Yes |
| `archon-idea-to-pr` | Feature from description | Yes | Yes |
| `archon-plan-to-pr` | Execute an existing plan | Yes | Yes |
| `archon-feature-development` | Implement + ship (lightweight) | Yes | Yes |
| `archon-adversarial-dev` | Build a new standalone app from scratch | No | Yes (own repo) |
| `archon-smart-pr-review` | Review current PR (adaptive) | No | No |
| `archon-comprehensive-pr-review` | Review current PR (all agents) | No | No |
| `archon-validate-pr` | Validate a PR: dual-branch review + conditional E2E | No | Yes |
| `archon-architect` | Architectural sweep | Yes | Yes |
| `archon-refactor-safely` | Structural extraction/splitting (no behavior change) | Yes | Yes |
| `archon-interactive-prd` | Create a PRD through 3 conversation rounds | No | No |
| `archon-ralph-dag` | PRD implementation loop | Yes | Yes |
| `archon-workflow-builder` | Generate a new Archon workflow YAML | No | No |
| `archon-remotion-generate` | Generate a Remotion video (existing project required) | No | No |
| `archon-resolve-conflicts` | Resolve merge conflicts | No | No |

---

## Discovering More Workflows

To see all workflows available in your current directory:

```bash
archon workflow list
```

The list shows both Archon's bundled defaults and any custom workflows in your repo's `.archon/workflows/` directory. Custom workflows override bundled ones by name — if you create a workflow named `archon-assist`, it replaces the built-in.

Ready to build your own? In [Chapter 7: Creating Your First Workflow →](/book/first-workflow/), you'll build one from scratch — incrementally, version by version, until you've got a mini version of `archon-idea-to-pr`.

But first, let's cover the isolation system that makes parallel workflows safe. Continue to [Chapter 5: Isolation and Worktrees →](/book/isolation/)
