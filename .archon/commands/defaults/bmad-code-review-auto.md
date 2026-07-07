---
description: Run BMAD-owned automated code review and emit a JSON gate contract. Requires the upstream bmad-code-review-auto skill from BMAD-METHOD.
argument-hint: (none - reads current round from workflow state)
---

# BMAD Automated Code Review (bmad-code-review-auto)

This command invokes the BMAD-METHOD `bmad-code-review-auto` surface for non-interactive, contract-driven code review.

## Upstream dependency

This command requires the upstream `bmad-code-review-auto` skill from BMAD-METHOD (`.agents/skills/bmad-code-review-auto/SKILL.md`).

**If the upstream skill is not present in the current project, you MUST emit a contract with `gate: "ERROR"` and stop.** Do not attempt to perform a review using this command's description as a substitute for the real BMAD review semantics. The Archon workflow engine owns routing; this command owns review semantics, and those semantics come from BMAD-METHOD, not from this file.

## Contract

This command emits a JSON gate contract (`code-review-auto.gate.json`) as its structured output. Downstream routing reads ONLY the JSON contract fields, never the markdown review report.

Required output shape:

```json
{
  "contract_version": "1.0",
  "workflow": "bmad-dev-story-with-tea-fix-loop-v2",
  "node": "code-review-auto",
  "gate": "PASS | FAIL | CONCERNS | ERROR",
  "round": 1,
  "findings_count": 0,
  "open_findings_file": "path",
  "decision_log_file": "path",
  "code_review_report": "path",
  "story_ref": "canonical-story-key"
}
```

Gate vocabulary:

- `PASS` — review completed, no blocking findings.
- `FAIL` — review completed, blocking findings remain for dev-story.
- `CONCERNS` — non-blocking concerns noted; does not trigger rework.
- `ERROR` — tooling or contract failure; not ordinary quality work. Use this when the upstream `bmad-code-review-auto` skill is missing.

Markdown reports are evidence surfaces only. The `code_review_report` field is a human evidence pointer, not a routing input.
