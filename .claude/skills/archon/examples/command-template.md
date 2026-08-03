---
description: Template for a custom Archon command
argument-hint: <describe expected arguments here>
---

# Command Name

**Workflow ID**: $WORKFLOW_ID

---

## Phase 1: LOAD

Gather context and inputs for this command.

- User request: $ARGUMENTS
- Read any artifacts from previous steps: `$ARTIFACTS_DIR/`
- Base branch: $BASE_BRANCH

### PHASE_1_CHECKPOINT
- [ ] User request understood
- [ ] Prior artifacts loaded (if any)
- [ ] Codebase context gathered

## Phase 2: EXECUTE

Do the main work of this command.

[Replace this section with specific instructions for what the AI should do.
Be precise about which tools to use, what files to examine, and what
actions to take.]

### PHASE_2_CHECKPOINT
- [ ] Main work completed
- [ ] Changes validated (type-check, lint, tests as appropriate)

## Phase 3: GENERATE

Write artifacts for downstream steps.

Write your output to `$ARTIFACTS_DIR/output.md` with:
- Summary of what was done
- Key decisions made
- Any issues encountered

### PHASE_3_CHECKPOINT
- [ ] Artifact written to `$ARTIFACTS_DIR/output.md`
- [ ] Artifact contains actionable information for the next step

## Phase 4: REPORT

Provide a concise summary to the user:

1. What was accomplished
2. Key findings or decisions
3. Any blockers or warnings
4. Next steps (if part of a multi-step workflow)
