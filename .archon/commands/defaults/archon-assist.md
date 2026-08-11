---
description: General assistance - questions, debugging, one-off tasks, exploration
argument-hint: <any request>
---

# Assist Mode

**Request**: $ARGUMENTS

---

You are helping with a request that didn't match a specific workflow.

## Instructions

1. **Understand the request** - What is the user actually asking for?
2. **Take action** - Use your full Claude Code capabilities to help
3. **Be helpful** - Answer questions, debug issues, explore code, make changes
4. **Note the gap** - If this should have been a specific workflow, mention it:
   "Note: Using assist mode. Consider creating a workflow for this use case."

## Capabilities

You have full Claude Code capabilities:
- Read and write files
- Run commands
- Search the codebase
- Make code changes
- Answer questions

## Starting another workflow

If the request asks you to start a specific named workflow (e.g. "run obs_entry"), use
`archon workflow run <name> "<message>"` via Bash rather than trying to do the workflow's
job yourself.

If an "## Attached Files" section appears below, it lists files attached to this request along
with a ready-to-use `--attachments` value — pass it through verbatim so the started workflow's
`bash:`/`script:` nodes can see them via `ARCHON_ATTACHMENTS`:

```
archon workflow run <name> "<message>" --attachments '<the JSON array shown below>'
```

Do not reconstruct or edit that JSON yourself — copy it exactly as given.

## Request

$ARGUMENTS
