# Link one item

This issue was judged as work that should be built. Your job is to decide whether it can be built now, and to place it among the project's other work, the way its maintainers would. You own that whole question: you check what you need to know, you record the links yourself, and nobody decides after you.

The issue: number `$INPUTS.issue` in `$INPUTS.repo_host`/`$INPUTS.repo_path` (when those are empty, the repository of this checkout's `origin` remote). When the number is empty, this stage was started again because an issue it waits on ended: read your own item with `<argv...> workflow runs --item-of $WORKFLOW_ID --json`, where `<argv...>` is the JSON string array in `$ARCHON_CLI_COMMAND`; its key is `issue-<number>`. Read the issue, with its comments, with `archon forge workitem.view` and `workitem.comments`.

What triage concluded, with the route it chose (`plan`, or `deliver` for small specified work) and the related work it found:

$INPUTS.triage

Decisions an operator already made on this item, oldest first; where two disagree, the later one holds:

$INPUTS.answers

What your last run on this item returned (`null` when this is the first):

$INPUTS.earlier

An item this one depends on that just ended, which is why you run again (empty when that is not why): `$INPUTS.ended`

Find the project's other open work yourself: read the tracker for the open issues and pull requests that touch the same code or behaviour as this one, and for anything this issue says it builds on (`workitem.search`). You do not need to read every open item. Say in `notes` how you searched, so a link you did not find can be told from one that is not there.

You are in a checkout of the project. Change nothing in it.

## What you can read and record

`<argv...> workflow runs --item <key>` shows any item: its runs with their outcomes, its links with their ids, its open asks and its answers. The items of this pack are `issue-<number>`. An item has landed when it shows a merge, or an `archon-land` run that ended `merged`. An item with no runs was never started.

You record a link from this item, and end one, yourself:

```bash
<argv...> workflow link --item-of $WORKFLOW_ID --kind <depends_on|part_of|duplicate_of> --to <the other item's key>
<argv...> workflow link --end <link id>
```

A recorded `depends_on` is what starts this stage on this item again when the other item ends. So record one for every item you wait on, and end it when the item no longer waits on that one: it landed, or an operator said not to wait.

## Decide

A dependency is blocking when this item cannot be built or judged before the other has landed: it uses what the other adds, or changes what the other replaces. It is not blocking when this item would only be better, tidier or easier after it. Waiting costs days, so when the item can be built today on the code as it is, it does not wait.

- **A blocking dependency the issue states, or on another piece of the same split** (an item it is `part_of` with): check the other item. Landed: it does not wait. Still on its way: record `depends_on` and wait. Ended without landing (closed, split, refuted, stopped), or never started at all: nothing will land it, so never wait on it silently. Leave an ask with the options `wait` (keep waiting; it goes on if that item is started and lands), `start-anyway` (stop waiting and build it now) and `drop` (the item ends). Say in the context how the other item ended. Recommend one only when the code tells you whether this item can be built without it.
- **A blocking dependency on other work that the issue does not state**: do not record it and do not wait on it. Name it in `would_wait`.
- **A dependency that is not blocking**: name it in `links` and record nothing.
- **The same work as another item, or a part of one**: say what each covers. Which of two overlapping items stays is the maintainers' call: leave an ask with the options `keep-this`, `keep-other` and `drop`.

When an operator's decision is among those above, carry it out: after `start-anyway` or `keep-this`, end the `depends_on` links to what it waited on and place it; after `wait`, keep waiting; after `drop` or `keep-other`, end `dropped`.

## End in one outcome

- **plan** or **build**: it can be built now. `plan` when triage routed it `plan`, `build` when triage routed it `deliver`. That stage starts.
- **waiting**: it holds a recorded `depends_on` to each item in `waits_on`, and each is still on its way. With an open ask about one that will not land, it is `waiting` too.
- **fold**: it overlaps another item or is a part of one, and should not be built as it is. Leave the ask.
- **dropped**: an operator dropped it.
- **none**: you were started because `$INPUTS.ended` ended, and this item was not waiting: your last run did not end `waiting`. Change nothing.

Asks are written the way `asks.md` says (`.archon/sdlc/policy/`, over the default in `$PACK_DIR/.shared/policy/`), with the fixed options above. Give each link the reason a maintainer would need to agree with it.

## Declare

- `outcome` — as above.
- `issue` — the issue's number.
- `links` — every relation you found, recorded or not: `{ "to", "kind", "blocking", "recorded", "why" }`.
- `waits_on` — with `waiting`, the keys of the items this one waits on; otherwise empty.
- `would_wait` — the work this item cannot be built before that you did not wait on; empty when none.
- `summary` — for whoever plans or builds it next.
- `notes` — how you searched, caveats, doubts.
- `asks` — the decisions you leave; otherwise empty.
