---
description: General Codex assistance - questions, debugging, one-off tasks, exploration
argument-hint: <any request>
---

# Codex Assist Mode

**Request**: $ARGUMENTS

---

You are helping with a request that did not match a more specific Codex-safe
workflow.

## Instructions

1. **Understand the request** - Identify whether this is a question, debugging
   task, repo exploration, a one-off change, or a CI/problem investigation.
2. **Ground yourself in the repo** - Search the codebase, read the relevant
   files, and understand the current implementation before acting.
3. **Read repo guidance explicitly when needed**
   - Read `AGENTS.md` if it exists.
   - Read `CLAUDE.md` if it exists and the task depends on repo conventions,
     architecture guidance, or workflow rules stored there.
   - Do not assume `CLAUDE.md` was automatically loaded by Codex.
4. **Use Codex capabilities directly** - Read and edit files, run commands,
   inspect git state, and validate relevant changes.
5. **Call out routing gaps** - If this should have been a narrower Codex
   workflow, mention:
   "Note: Using archon-assist-codex. Consider creating or using a more specific
   Codex workflow for this use case."

## Workflow Log Debugging

When the request is mainly about a failed, paused, or confusing workflow run:

1. **Check the active surface first**
   - Terminal or server output for Archon runtime logs
   - Web UI run details or `archon workflow status --verbose` for current run
     state
2. **Open the raw per-run JSONL when you need the full trace**
   - Default path:
     `~/.archon/workspaces/<owner>/<repo>/logs/<run-id>.jsonl`
   - If `ARCHON_HOME` is set, use that base directory instead of `~/.archon`
3. **Increase verbosity when current output is too thin**
   - `archon --verbose workflow run <workflow-name> "..."`
   - `LOG_LEVEL=debug <archon command>` for Archon process logs
4. **Use the detailed reference for repeated log analysis**
   - Read `.claude/skills/archon/references/log-debugging.md`

## Guardrails

- Prefer small, reversible changes.
- Use project-defined validation commands when relevant.
- Report validation failures honestly.
- Do not rely on Claude-only workflow-node features such as `skills`, `hooks`,
  `mcp`, `allowed_tools`, or `denied_tools`.
- If the user explicitly wants the Claude-oriented assist lane instead, say so
  and route them to `archon-assist`.

## Capabilities

You have full Codex capabilities as configured by Archon:
- Read and write files
- Run commands
- Search the codebase
- Make code changes
- Answer questions

## Request

$ARGUMENTS
