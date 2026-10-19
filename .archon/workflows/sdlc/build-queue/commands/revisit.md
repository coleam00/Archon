# Revisit Blocked Items

Intake recorded each item below as blocked: something had to happen first. Work lands in parallel, so a blocker can be resolved, superseded or made irrelevant while its issue is still open, and an item can stay blocked long after it could move. Judge, for each item, whether it still looks blocked now. You don't re-triage anything yourself: the next node asks intake to re-triage the items you name, and intake decides whether each is ready. You write nothing to the tracker, the repository or the state store, and the checkout must be exactly as you found it.

The items: `$INPUTS.blocked`, issues in `$INPUTS.repo_host/$INPUTS.repo_path`. Each has its issue number and intake's summary of its triage, which names what it waits on.

## Judge each item

1. Read the issue, its recent comments and what it waits on, with the tracker's CLI: the linked issues or pull requests, or the decision it names.
2. Check the current state of each blocker: closed, merged, superseded by other work, or still open and still needed. For a code prerequisite, check the default branch: `git fetch` the remote, then read the log and the files the blocker would have changed. An open blocker whose outcome already landed some other way does not block.
3. Decide:
   - re-triage it when the reason intake recorded no longer holds, or probably no longer holds and a fresh triage would settle it. Intake's triage is cheap next to an item that waits for nothing.
   - leave it when it still waits on something real: an open prerequisite whose outcome has not landed, or a person's decision nobody has made.

An item blocked on a maintainer's decision stays blocked until the issue or its comments record that decision.

Declare `retriage`: one entry per item to re-triage, with its `number` and a `reason` a maintainer can check in one line, naming the blocker and its state. An empty list sends nothing.
