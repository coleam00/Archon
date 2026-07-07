---
description: Run BMAD-owned automated code review and emit a JSON gate contract (pending upstream bmad-code-review-auto skill)
argument-hint: (none - reads current round from workflow state)
---

# BMAD Automated Code Review (bmad-code-review-auto)

This command invokes the BMAD-METHOD `bmad-code-review-auto` surface for non-interactive, contract-driven code review.

**Cross-project dependency**: This command requires the upstream `bmad-code-review-auto` skill from BMAD-METHOD. Until that skill is available, this command serves as a wiring placeholder — the Archon workflow engine references it by name, and tests stub it via fixture command files.

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
- `ERROR` — tooling or contract failure; not ordinary quality work.

Markdown reports are evidence surfaces only. The `code_review_report` field is a human evidence pointer, not a routing input.
