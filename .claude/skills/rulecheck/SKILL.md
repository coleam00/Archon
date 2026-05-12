---
name: rulecheck
description: |
  Autonomous rule adherence checker. Scans the codebase for rule violations,
  fixes the highest-impact ones in an isolated worktree, runs full validation,
  creates a PR. Uses memory to track progress across runs.
disable-model-invocation: true
agent: rulecheck-agent
argument-hint: "[focus area]"
---

# Rulecheck

Launch the rulecheck-agent to autonomously scan and fix CLAUDE.md rule violations.

## Your Job (Main Agent)

You are the orchestrator. Your ONLY job is to launch the rulecheck-agent and
report its results when it completes. You do NOT do the scanning or fixing yourself.

1. **Launch the rulecheck-agent** with the focus area (if any): `$ARGUMENTS`
2. **Wait for it to complete** — do NOT poll, tail, or check on it. You will be
   notified automatically when it finishes.
3. **Report ONLY what the agent told you** — relay its final message verbatim
   or summarize it. Do NOT search for PRs, read files, or fabricate results.
   If the agent hit its context limit, say so. If it didn't produce a PR URL
   in its output, don't go looking for one.

## Rules for You

- **Do NOT scan the codebase yourself** — that's the agent's job
- **Do NOT grep, read source files, or run linters** — the agent handles all of that
- **Do NOT edit any files** — you are the orchestrator, not the fixer
- **Do NOT try to resume or check on the agent** while it's running — just wait
- **Do NOT do the agent's work if it fails or hits context limits** — report the failure to the user and stop. NEVER pick up where the agent left off. You are not in a worktree and would be editing main directly.
- **Do NOT update project memory** — the agent maintains its own memory at `.claude/agent-memory/rulecheck-agent/`. Do not duplicate run results into your project memory.
- Trust the agent. It runs in an isolated worktree and will create a PR when done.
