---
description: Investigate the top deterministic public issue candidate and write investigation artifacts
argument-hint: (no arguments - reads candidate-score artifact)
---

# Investigate Selected Public Issue

Use this command in the `auto-fix-public-issue` workflow.

## Mission

Read `$ARTIFACTS_DIR/candidate-score.json`, pick the highest-scoring candidate with
`eligible: true`, and investigate that issue in `traefik/traefik` deeply enough to
support a one-pass implementation.

This step is strictly read-only. Do not fork, create branches, edit files, push, or
open a pull request.

## Required inputs

- `$ARTIFACTS_DIR/candidate-score.json`
- `gh issue view <number> --repo traefik/traefik --json title,body,labels,comments,url,state`
- Relevant source files and tests in the checked-out repository

## Investigation requirements

1. Confirm the chosen issue is still open and does not obviously require a large
   feature, refactor, or multi-subsystem change.
2. Identify the likely root cause from code, not only from the issue text.
3. List the smallest expected file edits and the most relevant validation commands.
4. Record the main risks that could block safe automation.

## Required artifacts

Write `$ARTIFACTS_DIR/selected-issue.json` with:

```json
{
  "repo": "traefik/traefik",
  "issue_number": 0,
  "title": "",
  "url": "",
  "score": 0,
  "risk_level": "low",
  "selection_reason": ""
}
```

Write `$ARTIFACTS_DIR/investigation.md` with:

- issue summary
- verified code paths and files
- root cause hypothesis
- minimal implementation plan
- planned validation commands
- explicit out-of-scope notes

## Output

End with a concise summary and the two artifact paths only.
