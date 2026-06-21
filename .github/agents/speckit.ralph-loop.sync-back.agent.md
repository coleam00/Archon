---
description: After ralph.sh exits, flip tasks.md [X] from prd.json passes:true and
  archive run artifacts
argument-hint: <feature-dir>
---


<!-- Extension: ralph-loop -->
<!-- Config: .specify/extensions/ralph-loop/ -->
The ralph external bash loop has exited. Sync results back to spec-kit canonical:

1. Run: `bash .specify/extensions/ralph-loop/scripts/bash/sync-passes-to-tasks.sh "$ARGUMENTS"`
2. Report the flipped-count summary to the user.
3. If unmatched IDs were warned: surface them but do not fail.
4. Do NOT manually edit tasks.md.