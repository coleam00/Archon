---
title: The Attention Queue
description: List, stream, read, label and answer paused runs from outside Archon, and route classes of questions to your own handler workflows.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 5
---

Every paused run that needs someone is an item in the attention queue. A person at a
terminal, an agent wired to the queue through a skill, or a workflow you write can list
the items, follow them as a stream, read one, and answer it, all as JSON. Archon routes nothing: every answerer
sees every item, the answer names the pause it is for, and a second answer to the same
pause is refused.

## The contract

| Operation | CLI | HTTP |
|---|---|---|
| List | `archon workflow attention --json [--project <id\|name\|key> \| --all] [--label k=v]… [--sort age\|label:<key>]` | `GET /api/runs/attention?project=…&label=…&sort=…` |
| Count | `archon workflow attention --json --count-by project\|label:<key>` | `GET /api/runs/attention?countBy=…` |
| Stream | `archon workflow attention --watch --json [--project … \| --all] [--label k=v]… [--after <cursor>]` | Not yet |
| Read one | `archon workflow attention <run-id> --json` | `GET /api/runs/<run-id>/attention` |
| Label | `archon workflow attention label <run-id> --occurrence <id> [--set k=v]… [--unset k]…` | `POST /api/runs/<run-id>/attention/labels` |
| Answer | `archon workflow answer <run-id> --occurrence <id> …`, or `respond`, `approve`, `reject` | `POST /api/workflows/runs/<run-id>/answer` |
| Give up on the run | `archon workflow abandon <run-id>` | `POST /api/workflows/runs/<run-id>/abandon` |

The [CLI reference](/reference/cli/#workflow-attention) lists every flag. The list, the
single read, the stream and `workflow wait` all derive from the same run projection, so
they cannot disagree about what a run needs.

- **Scope.** The CLI defaults to the project of the working directory. `--project` names
  another project and `--all` covers the install. Every `workflow attention` form runs from
  any directory, registered or not. Over HTTP there is no working directory,
  so the default is the install.
- **Filters.** `--label k=v` is an exact match on the label's value, and repeated filters
  must all match. No filter or field depends on who is asking.
- **Order.** `age` puts the oldest pause first. `label:<key>` sorts by that label's value
  as a plain string. The engine reads no meaning into labels or messages.

## Queue items

Database queue reads log and skip paused rows whose stored run data cannot be
normalized. The log identifies the affected run, but the returned list does not
indicate that it is incomplete. File-store read errors can fail the list without
a run ID; inspect the snapshots and logs in the
[storage layout](/reference/database/#file-storage-for-cli-workflows) to locate
the invalid data before retrying.

```json
{
  "kind": "attention",
  "runId": "7c1e…",
  "workflow": "deliver",
  "project": { "key": "acme/web", "codebaseId": "c41f…", "name": "acme/web" },
  "fanOut": null,
  "revision": 1,
  "labels": { "ci": "other" },
  "pausedAt": "2026-10-14T07:58:02.000Z",
  "context": {
    "artifactsDir": "/home/me/.archon/workspaces/acme/web/artifacts/runs/7c1e…",
    "transcript": "/home/me/.archon/workspaces/acme/web/logs/7c1e….jsonl",
    "workingPath": "/home/me/.archon/workspaces/acme/web/worktrees/fix-ci",
    "branch": "fix-ci"
  },
  "node": "base",
  "occurrence": "e0f4…",
  "message": "CI on windows failed twice with EPERM. Retry, or stop?",
  "form": "select",
  "options": [{ "id": "retry" }, { "id": "stop" }]
}
```

- **`kind`** says how to answer. `attention` is a `wait: attention` pause: answer it in
  its `form` with `answer`, or the `respond`/`approve`/`reject` shorthand. `awaiting_response`
  is an approval gate: answer it with `approve`, `reject` or `respond`. `unreadable` is a
  paused run Archon cannot describe, or a parent whose sub-run tree it cannot read: a
  sub-run with no row, or a tree that revisits a run or exceeds 500 runs; `reason` and
  `detail` say why, and the action is to look at it and resume or abandon it.
- **`occurrence`** identifies the pause. Pass it back with `--occurrence`; an answer or
  label write for a pause the run has left is refused, naming the current occurrence.
- **`revision`** starts at 1 and grows by one with every label write, so a consumer can
  tell an updated item from a repeat.
- **`project`** is the project the run belongs to, never a label. `key` is the project
  storage key that [state documents](/reference/cli/#state) scope by, so
  `archon state --project <item.project.key>` reaches the same project. `codebaseId` is
  null for a project with no codebase row, such as a run in an unregistered directory
  (`_cwd/<name>`). `name` is the codebase's name, or otherwise the key's last segment. A
  run started before its codebase was renamed keeps the key it started with; that is the
  key its state lives under. `project` is null only for a run with no trusted storage
  root.
- **`fanOut`** is `{ parentRunId, nodeId, index }` for a child of a `fan_out:` node, and
  null otherwise. A parent blocked on its children is never an item; reading it returns
  the item of the child that holds the pause.
- **`pausedAt`** is when the pause opened. Gates do not record it, so it is null for them,
  and they sort after timed items.
- **`context`** holds pointers, never pasted content. Read what you need.

## Labels

A `wait: attention` node can label its pause. Values may use runtime references; they are
resolved when the wait pauses.

```yaml
  - id: ask
    depends_on: [classify]
    wait:
      attention: "$classify.output.summary"
      form: select
      options: [{ id: retry }, { id: stop }]
      labels:
        ci: "$classify.output.cause"     # e.g. "pr" or "other"
        area: delivery
```

Labels are a flat map from string to string. A key is one token with no `=` or
whitespace. Anything else that classifies an item, such as a handler, writes labels with
`attention label`. The write merges into the map: a key it sets replaces the same key, a
key it unsets is removed, and nothing else changes. Only attention waits carry labels; a
gate's item always has none.

Counting shows which classes of question recur often enough to deserve a handler:

```bash
archon workflow attention --json --all --count-by label:ci
```

## Stream the queue

`--watch` turns the list into a stream of JSON lines, one object per line, across every run
in scope, including runs that start after the stream does. It is the alternative to polling
the list and diffing it. It runs until Ctrl-C, SIGTERM, or its reader closes stdout, and
then exits 0. On Windows a process kill is not a signal: it ends the stream without that
exit.

```bash
archon workflow attention --watch --json --all
```

A stream starts with one `attention` line per open item, with `snapshot: true`, then a
`ready` line. The lines before `ready` are the complete open set: on every connect, an item
you held that is not among them is gone. After `ready`, a line arrives for every change the
store commits, whichever process made it: a detached run, a trigger, the server, another
host on the same database.

| `type` | When | Fields |
|---|---|---|
| `attention` | An item opened, or a label write changed it | `cursor`, `snapshot`, `project`, `item` (a queue item, as above) |
| `resolved` | An item this stream sent no longer needs an answer | `cursor`, `project`, `runId`, `occurrence`, `reason`; with `reason: "answered"`, also `answeredVia` and `answeredAt` |
| `unmatched` | A label write moved an open item outside `--label` | `cursor`, `project`, `runId`, `occurrence`, `revision` |
| `terminal` | A run ended | `cursor`, `project`, `runId`, `status`, `outcome` |
| `owner_lost` | A running run's owner process is gone | `cursor`, `project`, `runId`, `observedStatus` |
| `ready` | The snapshot is complete | `cursor` |
| `bookmark` | 30 seconds passed with no other line, and the stream read the store up to `cursor` | `cursor` |
| `error` | The store cannot read the stream's cursor: `--after` named one this install did not issue, or the store no longer reads the stream's own position. The last line; the command exits 4 | `error: "cursor_invalid"` |

- **Keep an open set keyed by `(runId, occurrence)`.** `attention` adds or updates the
  item unless you already hold that item at the same or a higher `revision`; `resolved`
  removes it. `reason` is `answered`, or `withdrawn` when the item closed without an answer:
  the run was resumed, ended, deleted, or paused somewhere new. `answeredAt` is null when the
  run had moved past the answer before the stream read it.
- **Delivery is at least once.** Dedupe `attention` on `(runId, occurrence, revision)` and
  `terminal` on `(runId, cursor)`. `owner_lost` is a live observation: it is not replayed,
  and the next connection reports it again if the owner is still gone.
- **Resume where you stopped.** Persist the `cursor` of the last line you handled and
  restart with `--after <cursor>`. The new stream sends the snapshot and `ready`, then
  replays every change after that cursor. `bookmark` lines keep the cursor moving while
  the queue is quiet. A stream that cannot read the store sends no `bookmark` until a read
  succeeds, so no line for well over 30 seconds means the stream is not reading. If the
  cursor is rejected, rerun without `--after`.
- **`--label` filters `attention` and `resolved`.** `terminal` and `owner_lost` arrive for
  every run in scope. A label write that leaves an open item outside the filter sends
  `unmatched`, even for an item the stream never sent.
- **What a line reports is the row when the stream read it.** The stream reads about once
  a second, and PostgreSQL wakes it on each commit. A pause opened and answered between
  two reads may never appear as an item; the run's `terminal` line still does.
- **Owner liveness follows `workflow wait`.** A running run is watched until it pauses or
  ends, including while it reports stalled tool calls. Only a run whose recorded owner is
  on this host and user can be reported `owner_lost`; a run owned on another host is never
  reported lost. Nothing here changes the run: abandon it with `workflow abandon`.

The stream only reads. Stopping it, with a signal or by closing its stdout, affects no run
and exits 0. A closed stdout is noticed when the stream next writes a line. An answered run continues where a continuation host runs: `archon serve`,
`archon workflow wake --watch`, or a CLI answer without `--json`, which continues the run in
place.

## Handle a class of questions with a workflow

Labels are how your own handler workflows find their items. A workflow that hits a
recurring class of question pauses with a label for that class. To have that class
handled, add a handler workflow that selects it from the queue and answers it. Until a
handler exists, the items wait for any answerer.

This handler answers delivery runs whose CI went red for a reason outside the change,
labelled `ci=other`. Start it from a [schedule](/guides/workflow-triggers/) so it polls
the queue.

```yaml
name: ci-other-handler
description: Retry or stop delivery runs paused on CI failures the change did not cause
nodes:
  - id: queue
    bash: archon workflow attention --json --all --label ci=other
  - id: decide
    depends_on: [queue]
    prompt: |
      Each item in this queue is a delivery run paused because CI failed for a reason
      outside the change. For every item, read its transcript (context.transcript) and
      decide whether retrying can succeed.

      $queue.output
    output_format:
      type: object
      properties:
        answers:
          type: array
          items:
            type: object
            properties:
              runId: { type: string }
              occurrence: { type: string }
              option: { type: string, enum: [retry, stop] }
            required: [runId, occurrence, option]
      required: [answers]
  - id: answer
    depends_on: [decide]
    bash: |
      answers=$decide.output.answers
      printf '%s' "$answers" | jq -c '.[]' | while read -r item; do
        archon workflow respond "$(jq -r .runId <<<"$item")" "$(jq -r .option <<<"$item")" \
          --occurrence "$(jq -r .occurrence <<<"$item")" --json
      done
```

Two handlers can watch the same class. The occurrence check refuses the second answer,
and the run stays answered once.

## Classify, then route

A handler can also classify items for other handlers instead of answering them. This
example puts a cheap classifier in front of the queue:

1. **Watch.** A scheduled workflow polls `archon workflow attention --json --all`, or a
   long-running process reads `archon workflow attention --watch --json --all`, and keeps
   the items whose `labels` have no `class` yet.
2. **Classify.** For each item it reads the message, labels, project, form, options and
   `pausedAt`, and asks a small model for a typed choice: a class, an urgency, and whether
   an agent can answer it, with a confidence.
3. **Label.** It writes the result back without answering:

   ```bash
   archon workflow attention label <run-id> --occurrence <occurrence> \
     --set class=ci-other --set urgency=high --set answerable=agent --json
   ```

   The item's `revision` goes up, and the classifier skips it next time because it now
   has a `class`. When the classifier is confident of the answer itself, it can answer
   with `respond` instead.
4. **Route.** A second handler selects its class, like the `ci=other` handler above:

   ```bash
   archon workflow attention --json --all --label class=ci-other --label answerable=agent
   ```

The labels are yours. Archon never reads `class`, `urgency` or `answerable`, and never
decides whether a person or an agent answers.
