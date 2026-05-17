---
description: PIV loop — meta-review of the run; propose concrete AI-Layer improvements for human curation.
argument-hint: (no arguments — reads plan and execution-report artifacts)
---

# PIV System Review

**Workflow ID**: $WORKFLOW_ID

Perform a meta-level analysis of how well this PIV run went, and propose concrete updates to
the codebase's **AI Layer** — the assets that make the codebase easier for an agent to work
on next time.

**This is NOT a code review.** You are not looking for bugs in the code. You are looking for
bugs in the *process* — and turning them into AI-Layer improvements.

## Philosophy

- Good divergence reveals plan limitations → improve the planning prompt.
- Bad divergence reveals unclear requirements or missing context → improve CLAUDE.md / references.
- Repeated friction reveals a missing capability → propose a new command or reference doc.

The output of this phase is a **proposal**, not a committed change. A human curates it at the
system-evolution gate that follows.

---

## Phase 1: LOAD

- Read `$ARTIFACTS_DIR/plan.md` — what was planned.
- Read `$ARTIFACTS_DIR/execution-report.md` — what actually happened, divergences, and the
  friction log.
- Read `$ARTIFACTS_DIR/code-review.md` — what quality issues slipped through.
- Read the target repo's AI Layer to know what already exists and what to propose editing:
  - `CLAUDE.md` (or the repo's equivalent global rules file)
  - `.claude/references/` or `docs/` — on-demand context docs
  - `.claude/commands/` or `.archon/commands/` — existing command prompts

### PHASE_1_CHECKPOINT
- [ ] Plan, execution report, and code review loaded
- [ ] The repo's current AI Layer inventoried (CLAUDE.md, references, commands)

## Phase 2: ANALYZE

### Classify each divergence
From the execution report, classify every divergence:
- **Good divergence** — plan assumed something untrue, a better pattern was found, a security
  or performance issue forced a change.
- **Bad divergence** — explicit constraints ignored, new architecture invented instead of
  following patterns, shortcuts taken, requirements misunderstood.

### Trace root causes
For each bad divergence and each friction-log entry, identify the root cause:
- Was the plan unclear? Where, and why?
- Was context missing from the AI Layer? What, and where should it live?
- Was a check missing that would have caught the issue earlier?
- Was a manual step repeated that should be automated?

Focus on **patterns** — a one-off is not actionable; a repeated problem is.

### PHASE_2_CHECKPOINT
- [ ] Every divergence classified good / bad
- [ ] Root cause traced for each bad divergence and friction point

## Phase 3: GENERATE THE EVOLUTION PROPOSAL

Write `$ARTIFACTS_DIR/system-review.md`. Every proposed change must be **specific and
ready to apply** — include the exact target file and the exact text to add or change, so a
human can approve it at a glance and the system-evolution gate can apply it directly.

```markdown
# System Review — AI Layer Evolution Proposal

## Alignment Score: __/10
[10 = perfect adherence, all divergences justified; 1-3 = major problematic divergences]

## Divergence Analysis
For each divergence:
- divergence: [what changed]
- classification: good / bad
- root cause: [unclear plan / missing context / missing validation / repeated manual step]

## Proposed AI-Layer Changes

Each proposal is numbered so a human can approve, edit, or reject it individually.

### Proposal 1 — UPDATE `CLAUDE.md`
- Why: [the friction or divergence this prevents next time]
- Exact change: [the precise text to add, and where in the file]

### Proposal 2 — UPDATE `<command or reference file>`
- Why: [...]
- Exact change: [...]

### Proposal 3 — CREATE `<new reference or command file>`
- Why: [a manual process or missing context seen 2+ times]
- Proposed content: [outline or full draft]

[List every proposal. If the run was clean and nothing is worth changing, say so explicitly
with "No AI-Layer changes proposed — the run hit no actionable friction."]

## Summary
[1-2 sentences: what the codebase will be better at next time if these are accepted]
```

### PHASE_3_CHECKPOINT
- [ ] `$ARTIFACTS_DIR/system-review.md` written
- [ ] Every proposal names an exact target file and exact change text
- [ ] Proposals are numbered for individual human curation

## Phase 4: REPORT

Summarize: the alignment score, how many AI-Layer changes are proposed, and what the
codebase will be better at if they are accepted. Tell the human the system-evolution gate is
next — they will curate these proposals before any are committed.
