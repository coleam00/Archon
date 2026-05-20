---
description: Draft release notes from approved PRs and workflow artifacts
argument-hint: <release, milestone, or PR list>
---

# Documentation Release Notes

**Input**: $ARGUMENTS

---

## Mission

Draft clear user-facing release notes from approved work.

## Process

1. Read PR summaries, docs impact, QA, security, and services artifacts.
2. Separate user-facing changes from internal implementation details.
3. Write `$ARTIFACTS_DIR/docs/release-notes.md`.

## Artifact Format

```markdown
# Release Notes Draft

## Highlights

## New

## Improved

## Fixed

## Known Limitations

## Migration Or Action Required
```

## Output

Return the release notes path.
