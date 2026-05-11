# Debug Cookbook

Systematic root cause analysis using hypothesis testing and evidence chains. No guessing — every claim requires proof.

**Input**: `$ARGUMENTS` — error description, GitHub issue number (`#123`), stack trace, or symptom. Optional: `--quick` for surface scan.

---

## Phase 1: CLASSIFY — Parse Input

### 1.1 Determine Input Type

| Type | Description | Action |
|------|-------------|--------|
| Raw symptom | Vague description, error message, stack trace | INVESTIGATE — form hypotheses, test them |
| Pre-diagnosed | Already identifies location/problem | VALIDATE — confirm diagnosis, check for related issues |
| GitHub issue | `#123` or issue number | Fetch with `gh issue view` — extract error messages, repro steps, environment |

### 1.2 Determine Mode

- `--quick` flag present → Surface scan (2-3 Whys, skip git history)
- No flag → Deep analysis (full 5 Whys, git history required)

### 1.3 Restate the Symptom

Parse the input and restate the symptom in one clear sentence. What is actually failing?

Document:
- **What's happening** (the symptom)
- **What's expected** (the desired behavior)
- **When it started** (if known)
- **Reproduction steps** (if available)

**CHECKPOINT**: Input classified. Mode determined (quick/deep). Symptom clearly restated.

---

## Phase 2: HYPOTHESIZE — Form Theories

### 2.1 Generate Hypotheses

Based on the symptom, generate 2-4 hypotheses:

| Hypothesis | What must be true | Evidence needed | Likelihood |
|------------|-------------------|-----------------|------------|
| {H1} | {conditions} | {proof needed} | HIGH/MED/LOW |
| {H2} | {conditions} | {proof needed} | HIGH/MED/LOW |
| {H3} | {conditions} | {proof needed} | HIGH/MED/LOW |

### 2.2 Rank and Select

Start with the most probable hypothesis. If evidence refutes it, pivot to the next one.

**CHECKPOINT**: 2-4 hypotheses generated and ranked.

---

## Phase 3: REPRODUCE — Verify the Problem

Attempt to reproduce before diving into analysis:

1. **Check tests**: Are there failing tests that demonstrate the issue?
2. **Read the code**: Trace the code path described in the symptom
3. **Run commands**: If safe, run the reproduction steps
4. **Check logs**: Look for relevant error output

If you can reproduce it, document exactly how. If you can't, note what you tried.

---

## Phase 4: INVESTIGATE — The 5 Whys

Execute the 5 Whys protocol for your leading hypothesis:

```
WHY 1: Why does [symptom] occur?
→ Because [intermediate cause A]
→ Evidence: `file.ts:123` — {code snippet proving this}

WHY 2: Why does [intermediate cause A] happen?
→ Because [intermediate cause B]
→ Evidence: `file.ts:456` — {proof}

WHY 3: Why does [intermediate cause B] happen?
→ Because [intermediate cause C]
→ Evidence: `file.ts:789` — {proof}

WHY 4: Why does [intermediate cause C] happen?
→ Because [intermediate cause D]
→ Evidence: {proof}

WHY 5: Why does [intermediate cause D] happen?
→ Because [ROOT CAUSE]
→ Evidence: `source.ts:101` — {exact problematic code}
```

**Quick mode**: Stop at 2-3 Whys.
**Deep mode**: Full 5 Whys required.

### Evidence Standards (STRICT)

| Valid Evidence | Invalid Evidence |
|----------------|------------------|
| `file.ts:123` with actual code snippet | "likely includes...", "probably because..." |
| Command output you actually ran | Logical deduction without code proof |
| Test you executed that proves behavior | Explaining how technology works in general |

### Investigation Techniques

**For tracing complex code paths**, launch a `codebase-analyst` agent:

```
Analyze the implementation around: [suspected area / error location]

TRACE:
1. How data flows through the affected code path
2. Entry points that lead to the failure
3. State changes and side effects along the way
4. Contracts between components in the chain

Document what exists with precise file:line references. No suggestions.
```

**For code issues:**
- Grep for error messages, function names
- Read full context around suspicious code
- Check git blame for when/why code was written
- Run the suspicious code with edge case inputs

**For runtime issues:**
- Check environment/config differences
- Look for initialization order dependencies
- Search for race conditions

**For "it worked before" issues:**
```bash
git log --oneline -20
git diff HEAD~10 [suspicious files]
```

**Rules:**
- Stop when you hit code you can change
- Every "because" MUST have evidence
- If evidence refutes a hypothesis, pivot to the next one
- If you hit a dead end, backtrack and try alternative branches

---

## Phase 5: VALIDATE — Confirm Root Cause

### 5.1 Three Tests

| Test | Question | Pass? |
|------|----------|-------|
| Causation | Does root cause logically lead to symptom through evidence chain? | Y/N |
| Necessity | If root cause didn't exist, would symptom still occur? | N required |
| Sufficiency | Is root cause alone enough, or are there co-factors? | Document if co-factors |

If any test fails → root cause is incomplete. Go deeper or broader.

### 5.2 Git History (Deep Mode Required)

```bash
git log --oneline -10 -- [affected files]
git blame [affected file] | grep -A2 -B2 [line number]
```

Document:
- When was the problematic code introduced?
- What commit/PR added it?
- Type: regression / original bug / long-standing

### 5.3 Rule Out Alternatives (Deep Mode)

| Hypothesis | Why Ruled Out |
|------------|---------------|
| {H2} | {evidence that disproved it} |
| {H3} | {evidence that disproved it} |

**CHECKPOINT**: All three tests pass. Git history documented (deep mode). Alternatives ruled out.

---

## Phase 6: FIX OPTIONS — Identify Approaches

For each fix option, document:

### Option 1: {title} (Recommended)

**What to change**: {specific files and modifications}
**Complexity**: LOW / MEDIUM / HIGH
**Risk**: {what could go wrong}

```{language}
// Current (problematic):
{simplified example}

// Required (fixed):
{simplified example}
```

### Option 2: {title}

**What to change**: {specific files and modifications}
**Complexity**: LOW / MEDIUM / HIGH
**Risk**: {what could go wrong}

**Recommendation**: {which option and why}

Provide at least 2 options when possible.

---

## Phase 7: WRITE — Save Artifact

**If from a GitHub issue**: Save to `.claude/archon/issues/issue-{number}.md`
**Otherwise**: Save to `.claude/archon/debug/{date}-{slug}.md`

Create the directory if it doesn't exist.

### Artifact Template

```markdown
# Root Cause Analysis

**Issue**: {description or #number}
**Root Cause**: {one-line actual cause}
**Date**: {YYYY-MM-DD}
**Branch**: {current branch}
**Severity**: Critical / High / Medium / Low
**Confidence**: High / Medium / Low — {reasoning}
**Mode**: Quick / Deep

---

## Symptom

{What's happening — observable behavior}

## Reproduction

{Steps to reproduce, or "Could not reproduce — {what was tried}"}

## Hypotheses

| # | Hypothesis | Likelihood | Verdict |
|---|-----------|------------|---------|
| H1 | {description} | HIGH | CONFIRMED / REJECTED |
| H2 | {description} | MED | REJECTED — {why} |
| H3 | {description} | LOW | REJECTED — {why} |

## Evidence Chain

WHY: {symptom}
↓ BECAUSE: {cause}
  Evidence: `file.ts:123` — {code snippet}

WHY: {cause}
↓ BECAUSE: {deeper cause}
  Evidence: `file.ts:456` — {code snippet}

↓ ROOT CAUSE: {the fixable thing}
  Evidence: `source.ts:789` — {problematic code}

## Validation

| Test | Result |
|------|--------|
| Causation: Root cause → symptom through evidence chain? | PASS |
| Necessity: Without root cause, symptom still occurs? | NO (PASS) |
| Sufficiency: Root cause alone is enough? | YES / Co-factors: {list} |

## Git History

- **Introduced**: {commit hash} — {message} — {date}
- **Author**: {who}
- **Recent changes**: {yes/no, when}
- **Type**: regression / original bug / long-standing

## Affected Files

| File | Lines | Role in the Bug |
|------|-------|-----------------|
| `{path}` | {range} | {how this file contributes} |

## Fix Options

### Option 1: {title} (Recommended)

**Changes**: {specific files and modifications}
**Complexity**: LOW / MEDIUM / HIGH
**Risk**: {what could go wrong}

### Option 2: {title}

**Changes**: {specific files and modifications}
**Complexity**: LOW / MEDIUM / HIGH
**Risk**: {what could go wrong}

## Recommendation

{Which option and why}

## Verification

1. {Test to run}
2. {Expected outcome}
3. {How to reproduce original issue to confirm fix}
```

---

## Phase 8: REPORT — Present and Suggest Next Step

Summarize:
- Root cause in one sentence
- Severity and confidence
- Recommended fix approach

Link to the artifact.

**Next steps**:
- For complex fixes: `/archon-dev plan` (create a plan from the RCA)
- For simple fixes: `/archon-dev implement` (implement directly)
- For GitHub issues: Consider posting the RCA as a comment with `gh issue comment`
