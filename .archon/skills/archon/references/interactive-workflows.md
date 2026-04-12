# Interactive Workflow Guide

Interactive workflows use human-in-the-loop approval gates and interactive loops. When you invoke one, you become a **transparent relay** between the user and the running workflow — not a commentator.

## Identifying Interactive Workflows

A workflow is interactive if it has `interactive: true` in its YAML definition. Key interactive workflows:
- `archon-piv-loop` — Plan-Implement-Validate with iterative feedback
- `archon-interactive-prd` — Guided PRD creation with approval gates

When the user asks to run one of these, follow the protocol below.

## Protocol: Running Interactive Workflows

### 1. Invoke the workflow

Run it in the background as usual:

```bash
archon workflow run <name> "<message>"
```

### 2. Monitor for pause

Check `archon workflow status` periodically. When status changes to `paused`, the workflow is waiting for user input.

### 3. Fetch and relay the output — BE TRANSPARENT

When the workflow pauses, immediately read the log file to get the AI's output:

```bash
# Find the log file
find ~/.archon/workspaces -name "<run-id>.jsonl" 2>/dev/null

# Extract the last assistant message
```

Parse the JSONL log for the last `"type":"assistant"` entry and display its `content` field **directly to the user**. Do not summarize, do not add commentary, do not say "the workflow asked..." — just show the output as if the user is talking to the workflow agent directly.

**DO:**
```
## What I Understand

You want to add a --json flag to workflow status...

## Questions

1. Should the output include...
2. Do you want...
```

**DON'T:**
```
The workflow has paused and is asking you several questions. Here's what it found:
- It discovered that the --json flag is partially implemented
- It's asking about the output format
You can respond with...
```

### 4. Collect user response and resume

When the user responds naturally (answers questions, says "ready", gives feedback), pass their response directly:

```bash
archon workflow approve <run-id> "<user's exact response>"
```

Do not modify, summarize, or enhance the user's response. Pass it through verbatim.

### 5. Repeat until workflow completes

The workflow will alternate between running and pausing. Each time it pauses:
- Read the latest output from the log
- Display it directly
- Wait for the user's response
- Resume with their response

When the workflow finishes (status becomes `completed` or `failed`), report the final result.

## Key Behavior Rules

1. **You are a transparent pipe.** The user should feel like they're talking directly to the workflow agent. Never insert yourself as a middleman with commentary.

2. **Show output verbatim.** The workflow agent's questions, findings, and summaries should appear exactly as written — including markdown formatting, code blocks, and structure.

3. **Pass input verbatim.** The user's responses go directly to the workflow via `workflow approve`. Don't rewrite or "improve" their input.

4. **Don't explain the workflow mechanics.** Don't say "the workflow is now in the explore phase" or "it will pause again after this." The user knows they're in a conversation — let it flow naturally.

5. **Monitor proactively.** Don't wait for the user to ask "what happened?" — check status and relay output as soon as the workflow pauses.

## Approval Commands

```bash
# Approve with feedback (interactive loops)
archon workflow approve <run-id> "your feedback or answers here"

# Reject (cancels the workflow)
archon workflow reject <run-id> "reason for rejection"
```

## Troubleshooting

- **Workflow shows `running` for a long time**: The AI is doing research/implementation. Be patient — check again in a few minutes.
- **Log file not found**: The log is at `~/.archon/workspaces/<owner>/<repo>/logs/<run-id>.jsonl`
- **User wants to cancel**: Run `archon workflow reject <run-id>` or `archon workflow cancel <run-id>`
