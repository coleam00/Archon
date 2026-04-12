---
description: Write a session handoff document for the next agent or session
---

# Handoff: Capture Session State for Continuation

## Objective

Create a structured handoff document that captures everything the next session (or agent) needs to seamlessly continue this work. This is the **Write + Compress** pattern — you're externalizing the session's memory into a persistent file AND compressing it into just the essentials.

## When to Use

- Before ending a long session where work will continue later
- Before hitting context limits (proactive, not reactive)
- When switching from one phase to another (research → implementation)
- When handing off between human and AI, or between AI sessions
- Instead of relying on `/compact` for critical ongoing work

## Process

### 1. Analyze the Current Session

Review everything that happened in this conversation:

- What was the original goal or task?
- What has been completed so far?
- What is still in progress or blocked?
- What key decisions were made and WHY?
- What files were read, created, or modified?
- What errors were encountered and how were they resolved?
- What dead ends were explored (so the next session doesn't repeat them)?

### 2. Gather Current State

```bash
git status
git diff --stat HEAD
git log --oneline -5
git branch --show-current
```

### 3. Write the Handoff Document

Save to: `HANDOFF.md` in the current working directory (or the worktree root if in a worktree).

**Use this exact structure:**

```markdown
# Handoff: [Brief Task Description]

**Date:** [current date]
**Branch:** [current branch name]
**Last Commit:** [hash + message, or "uncommitted changes"]

## Goal

[1-2 sentences: what we're trying to accomplish. Include the original user request or plan reference.]

## Completed

- [x] [Task 1 — brief description of what was done]
- [x] [Task 2 — brief description]
  - [Sub-detail if non-obvious]

## In Progress / Next Steps

- [ ] [Task 3 — what needs to happen next, with enough detail to act on]
- [ ] [Task 4 — include file paths and specific areas to focus on]
- [ ] [Task 5 — any blocked items with explanation of the blocker]

## Key Decisions

Document WHY choices were made, not just what was chosen:

- **[Decision]**: [What was chosen] — [Why, including alternatives rejected]
- **[Decision]**: [What was chosen] — [Why]

## Dead Ends (Don't Repeat These)

- [Approach that was tried and didn't work] — [Why it failed]
- [Investigation path that turned out to be irrelevant] — [What we found instead]

## Files Changed

- `path/to/file.ts` — [what changed and why, 1 line]
- `path/to/new-file.ts` — [NEW: what this file does]
- `path/to/deleted-file.ts` — [DELETED: why it was removed]

## Current State

- **Tests:** [passing/failing — which specific tests and why]
- **Type-check:** [clean/N errors — what kind]
- **Lint:** [clean/N warnings — what kind]
- **Build:** [working/broken]
- **Manual verification:** [what was tested manually, results]

## Context for Next Session

[2-4 sentences: the MOST IMPORTANT thing the next agent needs to know. What's the current situation? What's the biggest risk? What should they do first?]

**Recommended first action:** [Exact command or step to take first]
```

### 4. Confirm and Advise

After writing the handoff:

1. Confirm the file was written with its full path
2. Suggest the next session command:
   ```
   Read HANDOFF.md and continue from where the previous session left off.
   ```
3. If there are uncommitted changes, suggest committing first:
   ```
   /commit
   ```

## Quality Criteria

A good handoff document should:
- Let a fresh agent continue without asking any clarifying questions
- Be under 100 lines (concise, not comprehensive — link to files rather than duplicating content)
- Include enough "why" context that the next agent makes the same decisions
- Explicitly list dead ends to prevent wasted exploration
- Have a concrete "first action" recommendation

## Anti-patterns

- Don't include full file contents — reference paths instead
- Don't include conversation history or debugging transcripts — summarize findings
- Don't be vague ("fix the bug") — be specific ("fix the SSE reconnection in `packages/web/src/hooks/useSSE.ts` by adding exponential backoff after the `onclose` handler")
- Don't skip the "Dead Ends" section — this prevents the most common wasted effort
- Don't forget the "Key Decisions" section — without it, the next agent may reverse your decisions
