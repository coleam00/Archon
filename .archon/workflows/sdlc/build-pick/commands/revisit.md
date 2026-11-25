# Revisit Blocked Items

Intake recorded each item below as blocked: something had to happen first. Work lands in parallel, so a blocker can be resolved, superseded or made irrelevant while its issue is still open, and an item can stay blocked long after it could move. Find, for each item, whether something it waits on has changed since intake blocked it. You don't re-triage anything yourself: the next node asks intake to re-triage the items you name, and intake decides whether each is ready. A re-triage is a full agent run, so name an item only for a change you can cite. You write nothing to the tracker, the repository or the state store.

The items: `$INPUTS.blocked`, issues in `$INPUTS.repo`. Each has its issue number, intake's `summary` of its triage, `blocked_at` (when triage gave the blocked verdict), and what that verdict said it waits on: `blocked_reason` and `blocked_by`, the URLs of its blockers. An item with an empty `blocked_reason` was blocked before verdicts recorded these; take what it waits on from `summary` and the issue.

## Judge each item

1. Read the issue, its recent comments and what it waits on: the linked issues or pull requests, or the decision it names. Read them through the Archon CLI, whose argv is the JSON string array in `$ARCHON_CLI_COMMAND`, as `<argv...> forge <op> --json --data '<request>'`, with `<repo>` = `{"host":…,"path":…}`, `$INPUTS.repo` split at its first `/`: `workitem.view` takes `{"ref":{"repo":<repo>,"number":<n>}}`, `workitem.comments` takes `{"subject":{"kind":"issue" or "pr","ref":…}}`, and `pr.view` takes `{"selector":{"kind":"number","ref":…}}`. A failed read is the answer: report it, and never repeat it through another tool.
2. Check the current state of each blocker: closed, merged, superseded by other work, or still open and still needed. For a code prerequisite, check the default branch: `git fetch` the remote, then read the log and the files the blocker would have changed. An open blocker whose outcome already landed some other way does not block.
3. Decide:
   - re-triage it only when something it waits on changed state after `blocked_at`: a blocker closed or merged, its outcome landed on the default branch another way, or the decision it names was recorded. Triage already judged everything before `blocked_at`, so only a later change counts.
   - leave it in every other case: nothing it waits on changed, the change predates `blocked_at`, or you cannot point at the change. That an item probably no longer waits is not a reason; a guess sends the same item through triage again for the same verdict.

An item blocked on a maintainer's decision stays blocked until the issue or its comments record that decision.

Declare `retriage`: one entry per item to re-triage, with its `number` and a `reason` a maintainer can check in one line: the blocker, what changed, and when or where (the merge, the commit, the comment). An empty list sends nothing.
