---
title: Archon Tutorial Plan
description: Source inventory, verification decisions, structure, and maintenance notes for the Archon tutorial.
category: learning
audience: [developer, operator]
status: current
sidebar:
  order: 3
---

This planning file records the tutorial structure, source inventory, verification
decisions, and remaining maintenance notes for the Archon practical tutorial.

## Objective

Create a complete, practical, step-by-step tutorial that teaches a learner to use
Archon progressively:

1. Install and verify Archon.
2. Run safe local workflows.
3. Understand worktrees, artifacts, logs, and approval gates.
4. Author commands and YAML workflows.
5. Build supervised Plan-Implement-Validate workflows.
6. Route work across Codex, Claude, Pi, and verified Gemini/Qwen/Kimi/local
   model IDs.
7. Use GitHub issue-to-PR workflows safely.
8. Understand optional adapters and deployment paths.
9. Treat transcript material as case studies, not official behavior.

## Reader And Defaults

- Operating system: Windows-first, with cross-platform commands.
- Recommended Windows mode: WSL2 for full compatibility.
- Interfaces: CLI plus Web UI.
- Assistants: Codex first; Pi for Gemini and other community-provider routing.
- Repository: disposable sandbox before real projects.
- Usage goal: personal local usage first, team usage later.
- Safety posture: human approval gates enabled, no autonomous merge.
- GitHub: included as a first-class path.

## Canonical Tutorial File

- `docs/learning/archon-practical-tutorial.md`
- `docs/learning/archon-curriculum.md`

The top-level `TUTORIAL.md` is intentionally only a landing page so stale
commands do not fork away from the source-backed tutorial.

## Official Source Inventory

Primary repository files:

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

Key documentation pages:

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

Agent-focused references:

- `.claude/skills/archon/references/parameter-matrix.md`
- `.claude/skills/archon/references/troubleshooting.md`
- `.claude/skills/archon/references/repo-init.md`

## Transcript Case Studies

Use these as illustrative or experimental material only:

- `transcripts/The Next Evolution of AI Coding Is Harnesses - Here's How to Build Them.txt`
- `transcripts/Pi Coding Agent + Archon Build ANY AI Coding Workflow (No Claude Code Bloat).txt`
- `transcripts/Pi is INCREDIBLE - Building a Custom Coding Agent Live.txt`
- `transcripts/Plan with Claude Opus, Build with Kimi K2.6 LIVE Mixed-Provider Benchmark.txt`
- `transcripts/Pushing My AI Dark Factory to Its Limits with Opus + Kimi Combined.txt`
- `transcripts/The AI Dark Factory is ALIVE A Codebase That Writes Its Own Code, Live.txt`
- `transcripts/Claude Plans, Gemini Designs One Workflow for Beautiful Frontends (LIVE).txt`
- `transcripts/Archon + Jira Drag a Ticket, Get a Pull Request (Live Build).txt`
- `transcripts/Live - My AI Coding Workflow has 10x'd Again with Archon - See it in Action.txt`

Note: the last filename is normalized here for ASCII readability. The actual
source file in this workspace includes a leading red-circle symbol.

## Verification Decisions

- The current remote default branch was checked with `git remote show origin`;
  it is `dev`.
- Context7 resolved current Archon docs as `/websites/archon_diy`.
- `https://archon.diy/llms.txt`, `llms-small.txt`, and `llms-full.txt` returned
  404 during review.
- Current CLI/source references do not include `archon doctor`; the tutorial
  explicitly tells learners to use supported checks instead.
- `.archon/workflows/defaults/` currently contains 20 workflow YAML files, even
  though some prose still mentions 17 defaults. The tutorial tells learners to
  run `archon workflow list` as the live source of truth.
- Pi is treated as a community provider.
- Gemini, Qwen, Kimi, and local model names must be verified through Pi or the
  configured provider before use. The tutorial does not invent provider model
  IDs.
- GitHub is included in local CLI setup, issue-to-PR exercises, webhook adapter
  setup, security guidance, and capstones.

## Tutorial Structure

Part 0: executive overview and vocabulary.

Part 1: choose the correct starting path.

Part 2: installation and safe verification.

Part 3: first target repository.

Part 4: built-in workflows.

Part 5: worktrees, isolation, artifacts, and logs.

Part 6: custom commands.

Part 7: custom YAML workflows.

Part 8: Plan-Implement-Validate.

Part 9: assistants, providers, and model routing.

Part 10: Pi integration.

Model Role Recipes: practical guided-project routing patterns.

Part 11: GitHub, adapters, and interfaces.

Part 12: local development, Docker, VPS, and deployment.

Part 13: advanced case studies.

Part 14: troubleshooting.

Part 15: capstone projects.

Part 16: final reference material.

## Quality Gates Applied

- Major parts include learning objective, why it matters, prerequisites,
  expected result, verification, common mistakes, mini exercise, completion
  checkpoint, and source references where applicable.
- The tutorial includes a curriculum map with milestones, estimated time, and
  learner outcomes.
- The curriculum guide provides self-study pacing, workshop session plans,
  hybrid delivery notes, facilitator preflight checks, and assessment criteria.
- Capstones include an assessment rubric for self-study, workshops, and team
  onboarding sign-off.
- Secret-handling warnings are included in setup, GitHub, Pi, troubleshooting,
  and operating checklist sections.
- Unsupported or uncertain items are explicitly labeled.
- GitHub usage stops at supervised PR review and does not recommend autonomous
  merge.
- The full tutorial is linked from the top-level `TUTORIAL.md` landing page.

## Maintenance Notes

- Re-run `archon workflow list` before publishing if default workflow count or
  names matter.
- Re-check `packages/docs-web/src/content/docs/getting-started/ai-assistants.md`
  before giving model/provider examples.
- Re-check GitHub adapter docs before documenting webhook events or secrets.
- If `archon.diy/llms*.txt` becomes available later, add it to the source
  appendix after verifying content.
- If direct Gemini, Qwen, or Kimi providers are added, update Parts 9 and 10 and
  Model Role Recipes to distinguish them from Pi routing.

For ongoing upkeep, use:

- [Curriculum Maintenance Guide](/learning/maintenance-guide/)
- [Publishing Checklist](/learning/publishing-checklist/)
- [Version Review](/learning/version-review/)
