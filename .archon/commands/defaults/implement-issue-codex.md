---
description: Implement the approved public issue fix with Codex
argument-hint: (no arguments - reads preview and investigation artifacts)
---

# Implement Issue With Codex

## Mission

Implement the approved fix for the selected `traefik/traefik` issue. Follow the
preview and investigation artifacts closely. Keep the diff small and avoid unrelated
refactors.

## Inputs

- `$ARTIFACTS_DIR/selected-issue.json`
- `$ARTIFACTS_DIR/investigation.md`
- `$ARTIFACTS_DIR/fix-preview.json`
- current branch prepared by the previous step

## Required work

1. Re-read the target files and verify the investigation still matches reality.
2. Apply the smallest safe fix.
3. Add or update focused tests where possible.
4. Update `$ARTIFACTS_DIR/implementation-summary.json` with the actual changed files,
   tests touched, and implementation notes.

## Constraints

- Do not expand scope beyond the selected small bugfix.
- Do not publish or push the branch in this step.
- If the fix cannot stay small or the root cause is weaker than expected, stop and
  report that clearly in the artifact.

## Output

End with a concise implementation summary and the path to
`$ARTIFACTS_DIR/implementation-summary.json`.
