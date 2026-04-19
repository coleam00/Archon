# Interactive Workflows For Codex

Use this guide when the workflow is interactive and the user is effectively
talking to the workflow through Codex.

Interactive workflows in this repo include:

- `archon-piv-loop-codex`
- `archon-interactive-prd`

## Core Rule

Be a transparent relay.

- show the workflow's latest question or summary directly
- do not rewrite or "improve" the workflow's wording
- pass the user's answer back as directly as possible
- keep operating the run until it pauses again or reaches a terminal state

## Important Boundary

Archon's internal CLI conversation is not the same thing as the current outer
Codex UI thread.

- a pause can be real even if the user did not see a new outer-thread message
- the host must explicitly relay the paused prompt into the current Codex
  conversation
- do not assume Archon's stdout or persisted worker messages are visible to the
  user by themselves

## Basic Loop

1. Launch or continue the workflow and capture:
   - run ID
   - workflow name
   - working path
2. Verify the launched run with `archon workflow status --json`.
3. When the run becomes `paused`, read the latest workflow output.
4. Relay that output directly in the current Codex conversation.
5. When the user answers, record the decision with `archon workflow approve` or
   `archon workflow reject`.
6. Immediately re-check `archon workflow status --json`.
7. Continue with explicit `archon workflow resume <run-id>`.
8. Keep that `workflow resume` process alive while the run is active; use a
   separate terminal for additional status checks.
9. Repeat until the run reaches `paused`, `completed`, or `failed`.

## Commands

```bash
archon workflow status --json
archon workflow approve <run-id> "<user response>"
archon workflow resume <run-id>
archon workflow reject <run-id> "<reason>"
# If the rejection path stays resumable:
archon workflow resume <run-id>
```

## When Paused

When the workflow is paused:

- read the latest assistant output from the run log
- show it directly
- wait for the user
- pass their response through verbatim unless a safety or formatting issue
  requires intervention

If `archon workflow status --json` already includes the exact paused prompt in
`approval.message`, use that first. Fall back to the persisted assistant message
or the run log when you need the exact rendered wording that Archon showed.

Treat the paused fingerprint as:

- `approval.nodeId`
- `approval.iteration`
- `approval.message`

If the workflow pauses again with a new fingerprint, that is a new human
checkpoint even if the wording looks similar.

Do not replace the workflow's structured questions with your own summary.

If the paused node is reviewing a mutable artifact, reopen the current artifact
from disk before you speak for the workflow. For example, a plan-review pause
should use the latest saved plan rather than a stale earlier read.

## When Still Running

Long research or implementation nodes can stay `running` for a while without
needing user input.

- keep checking status on the monitoring cadence
- do not treat "still running" by itself as a problem
- if an attached CLI session is silent for one monitoring interval, poll
  `archon workflow status --json` immediately instead of waiting on PTY output
- if activity stops for the stall window, flag a possible stall and say what
  evidence stopped moving

Important nuance:

- interactive-loop approval metadata can remain present while the run is
  `running`
- that does not mean the workflow is paused again
- only treat the loop as back when the run status itself is `paused`

## Where To Read The Latest Output

Use the per-run JSONL when status alone is not enough:

```bash
find "${ARCHON_HOME:-$HOME/.archon}/workspaces" -name "<run-id>.jsonl" 2>/dev/null
tail -n 40 "<log-file>"
```

Read `log-debugging.md` when you need the full trace.

Remember: finding the prompt in Archon state is not the final step. Repost it in
the current Codex conversation so the user can answer without switching
surfaces.

## Surface Boundaries

- `archon workflow run ...` is the direct CLI surface for this interaction model
- `archon continue ...` follows the same pause-detection and relay loop
- `archon chat ...` is not a persistent multi-turn workflow conversation
- web foreground workflows can resume from natural-language replies in the same thread
- CLI `workflow approve` and `workflow reject` only record the decision
- `archon workflow resume <run-id>` is the live runner process after a human checkpoint
