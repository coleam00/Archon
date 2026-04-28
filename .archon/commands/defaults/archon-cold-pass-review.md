---
description: Independent cold second-pass PR review — single reviewer, repo-local checklist
argument-hint: (none — reads PR number from ARTIFACTS_DIR/.pr-number)
---

# Cold Pass Review

## Your Role

You are the **first reviewer** of this PR. That is not metaphor — for your purposes,
no one has looked at this code before. You are walking through it fresh, with a
checklist of structural concerns this repo's maintainers have learned to watch for.

Archon's 5-agent review has already run and posted its findings as a PR comment.
You will glance at those findings ONCE, at the end, for deduplication only. They
must not shape where you look during your review. Correlated-attention blind spots
are the entire reason you exist: if you let Archon's report anchor your search, you
become a 6th Archon agent and add no value.

## Phase 1: LOAD

1. Read `$ARTIFACTS_DIR/.pr-number` → `PR`
2. Read `$ARTIFACTS_DIR/.checklist-source` → `SOURCE` (`default` or `repo+default`)
3. Read `$ARTIFACTS_DIR/cold-pass-checklist.md` → the layered checklist. It always contains the universal default; when `SOURCE=repo+default`, the repo-local extension is appended after a `---` separator. Walk both in order.
4. `gh pr diff $PR` → the changes
5. For every file in the diff, `cat <file>` in full (not just the diff context)
6. Do NOT read Archon's artifacts. Do NOT read `$ARTIFACTS_DIR/review/*`.

**Phase 1 checkpoint:**
- [ ] PR number loaded
- [ ] Checklist source loaded
- [ ] Layered checklist loaded (universal default present; repo-local present if `SOURCE=repo+default`)
- [ ] Diff read
- [ ] All modified files read in full
- [ ] Archon artifacts NOT consulted

## Phase 2: ANALYZE

Walk the checklist literally — check each `[ ]` box, one at a time, out loud.
The literal walk is the discipline. Never summarize the checklist. Never skip
an item because it "looks fine."

For each item: `PASS` / `FAIL` / `N/A`. For every `FAIL`, include a file:line
reference and a one-sentence explanation.

**Special attention to one-sided parity.** For every producer/writer touched by
the diff, identify its consumers/readers (grep the codebase if needed) and verify
they are still in sync. This is the #1 shape to hunt for.

**Phase 2 checkpoint:**
- [ ] Every checklist item walked
- [ ] FAILs have file:line refs
- [ ] One-sided parity checks done for every modified writer

## Phase 3: GENERATE

Write `$ARTIFACTS_DIR/cold-pass-findings.md`:

```
# 🧊 COLD PASS: PR #<N>

**Reviewer model:** <state the model you are, e.g., `gpt-5.3-codex` or `claude-opus-4.6` — name the actual model you run as>
**Checklist source:** <`default` or `repo+default` — read from `$ARTIFACTS_DIR/.checklist-source`>
**Verdict:** <APPROVE or REQUEST_CHANGES>

## HIGH
- <file:line> — <finding>

## MEDIUM
- <file:line> — <finding>

## LOW
- <file:line> — <finding>

## Deduplication note

After reading `gh pr view <PR> --comments`, I removed findings Archon already
caught at the same or higher severity. Findings retained below are either new,
or graded higher than Archon did (with reasoning).

## Summary

<One paragraph. If nothing beyond Archon, say: "No additional findings. APPROVE.">
```

**Phase 3 checkpoint:**
- [ ] Findings file exists
- [ ] Verdict line present
- [ ] Dedup note present (even if empty)

## Phase 4: VALIDATE

Check that `cold-pass-findings.md`:
- Has a Verdict line (APPROVE or REQUEST_CHANGES)
- Has a Summary section
- Has a Deduplication note
- Uses file:line refs for all FAILs
