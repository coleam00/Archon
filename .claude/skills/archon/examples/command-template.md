---
description: Template for a Codex-safe Archon command
argument-hint: <describe expected arguments here>
---

# Command Name

**Workflow ID**: $WORKFLOW_ID

User request: $ARGUMENTS
Artifacts directory: $ARTIFACTS_DIR
Base branch: $BASE_BRANCH

## Phase 1: Load

Gather the context you actually need:

- read any required files from the repository
- read prior artifacts from `$ARTIFACTS_DIR` if this command depends on earlier steps
- confirm the expected output before making changes

### Phase 1 Checkpoint

- [ ] request understood
- [ ] required inputs loaded
- [ ] expected output identified

## Phase 2: Execute

Perform the main task of this command.

Keep the prompt explicit about:

- what to inspect
- what to change or produce
- how to validate the result

### Phase 2 Checkpoint

- [ ] main task completed
- [ ] relevant validation run or intentionally skipped with reason

## Phase 3: Report

If downstream nodes need durable output, write it into `$ARTIFACTS_DIR/output.md`
with:

- what was done
- key findings or decisions
- blockers or follow-up notes

### Phase 3 Checkpoint

- [ ] durable output written when needed
- [ ] summary ready for the next step or the user
