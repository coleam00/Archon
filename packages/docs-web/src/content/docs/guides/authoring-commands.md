---
title: Authoring Commands
description: Write prompt templates that serve as building blocks for AI workflow nodes.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 2
---

This guide explains how to write effective commands for Archon's AI workflow system. Commands are the building blocks of workflows - each command is a prompt template that instructs the AI agent what to do.

## What is a Command?

A command is a **markdown file** that serves as a detailed instruction set for an AI agent. When a workflow executes a step like `- command: investigate-issue`, Archon:

1. Loads the command file from `.archon/commands/investigate-issue.md`
2. Substitutes variables like `$ARGUMENTS` with actual values
3. Sends the entire document as a prompt to the AI
4. The AI follows the instructions and produces output

**Commands are prompts, not code.** They guide AI behavior through clear instructions.

---

## File Format

Commands live in `.archon/commands/` relative to the working directory and are loaded at runtime.

> **CLI vs Server:** The CLI reads commands from wherever you run it (sees uncommitted changes). The server reads from `~/.archon/workspaces/owner/repo/`, which only syncs from the remote before worktree creation — so changes must be committed and pushed for the server to pick them up.

Commands use this structure:

```markdown
---
description: One-line description shown in /commands list
argument-hint: <expected-input-format>
---

# Command Name

**Input**: $ARGUMENTS

---

[Instructions for the AI agent...]
```

### Frontmatter Fields

| Field | Required | Purpose |
|-------|----------|---------|
| `description` | Recommended | Shown in `/commands` list and workflow routing |
| `argument-hint` | Optional | Tells users what input to provide |

---

## The Golden Rule: Artifacts Are Everything

> **The artifact you produce IS the specification for the next step.**

In multi-step workflows, agents don't share memory. The ONLY way to pass information between steps is through **artifacts** - files saved to disk.

```
Step 1: investigate-issue    Step 2: implement-issue
┌─────────────────────┐      ┌─────────────────────┐
│ AI Agent A          │      │ AI Agent B          │
│                     │      │                     │
│ Analyzes issue      │      │ Reads artifact      │
│ Produces artifact ──┼──────┼─> Executes plan     │
│                     │      │                     │
└─────────────────────┘      └─────────────────────┘
        │                            │
        ▼                            │
  $ARTIFACTS_DIR/                    │
  issues/issue-123.md ◄──────────────┘
```

### Why This Matters

- **No shared context**: Each workflow node can run with `context: fresh`
- **Resumability**: If a step fails, the artifact preserves progress
- **Auditability**: Artifacts create a paper trail of AI decisions
- **Handoff quality**: The artifact determines if the next step succeeds

### What Makes a Good Artifact

The artifact must contain **everything the next agent needs**:

| Include | Why |
|---------|-----|
| Problem statement | Next agent needs context |
| Specific file paths + line numbers | No guessing where to look |
| Actual code snippets | Not summaries - real code |
| Step-by-step implementation plan | Actionable without questions |
| Validation commands | How to verify success |
| Edge cases and risks | What to watch out for |

**Bad artifact**: "Fix the authentication bug in the login handler"

**Good artifact**:
````markdown
## Problem
Users get 401 errors when token refresh races with API calls.

## Root Cause
`src/auth/refresh.ts:45` - The refresh lock doesn't wait for in-flight requests.

## Implementation Plan

### Step 1: Add request queue
**File**: `src/auth/refresh.ts`
**Lines**: 45-60

**Current code:**
```typescript
async function refresh() {
  // Current problematic code
}
```

**Change to:**
```typescript
async function refresh() {
  // Fixed code with queue
}
```

### Step 2: Add test
**File**: `src/auth/refresh.test.ts`
**Action**: CREATE

```typescript
describe('refresh', () => {
  it('queues requests during refresh', async () => {
    // Test implementation
  });
});
```

## Validation
```bash
bun run type-check
bun test src/auth/
```
````

---

## Command Structure

### Phase-Based Organization

Break commands into clear phases. This helps the AI:
- Know where it is in the process
- Self-verify before proceeding
- Recover if something fails

```markdown
## Phase 1: LOAD - Get Context

### 1.1 First action
[Instructions...]

### 1.2 Second action
[Instructions...]

**PHASE_1_CHECKPOINT:**
- [ ] Data loaded
- [ ] Context understood
- [ ] Ready to proceed

---

## Phase 2: ANALYZE - Process Information

[...]
```

### Why Phases Work

1. **Chunked reasoning**: AI handles complex tasks better in pieces
2. **Self-verification**: Checkpoints force the AI to validate progress
3. **Debugging**: When something fails, you know which phase
4. **Consistency**: Similar structure across commands = predictable behavior

### Common Phase Patterns

| Phase Name | Purpose | Example Actions |
|------------|---------|-----------------|
| LOAD | Gather inputs and context | Read files, fetch from GitHub, parse arguments |
| EXPLORE | Understand the codebase | Search for patterns, trace code flow |
| ANALYZE | Form conclusions | Root cause analysis, design decisions |
| GENERATE | Produce output | Write artifact, create files |
| VALIDATE | Verify correctness | Run tests, check types, review output |
| COMMIT | Save to git | Stage, commit, push |
| REPORT | Communicate results | Output summary to user |

---

## Checkpoints

End each phase with a checkpoint:

```markdown
**PHASE_2_CHECKPOINT:**
- [ ] Root cause identified with evidence
- [ ] All affected files listed
- [ ] Implementation approach determined
```

### Why Checkpoints Matter

- **Self-regulation**: AI verifies it completed all steps
- **Quality gate**: Prevents rushing to next phase
- **Debugging aid**: Shows where process broke down
- **Documentation**: Records what was accomplished

---

## Variable Substitution

Archon replaces variables in command text before sending to the AI. The most commonly used variables in commands:

| Variable | Value |
|----------|-------|
| `$ARGUMENTS` / `$USER_MESSAGE` | User's input message |
| `$1`, `$2`, `$3` | Positional arguments (direct invocation only) |
| `$ARTIFACTS_DIR` | Pre-created artifacts directory for this workflow run |
| `$BASE_BRANCH` | Base branch (auto-detected or configured) |
| `$DOCS_DIR` | Documentation directory path (default: `docs/`) |
| `$WORKFLOW_ID` | Unique workflow run ID |
| `$CONTEXT` | GitHub issue/PR context (if available) |

See the [Variable Reference](/reference/variables/) for the complete list, including `$LOOP_USER_INPUT`, `$REJECTION_REASON`, node output references, substitution order, and context variable behavior.

### Usage Pattern

Always show the input at the top:

```markdown
# Investigate Issue

**Input**: $ARGUMENTS

---

## Your Mission
[...]
```

This ensures the AI knows exactly what it's working with.

---

## Artifact Conventions

### Where Artifacts Live

Artifacts are stored **outside the repository** in the Archon workspace directory. Use the `$ARTIFACTS_DIR` variable to reference the pre-created artifacts directory for each workflow run:

```
~/.archon/workspaces/owner/repo/artifacts/runs/{workflow-id}/
```

This keeps artifacts out of git and avoids polluting the working tree.

### Naming Conventions

| Artifact Type | Path Pattern |
|---------------|--------------|
| Issue investigation | `$ARTIFACTS_DIR/issues/issue-{number}.md` |
| Free-form investigation | `$ARTIFACTS_DIR/issues/investigation-{timestamp}.md` |
| PR review scope | `$ARTIFACTS_DIR/reviews/pr-{number}/scope.md` |
| Code review findings | `$ARTIFACTS_DIR/reviews/pr-{number}/code-review-findings.md` |

### Instructing the AI to Save

Be explicit about artifact creation:

```markdown
## Phase 4: GENERATE - Create Artifact

### 4.1 Create Directory

```bash
mkdir -p $ARTIFACTS_DIR/issues
```

### 4.2 Write Artifact

Write to `$ARTIFACTS_DIR/issues/issue-{number}.md`:

```markdown
# Investigation: {Title}

**Issue**: #{number}
**Type**: {BUG|ENHANCEMENT}
...
```

**CRITICAL**: This artifact is the ONLY way to pass information to the next
workflow step. Include everything needed for implementation:

- Exact file paths with line numbers
- Actual code snippets (not summaries)
- Step-by-step implementation instructions
- Validation commands
- Edge cases to handle

The implementing agent will work ONLY from this artifact.
```

---

## Writing Effective Instructions

### Be Explicit About Tools

Tell the AI which tools to use:

```markdown
### 2.1 Search for Relevant Code

Use Task tool with subagent_type="Explore":

```
Find all files related to authentication:
- Token handling
- Session management
- Login/logout flows
```

### 2.2 Check Git History

```bash
git log --oneline -10 -- {affected-file}
git blame -L {start},{end} {affected-file}
```
```

### Provide Decision Trees

Help the AI handle different scenarios:

```markdown
### 3.2 Handle Git State

```
┌─ IN WORKTREE?
│  └─ YES → Use it (assume it's for this work)
│
├─ ON MAIN BRANCH?
│  └─ Clean? → Create branch: fix/issue-{number}
│  └─ Dirty? → STOP, ask user to commit/stash
│
└─ ON FEATURE BRANCH?
   └─ Use it (assume it's for this work)
```
```

### Include Error Handling

Tell the AI what to do when things go wrong:

```markdown
## Handling Edge Cases

### Artifact not found
```
Artifact not found at $ARTIFACTS_DIR/issues/issue-{number}.md

Run `/investigate-issue {number}` first.
```

### Code has drifted
```
Code has changed since investigation:

File: src/x.ts:45
- Artifact expected: {snippet}
- Actual code: {different}

Options:
1. Re-run /investigate-issue
2. Proceed with manual adjustments
```
```

---

## Success Criteria

End every command with clear success criteria:

```markdown
## Success Criteria

- **ARTIFACT_COMPLETE**: All sections filled with specific content
- **EVIDENCE_BASED**: Every claim has file:line reference
- **IMPLEMENTABLE**: Next agent can execute without questions
- **COMMITTED**: Artifact saved in git
```

These serve as:
- Final checklist for the AI
- Definition of "done"
- Quality bar for the command

---

## Template: Basic Command

```markdown
---
description: Brief description of what this command does
argument-hint: <expected-input>
---

# Command Name

**Input**: $ARGUMENTS

---

## Your Mission

{1-2 sentences explaining the goal and what success looks like}

**Output artifact**: `$ARTIFACTS_DIR/{category}/{name}.md`

---

## Phase 1: LOAD - Gather Context

### 1.1 Parse Input

{Instructions for understanding the input}

### 1.2 Load Dependencies

{Instructions for loading required context}

**PHASE_1_CHECKPOINT:**
- [ ] Input parsed correctly
- [ ] Required context loaded

---

## Phase 2: PROCESS - Do the Work

### 2.1 Main Action

{Core instructions}

### 2.2 Secondary Action

{Supporting instructions}

**PHASE_2_CHECKPOINT:**
- [ ] Main work completed
- [ ] Results validated

---

## Phase 3: GENERATE - Create Artifact

### 3.1 Artifact Location

```bash
mkdir -p $ARTIFACTS_DIR/{category}
```

**Path**: `$ARTIFACTS_DIR/{category}/{name}.md`

### 3.2 Artifact Content

Write this structure:

```markdown
# {Title}

**Created**: {timestamp}
**Input**: {original input}

## Summary

{Key findings/results}

## Details

{Comprehensive information for next step}

## Next Steps

{What the next agent should do with this}
```

**CRITICAL**: Include everything the next workflow step needs.

**PHASE_3_CHECKPOINT:**
- [ ] Artifact file created
- [ ] All sections populated
- [ ] Information is actionable

---

## Phase 4: COMMIT - Save Work

```bash
git add .
git commit -m "{Descriptive message}"
```

**PHASE_4_CHECKPOINT:**
- [ ] Changes committed

---

## Phase 5: REPORT - Output Results

```markdown
## Complete

**Artifact**: `$ARTIFACTS_DIR/{category}/{name}.md`

### Summary

{Brief results}

### Next Step

Run `/{next-command}` to continue.
```

---

## Success Criteria

- **CONTEXT_LOADED**: Required information gathered
- **WORK_COMPLETE**: Main task accomplished
- **ARTIFACT_SAVED**: Output written to correct location
- **COMMITTED**: Changes saved to git
```

---

## Anti-Patterns to Avoid

### 1. Vague Instructions

Bad:
```markdown
Analyze the code and find the problem.
```

Good:
```markdown
### 2.1 Trace the Error Path

1. Find where the error originates using grep:
   ```bash
   grep -r "ErrorType" src/
   ```

2. Read the file and identify the function:
   ```bash
   cat src/handlers/error.ts
   ```

3. Document the call chain leading to the error.
```

### 2. Missing Artifact Instructions

Bad:
```markdown
## Results

Output your findings.
```

Good:
```markdown
## Phase 4: GENERATE - Create Artifact

Write to `$ARTIFACTS_DIR/issues/issue-{number}.md`:

[Exact template with all required sections]

**CRITICAL**: This artifact is the handoff to the implementing agent.
```

### 3. No Error Handling

Bad:
```markdown
Create the PR.
```

Good:
```markdown
### Create PR

**First, check if PR already exists:**
```bash
gh pr list --head $(git branch --show-current)
```

**If PR exists**: Use existing PR, skip creation.

**If no PR**: Create new PR:
```bash
gh pr create --title "..." --body "..."
```
```

### 4. Assuming Context

Bad:
```markdown
Fix the bug in the file we discussed.
```

Good:
```markdown
### 1.1 Load Artifact

```bash
cat $ARTIFACTS_DIR/issues/issue-{number}.md
```

Extract:
- File paths to modify
- Line numbers for changes
- Expected behavior
```

---

## Testing Your Command

1. **Run it manually**: `bun run cli workflow run {workflow} "test input"`
2. **Check artifact output**: Does it contain everything needed?
3. **Simulate next step**: Can another agent work from just the artifact?
4. **Edge cases**: What happens with bad input? Missing files?

---

## Summary

1. **Commands are prompts** - Write clear instructions for AI agents
2. **Artifacts are the handoff** - The ONLY way to pass data between steps
3. **Use phases** - Break work into verifiable chunks
4. **Be explicit** - Tell the AI exactly what to do, where, and how
5. **Include everything** - The next agent works ONLY from your artifact
