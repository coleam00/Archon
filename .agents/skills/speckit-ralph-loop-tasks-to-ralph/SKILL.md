---
name: speckit-ralph-loop-tasks-to-ralph
description: Convert spec-kit tasks.md to ralph prd.json + progress.txt and print
  run command
compatibility: Requires spec-kit project structure with .specify/ directory
metadata:
  author: github-spec-kit
  source: ralph-loop:commands/speckit-tasks-to-ralph.md
---

You are wiring up the ralph external-bash-loop for a spec-kit feature.

1. Resolve the feature argument:
   - If "$ARGUMENTS" is non-empty, set FEATURE to "$ARGUMENTS" verbatim.
   - Otherwise, read `.specify/feature.json` and set FEATURE to the value of `feature_directory` with any leading `specs/` stripped (e.g. `specs/004-sessions-memory-auth` → `004-sessions-memory-auth`). If the file is missing, unreadable, or has no `feature_directory`, surface that error and STOP.
2. Run: `bash .specify/extensions/ralph-loop/scripts/bash/tasks-to-prd.sh "$FEATURE"`
3. If exit 0: print the bash invocation block from stdout VERBATIM.
4. If non-zero: surface the error to the user and STOP. Do not retry.

Do NOT modify tasks.md. Do NOT start the ralph loop yourself.