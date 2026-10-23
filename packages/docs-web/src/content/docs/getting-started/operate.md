---
title: Operate runs
description: Watch runs, answer the ones that need you, resume or stop them, read what they produced, and hand classes of questions to your own handler workflows.
category: getting-started
area: workflows
audience: [user]
status: current
sidebar:
  order: 5
---

A run ends in one of three ways: it finishes, it fails, or it pauses because it needs something from outside. This page covers what you do with each: see what is running, answer the runs that wait for you, resume or stop a run, and read what a finished run left behind. The second half is the JSON contract for scripts and agents that work the queue for you.

Every `<run-id>` below accepts the short 8-character id that `workflow runs` prints, when you run the command from the project's directory.

## See what is running

```bash
archon workflow status                         # running and paused runs in this project
archon workflow status --all                   # the whole install
archon workflow runs                           # recent runs of every status
archon workflow runs --status failed --limit 50
archon workflow get <run-id>                   # one run: status, nodes, outcome
archon workflow logs <run-id> --follow --format text
```

`get` reports two separate facts. The status (`running`, `paused`, `completed`, `failed`, `cancelled`) says how execution went. The outcome (`succeeded` or `failed`), when the workflow declares one, is the workflow's verdict on the work. A `completed` run with outcome `failed` ran to the end and judged the work unsuccessful.

To block until one run finishes or needs you, use `archon workflow wait <run-id>`. It is the partner of `archon workflow run ... --detach`: take the run id from the launch and wait on it instead of polling `get`. It has no default timeout. It exits 0 when the run finishes or needs you, whatever the run's status; the status is on stdout.

To browse runs in a browser, start the console with `archon serve`.

## Find the runs that need you

```bash
archon workflow attention                      # this project
archon workflow attention --all                # the whole install
archon workflow attention --all --watch        # stay open and print each change
```

Each item names the run, its workflow, its project, how long it has waited, the question, and the exact command for each choice. The item's `kind` says what it needs:

| Kind | What it is | What to do |
|---|---|---|
| `attention` | A `wait: attention` node asked a question | Answer it in its form |
| `awaiting_response` | An approval gate | `approve`, `reject` or `respond` |
| `usage_limit` | A node hit a provider usage limit, or a rate limit that outlasted its retries | Nothing. It retries at `resetAt`. `resume` tries sooner |
| `unreadable` | A paused run Archon cannot describe | Inspect it, then resume or abandon it |

A `usage_limit` wait retries from the node that hit the limit, at the provider's reset time or a 5 to 15 minute backoff, and pauses again if the limit is still there. With `workflows.autoResumeOnQuotaReset: false`, or for a container run, the run fails instead of waiting.

An `unreadable` item carries `reason` and `detail`. A container paused with reason `source_release_not_continued` could not read its frozen source on this host. Resume it by hand on a host that can.

## Answer a run

Copy the command the item prints, or write it yourself:

```bash
archon workflow respond <run-id> <choice> "why"                # any declared choice
archon workflow approve <run-id> "Looks good"
archon workflow reject <run-id> --reason "Not this week"
archon workflow answer <run-id> --occurrence <id> --choose use-dev
archon workflow answer <run-id> --occurrence <id> --text "Rotated the key"
```

`respond`, `approve` and `reject` work on both gates and attention waits: each verb picks the option with its id. `answer` speaks the attention wait's own form. `--choose` names a declared option, repeated for a `multi_select` and left out for a `message`. `--text` records free text with the answer. An undeclared choice is refused and the run stays paused.

`--occurrence` pins the answer to one pause. If the run has moved on to a different pause, the answer is refused and the refusal names the current occurrence. A second answer to the same pause is refused too, so two answerers never both win.

In a terminal, an answer continues the run in place. With `--json`, the answer is recorded and the run waits for a continuation host: `archon serve`, or `archon workflow wake --watch`. A container run needs `archon workflow resume <run-id>`.

## Resume, cancel or abandon a run

```bash
archon workflow resume <run-id>       # rerun a failed or paused run, skipping completed nodes
archon workflow resume <run-id> --detach
archon workflow end-turn <run-id>     # end a running run's stalled turn
archon workflow cancel <run-id>       # stop a running run
archon workflow abandon <run-id>      # give up on a run for good
```

Pick the command by what is wrong:

- **A turn is stuck, but the run should go on.** When `workflow wait` or `status` reports `stalled_tool_calls`, a tool or reported background work has made no progress. `end-turn` records a request to end that turn. Only the run's live owner acts on it: it ends the turn if the same stall is still active, the node fails as `timeout`, and the node's retry policy decides whether to try again. The command itself stops nothing, and it refuses a run that is not `running`.
- **The run should stop.** Use `cancel`.
- **The run failed or paused.** Use `resume` to continue it.

`cancel` works only on a `running` run. It stops the process that owns the run, confirms it stopped, and then records `cancelled`. When no owner answers, it refuses and changes nothing, because a database update cannot prove the work on the host stopped. A foreground `archon workflow run` can't be stopped from another shell: interrupt it in its terminal.

`abandon` is for a paused or failed run, or one whose owner is gone. It stops a live owner on this host first, records `cancelled`, and removes the worktree Archon created for the run. Removal is forced: uncommitted and untracked files in that worktree are deleted. The branch stays, so committed work is recoverable. Archon never decides a run is dead from its age.

The [CLI reference](/reference/cli/#workflow-cancel) covers sub-run trees, containers and the Windows job rules.

## Read what a run produced

```bash
archon workflow get <run-id>                          # status, outcome, per-node summary with --verbose
archon workflow artifacts <run-id>                    # list the files in $ARTIFACTS_DIR
archon workflow artifacts <run-id> review/report.md   # print one
archon workflow logs <run-id> --format text           # the transcript, readable
```

Stages hand each other files in `$ARTIFACTS_DIR`, so the artifacts are usually where the answer is: a report, a plan, a review. They live under `~/.archon/workspaces/<project>/artifacts/runs/<run-id>/`. The transcript is JSONL with every node, tool call and subprocess output. Treat it as sensitive: it holds prompts and command output.

## Hand a class of questions to a workflow

Archon routes nothing: every answerer sees every item. Labels are how your own handler workflows find the items they own. A `wait: attention` node can label its pause, with values that may reference earlier nodes:

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

Labels are a flat map from string to string. A key is one token with no `=` or whitespace. Only attention waits carry labels; a gate's item has none. To see which classes recur often enough to deserve a handler, count them:

```bash
archon workflow attention --json --all --count-by label:ci
```

This handler answers delivery runs whose CI went red for a reason outside the change, labelled `ci=other`. Start it from a [schedule](/guides/workflow-triggers/) so it polls the queue.

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
      items=$(printf '%s' "$answers" | jq -c '.[]') || exit 1
      if [ -z "$items" ]; then
        exit 0
      fi
      failed=0
      while read -r item; do
        if ! result=$(archon workflow respond "$(jq -r .runId <<<"$item")" "$(jq -r .option <<<"$item")" \
          --occurrence "$(jq -r .occurrence <<<"$item")" --json); then
          printf '%s\n' "$result" >&2
          failed=1
          continue
        fi
        if ! printf '%s\n' "$result" | jq -e '.ok == true' >/dev/null; then
          printf '%s\n' "$result" >&2
          failed=1
        fi
      done <<<"$items"
      exit "$failed"
```

An answer command exits non-zero when the answer is refused, including with `--json` (`ok: false`). An answer accepted while the run's resource is full exits 0: the run keeps its place and a continuation host continues it when a slot frees. If two handlers watch the same class, the occurrence check refuses the second answer.

A handler can also classify instead of answer. A cheap classifier lists the `kind: attention` items with no `class` label, asks a small model for a typed class, urgency and whether an agent can answer, and writes the result back:

```bash
archon workflow attention label <run-id> --occurrence <occurrence> \
  --set class=ci-other --set urgency=high --set answerable=agent --json
```

The write merges: a key it sets replaces that key, a key it unsets is removed, and nothing else changes. A second handler then selects its class with `--label class=ci-other --label answerable=agent`. The labels are yours. Archon never reads `class`, `urgency` or `answerable`, and never decides whether a person or an agent answers.

## The queue contract

Everything above is also JSON, for scripts and agents. The list, the single read, the stream and `workflow wait` derive from the same run projection, so they never disagree about what a run needs.

| Operation | CLI | HTTP |
|---|---|---|
| List | `archon workflow attention --json [--project <id\|name\|key> \| --all] [--label k=v]… [--sort age\|label:<key>]` | `GET /api/runs/attention?project=…&label=…&sort=…` |
| Count | `archon workflow attention --json --count-by project\|label:<key>` | `GET /api/runs/attention?countBy=…` |
| Stream | `archon workflow attention --watch --json [--project … \| --all] [--label k=v]… [--after <cursor>]` | Not yet |
| Read one | `archon workflow attention <run-id> --json` | `GET /api/runs/<run-id>/attention` |
| Label | `archon workflow attention label <run-id> --occurrence <id> [--set k=v]… [--unset k]…` | `POST /api/runs/<run-id>/attention/labels` |
| Answer | `archon workflow answer <run-id> --occurrence <id> …`, or `respond`, `approve`, `reject` | `POST /api/workflows/runs/<run-id>/answer` |
| Give up on the run | `archon workflow abandon <run-id>` | `POST /api/workflows/runs/<run-id>/abandon` |

With explicit chat scope (`--chat-project-id <id>`), CLI list, count and watch use the selected project regardless of the working directory. Its ID, name or key is accepted by `--project`; other projects and `--all` are rejected. Without explicit chat scope, the CLI defaults to the working directory's project, `--project` names another project and `--all` covers the install. Every `workflow attention` form runs from any directory, registered or not. Over HTTP there is no working directory, so the default is the install. `--label k=v` is an exact match, and repeated filters must all match. `age` sorts the oldest pause first; `label:<key>` sorts by that label's value as a plain string. A single-run read returns null when the run has no item. The [CLI reference](/reference/cli/#workflow-attention) lists every flag.

### Queue items

```json
{
  "kind": "attention",
  "runId": "7c1e…",
  "workflow": "deliver",
  "project": { "key": "acme/web", "codebaseId": "c41f…", "name": "acme/web" },
  "parentRunId": null,
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

- **`kind`** is one of the four kinds above. A `usage_limit` item carries `node` and `resetAt` and has no `occurrence`. An `unreadable` item carries `reason` and `detail`; it also covers a parent whose sub-run tree cannot be read: a sub-run with no row, or a tree that revisits a run or exceeds 500 runs.
- **`occurrence`** identifies an answerable pause. Pass it back with `--occurrence`. If a refusal does not name the current occurrence, read the item again before retrying.
- **`revision`** starts at 1 and grows by one with every label write on an attention wait. It stays 1 for other kinds, so it does not identify every change to an item.
- **`project`** is the project the run belongs to, never a label. `key` is the storage key [state documents](/reference/cli/#state) scope by, so `archon state --project <item.project.key>` reaches the same project. Copy it exactly when you pass `--project`. `codebaseId` is null for a project with no codebase row, such as a run in an unregistered directory (`@cwd/<basename>-<digest>`). A run started before its codebase was renamed keeps the key it started with. `project` is null only for a run with no trusted storage root.
- **`parentRunId`** is the run's direct parent for any child run, such as a `workflow:` sub-run or a fan-out child, and null for a top-level run.
- **`fanOut`** is `{ parentRunId, nodeId, index }` for a child of a `fan_out:` node, and null otherwise.
- **`pausedAt`** is when the pause opened. Gates do not record it, so it is null for them and they sort after timed items.
- **`context`** holds pointers, never pasted content.

### Several items from one workflow

A workflow can [fan out one child per question](/reference/workflow-language/#several-independent-questions) with `max_parallel: all`. Each child pauses at its own attention wait, with its own question, choices and occurrence. A parent blocked on its children is never an item, and reading the parent returns only its first actionable descendant. To find every question, list the queue and select the items whose `fanOut.parentRunId` is the parent; `fanOut.index` keeps the original order.

```bash
archon workflow attention --json --all
archon workflow answer <child-run-id> --occurrence <occurrence> --choose accept
```

Answer the children in any order. Each child applies its own answer at once. The parent stays paused until every child finishes, then reads their ordered results.

### Stream the queue

`--watch --json` turns the list into JSON lines across every run in scope, including runs that start after the stream does. It replaces polling the list and diffing it. It runs until Ctrl-C, SIGTERM, or its reader closes stdout, then exits 0. On Windows a process kill is not a signal, so it ends the stream without that exit.

A stream starts with one `attention` line per open item, with `snapshot: true`, then a `ready` line. The lines before `ready` are the complete open set: on every connect, an item you held that is not among them is gone. After `ready`, the stream follows every change the store commits, whichever process made it: a detached run, a trigger, the server, another host on the same database.

| `type` | When | Fields |
|---|---|---|
| `attention` | An item opened or changed | `cursor`, `snapshot`, `project`, `workflow`, `parentRunId`, `item` |
| `resolved` | An item this stream sent closed or was replaced | `cursor`, `project`, `runId`, `workflow`, `parentRunId`, `occurrence`, `reason`; with `reason: "answered"`, also `answeredVia` and `answeredAt` |
| `unmatched` | A label write moved an open item outside `--label` | `cursor`, `project`, `runId`, `workflow`, `parentRunId`, `occurrence`, `revision` |
| `terminal` | A run ended | `cursor`, `project`, `runId`, `workflow`, `parentRunId`, `status`, `outcome`, `cause` |
| `resumed` | A failed run resumed, an engine-cancelled fan-out child recovered, or a paused or stale-running run resumed and cleared a stored error | `cursor`, `project`, `runId`, `workflow`, `parentRunId`, `status: "running"` |
| `owner_lost` | A running run's owner process on this host is gone | `cursor`, `project`, `runId`, `workflow`, `parentRunId`, `observedStatus` |
| `ready` | The snapshot is complete | `cursor` |
| `bookmark` | 30 seconds passed with no other line, and the stream read the store up to `cursor` | `cursor` |
| `degraded` | Repeated failure to project a run; coverage may be incomplete. The stream keeps running | `cursor`, `reason: "run_unreadable"` |
| `error` | `--after` named a cursor this install did not issue, or the store no longer reads the stream's position. The last line; exit 4 | `error: "cursor_invalid"` |

- **Keep an open set keyed by `runId`.** Each `attention` line replaces that run's item, including when its kind or `resetAt` changes while `revision` stays 1. `resolved` removes it. Its `reason` is `answered`, or `withdrawn` when the run resumed, ended, was deleted or moved to a different pause. For a fan-out child, remove only that child.
- **Deliveries are at least once.** Replacing by `runId` is idempotent. Dedupe answerable pauses on `(runId, occurrence, revision)`, and `terminal` and `resumed` on `(runId, cursor)`. Don't dedupe every kind by occurrence: usage-limit waits have none. `owner_lost` is a live observation and is not replayed. Only a run whose recorded owner is on this host and user can be reported lost.
- **Reconnect from a cursor before any event you did not finish.** A cursor names a feed event, and one event can emit two lines with the same cursor (`resolved` then `attention`, or `resolved` then `terminal`). `--after <cursor>` skips the whole event, so checkpoint only on a handled `bookmark` or from before the partly handled event. The new stream sends the snapshot and `ready`, then replays readable changes after the cursor. If the cursor is rejected, reconnect without `--after`.
- **A silent stream is not reading.** A stream that cannot read the store sends no `bookmark`, so no line for well over 30 seconds means it is stuck.
- **`degraded` means gaps.** The operator log names the run that failed to project; the warning does not. Repair the read failure, reconnect to refresh the open set, and replay from a cursor before the gap to recover missed transitions. The stream sends no recovered signal.
- **Filter by parent.** Every run line carries the run's `workflow` and `parentRunId`, the same values as the queue item's. A `workflow` of null means the stream could not read the run's row, because it was deleted, so that line's `parentRunId` says nothing. Keep top-level runs with `workflow != null and parentRunId == null`, or one parent's direct children with `parentRunId == "<run-id>"`. `ready`, `bookmark`, `degraded` and `error` have no `workflow` field and must pass through the filter, for example `jq 'select((has("workflow") | not) or (.workflow != null and .parentRunId == null))'`.
- **A failed run says where it failed.** On a `terminal` line with `status: "failed"`, `cause` is `{ node, errorClass }`: the first failed node from the run's terminal record, and the failure kind that node's failure recorded, such as `exec_failed` or `timeout`. `errorClass` is null when the failure recorded no kind, as older runs did. `cause` is null for other statuses, for a run that failed outside a node, and for a run that ended before terminal records existed. A replayed line keeps the cause it had, even after the run resumed and failed again. The line never carries error text; read it with `archon workflow get <run-id>`.
- **`--label` filters `attention` and `resolved` only.** `terminal`, `resumed` and `owner_lost` arrive for every run in scope. A label write that leaves an item outside the filter sends `unmatched`.
- **Items report the row when the stream read it.** The stream reads about once a second, and PostgreSQL wakes it on each commit. A pause opened and answered between two reads may never appear.

The stream only reads. Stopping it affects no run.
