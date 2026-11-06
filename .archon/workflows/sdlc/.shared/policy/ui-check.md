# UI check policy

This is the SDLC pack's default policy for how a reviewer runs a project's app to use a
user-facing change. A project adds to it with its own `.archon/sdlc/policy/ui-check.md`:
the reviewer reads this default first and the project's file after it, and where the
two conflict, the project's line wins.

- Start the app the way the project documents it for development, from the reviewer's
  scratch worktree.
- Point every data directory, database and config home the app reads at a fresh
  directory under `$ARTIFACTS_DIR`. Never start it against a user's real data or a
  configured live database.
- Bind an unused port, and pass empty values for credentials the app would use to reach
  a live service.
- Stop the process you started by its PID or port before you finish.
