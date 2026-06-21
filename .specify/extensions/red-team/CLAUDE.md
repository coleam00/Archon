# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

A **Spec Kit extension** (not a code project). It ships:

- Two slash commands defined as markdown prompts in `commands/` — `speckit.red-team.run` and `speckit.red-team.gate`
- Extension manifest `extension.yml` (declares commands, hooks, config requirements)
- Project-level config template `config-template.yml` (scaffolded into consumer projects at `.specify/extensions/red-team/red-team-lenses.yml`)
- Cross-repo protocol reference `docs/protocol.md`

There is no source code, no build system, no test runner. The "implementation" of each command IS its markdown file — the host AI agent (Claude Code) executes the prompt directly. Edits to these files are the unit of work.

## Common operations

- **Validate YAML**: `python3 -c "import yaml; yaml.safe_load(open('extension.yml'))"` (and same for `config-template.yml`). The extension fails to install if either is malformed.
- **Bump version**: must update three places in lockstep — `extension.yml` `version:`, `README.md` "Version:" line, and add a `CHANGELOG.md` entry. Tag format: `v<semver>`.
- **Install locally for dogfooding** in a Spec Kit consumer project: `specify extension add --from <path-to-this-repo>`.

## Architecture

### Two-command split (gate vs run)

`speckit.red-team.gate` and `speckit.red-team.run` are deliberately separate. The **gate** is wired as a mandatory `before_plan` hook (see `extension.yml` → `provides.hooks.before_plan`) and is **idempotent + cheap** (keyword scan + filesystem glob). The **run** command is the heavy adversarial-review workflow that dispatches 3–5 sub-agents in parallel.

Don't fold gate logic into run, or vice versa — the gate runs on every `/speckit.plan` invocation; making it expensive breaks that contract. The gate's keyword scan in `commands/red-team-gate.md` §2 is intentionally over-broad: false positive (offer a red team that wasn't strictly needed) is acceptable; false negative (silently waive a required gate) is the failure mode the gate exists to prevent.

### Trigger categories are the contract

Six categories are referenced across `extension.yml`, `config-template.yml`, both command files, `docs/protocol.md`, and `README.md`: `money_path`, `regulatory_path`, `ai_llm`, `immutability_audit`, `multi_party`, `contracts`. **Adding/renaming a category means editing all of these files in lockstep** — they are the wire format consumers depend on.

### Lens catalog schema

The schema for `.specify/extensions/red-team/red-team-lenses.yml` (the file consumers customise) is documented in three places that must stay in sync:
- `config-template.yml` — the scaffolded template, with inline schema comments
- `commands/red-team.md` §2 preconditions — the minimal-required-shape error message
- `README.md` Configuration table

Required fields per lens: `name`, `description`, `core_questions`, `trigger_match`. Optional: `severity_weight` (default 5), `finding_bound` (default 5).

### Hard-and-fast rule: never edit historical SpecKit records

`commands/red-team.md` §7 enforces a non-negotiable rule that the resolution flow MUST refuse to edit `specs/<feature-id>/spec.md`, `plan.md`, `tasks.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`, `checklists/`. These are immutable audit trails. Resolution edits land in **forward-facing canonical** locations only (`04_Functional_Specs/`, `03_Product_Requirements/`, `02_System_Architecture/`, `.specify/memory/constitution.md`). The findings report itself (`specs/<feature-id>/red-team-findings-*.md`) is the only exception — it's owned by this extension. If you change resolution behavior, this rule must hold.

### Parallel adversary dispatch

`commands/red-team.md` §5 specifies that selected lenses dispatch in a **single parallel batch** using the host agent's sub-agent primitive (Claude Code's Agent tool). All calls go in the same tool-use message so they run concurrently. The 30-min wall-clock target for a mid-sized spec depends on this — sequential dispatch breaks the success criteria.

## Conventions for editing command files

- The `description:` frontmatter is what surfaces in command pickers — keep it concise and accurate to behavior.
- Error messages in commands MUST be self-contained (file path + expected location + recovery hint). The `commands/red-team.md` §8 failure-mode table is the source of truth for error wording.
- Section numbering in `commands/red-team.md` is referenced from error messages (e.g. "see §2.2") — renumbering sections requires updating the references.
- Trigger keyword lists in `commands/red-team-gate.md` §2 should err toward over-inclusion. When in doubt, add the keyword.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **spec-kit-red-team** (83 symbols, 77 relationships, 0 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/spec-kit-red-team/context` | Codebase overview, check index freshness |
| `gitnexus://repo/spec-kit-red-team/clusters` | All functional areas |
| `gitnexus://repo/spec-kit-red-team/processes` | All execution flows |
| `gitnexus://repo/spec-kit-red-team/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
