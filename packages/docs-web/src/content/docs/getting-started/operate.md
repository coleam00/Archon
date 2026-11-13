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
archon workflow respond <run-id> --recommended --occurrence <id> --text "why"   # the choice the item recommends
archon workflow approve <run-id> "Looks good"
archon workflow reject <run-id> --reason "Not this week"
archon workflow answer <run-id> --occurrence <id> --choose use-dev
archon workflow answer <run-id> --occurrence <id> --text "Rotated the key"
```

`respond`, `approve` and `reject` work on both gates and attention waits: each verb picks the option with its id. `answer` speaks the attention wait's own form. `--choose` names a declared option, repeated for a `multi_select` and left out for a `message`. `--text` records free text with the answer. An undeclared choice is refused and the run stays paused. A `select` wait declared with [`other: true`](/reference/workflow-language/#attention-waits) also offers `other`, which needs text: `archon workflow respond <run-id> other "what to do instead"`.

`--recommended` answers an attention wait with the option its recommendation names, in place of a choice on `respond` or of `--choose` on `answer`. It needs `--occurrence`, the occurrence of the item you read, so that a run which has moved to another question refuses instead of accepting a recommendation you never saw. Text stays optional and goes in `--text`. It is the same answer as naming that option, so it is validated the same way. It is refused when the wait has no recommendation, and when its form is `message` or `multi_select`, which take none.

`--as <name>` records who is answering, on `answer`, `respond`, `approve` and `reject`: `archon workflow respond <run-id> --recommended --occurrence <id> --as triage-agent`. The name is whatever the answerer declares, up to 64 characters. Archon does not check it, and nothing is allowed or refused because of it. It tells an agent's answers from a person's when you read the record later. An attention wait's answer stores it as `answeredBy: { "declared": "<name>" }`. An answer through a chat platform stores `{ "userId": "<id>" }` instead: `declared` is what the answerer claims, and `userId` is the Archon user that Archon itself resolved the sender to. An answer given from inside a workflow node also records that run and node on its `wait_answered` event, as `fromRun: { "runId", "nodePath" }`. No flag or request field sets it and `--as` does not replace it: Archon reads it from the run identity it put in the node's environment. A node process can change its own environment, so it is attribution, not proof. A gate's answer records the surface only, so `--as` is refused at a gate.

`--occurrence` pins the answer to one pause. If the run has moved on to a different pause, the answer is refused and the refusal names the current occurrence. A second answer to the same pause is refused too, so two answerers never both win.

In a terminal, an answer continues the run in place, unless a running continuation host (`archon serve`, or `archon workflow wake --watch`) on the same database claims it first. The command then returns with `Run <run-id> is already continuing in another process.` if that host is still running it, or `Run <run-id> has already continued in another process and is completed.` if it has finished. With `--json`, the answer is recorded and the run waits for a continuation host: `archon serve`, or `archon workflow wake --watch`. A container run needs `archon workflow resume <run-id>`.

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

`abandon` is for a paused or failed run, or one whose owner is gone. It stops a live owner on this host first, records `cancelled`, and attempts to remove the worktree Archon created for the run. When removal proceeds, it is forced: uncommitted and untracked files in that worktree are deleted. A sub-run whose execution owner cannot be accounted for retains its checkout with a cleanup warning; cancellation still succeeds. See the [abandon reference](/reference/cli/#workflow-abandon) for retention and recovery guidance. The branch stays, so committed work is recoverable. Archon never decides a run is dead from its age.

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
archon workflow attention --json --all --count-by label:ci --since 30d
```

The first counts the items open now. With `--since` the count covers every attention wait opened in the window, whether it has been answered or is still open, by the labels each wait opened with.

A `--since` count also says how the recommendations fared. Each group carries `recommendations: { asked, answered, followed }`: how many of its waits opened with a recommendation, how many of those were answered, and how many of those answers chose the recommended option. A class where `followed` stays close to `answered` is one an agent could answer. `--count-by answerer --since 30d` groups the same waits by who answered them. Both read events only: each wait's `wait_started` event records its form, the option ids it offered and the recommended option with its confidence, never the message or the reason, and its `wait_answered` event records the answer. A wait opened by an Archon version that did not record these counts as carrying no recommendation.

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

Everything above is also JSON, for scripts and agents. The list, the single read, the stream and `workflow wait` share the run projection for readable runs. An unreadable stored descendant is an exception: a batch can omit its blocked parent, while a single read or `workflow wait` can fail.

| Operation | CLI | HTTP |
|---|---|---|
| List | `archon workflow attention --json [--project <id\|name\|key> \| --all] [--label k=v]… [--sort age\|label:<key>]` | `GET /api/runs/attention?project=…&label=…&sort=…` |
| Count | `archon workflow attention --json --count-by project\|label:<key>\|answerer [--since <duration\|ISO>]` | `GET /api/runs/attention?countBy=…` |
| Notices | `archon workflow attention --notices --since <duration\|ISO> --json [--label k=v]… [--count-by project\|label:<key>]` | none yet |
| Stream | `archon workflow attention --watch [--notices \| --protocol [--after <cursor>]] --json [--project … \| --all] [--label k=v]…` | `GET /api/runs/attention/stream?project=…&label=…&level=…` (SSE) |
| Read one | `archon workflow attention <run-id> --json` | `GET /api/runs/<run-id>/attention` |
| Label | `archon workflow attention label <run-id> --occurrence <id> [--set k=v]… [--unset k]…` | `POST /api/runs/<run-id>/attention/labels` |
| Answer | `archon workflow answer <run-id> --occurrence <id> …`, or `respond`, `approve`, `reject` | `POST /api/workflows/runs/<run-id>/answer` |
| Give up on the run | `archon workflow abandon <run-id>` | `POST /api/workflows/runs/<run-id>/abandon` |

An unreadable stored origin cannot become an item. Batch list and count results instead include
an optional `degraded` array with one `{ "type": "degraded", "reason": "run_unreadable", "runId": "<id>" }`
per reported paused run. `runId` identifies either the unreadable paused row or an affected readable paused parent whose unreadable descendant is not paused. A parent blocked on an unreadable paused descendant can be omitted because the child already has a report. An absent parent does not mean its block has cleared. Independent valid work stays available; counts cover readable matching items only.
Healthy results omit the array. Project views omit warning IDs because membership cannot be established;
label filters retain the warnings too. The console shows repair advisories beside actionable work,
and CLI text does the same. These diagnostics offer no resume or answer action and change no run state.
Use the safe unreadable run ID from operator logs to locate the data to repair; the warning may
name its readable parent instead. After repair, reload or read again.
No warning contains the stored origin, messages or credentials.

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

- **`kind`** is one of the four kinds above. A `usage_limit` item carries `node` and `resetAt` and has no `occurrence`. An `unreadable` item carries `reason` and `detail`; it also covers these structural failures in a parent's sub-run tree: a sub-run with no row, or a tree that revisits a run or exceeds 500 runs.
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

`--watch` follows every run in scope, including runs that start after the stream does, and writes a line only when someone has to act. It replaces polling the list. It runs until Ctrl-C, SIGTERM, or its reader closes stdout, then exits 0. On Windows a process kill is not a signal, so it ends the stream without that exit.

```bash
archon workflow attention --watch --json                  # this project
archon workflow attention --watch --json --all            # the whole install
archon workflow attention --watch --json --label stage=merge # one queue's questions
```

| `type` | Written when |
|---|---|
| `attention` | An item that takes an answer or a look opened or changed. The line carries the item with its message, options and recommendation. The items open at the start come first, with `snapshot: true` |
| `resolved` | An item this stream wrote closed: `reason` is `answered`, or `withdrawn` when the run resumed, ended, was deleted or moved to a different pause. Stop working on it |
| `unmatched` | A label write moved an item this stream wrote outside `--label`. It is no longer yours |
| `terminal` | A run in scope ended with `status: "failed"`, where `cause` identifies the failed node when available (null for failures outside a node) and a launch failure has the fixed `reason` "launch failed before the first node", or completed with `outcome: "failed"`: it ran to the end and judged the work unsuccessful, and `reason` says why in up to two short lines taken from what its `returns:` node said |
| `owner_lost` | A running run's owner process on this host is gone |
| `degraded` | A run could not be read, so the stream may have missed something. The operator log names the run |
| `error` | The store can no longer read the stream's position. The last line; exit 4. Start the watch again |

The lines have the shape the [full protocol](#the-full-protocol-for-programs) gives them, and its table lists their fields. Without `--json` each line prints as text, and a line on stderr says what is being watched.

The text form is the one to sit on, for a person or an agent: an ask prints as a block you can answer without a second read.

```text
Needs attention now:
  7c1e4f0a  archon-merge  acme/web  paused 2m ago
    labels: merge=pr, pr=5496
    ask: Merge pull request 5496?
    recommended: merge (high confidence). Review is ready and checks are green.
    option merge: Squash-merge it into dev.
    option hold: Leave it open and stop.
    accept the recommendation: archon workflow respond 7c1e4f0a --recommended --occurrence e0f4a2 [--text <why>]
    answer: archon workflow respond 7c1e4f0a <option> --occurrence e0f4a2 [text]
    full question: archon workflow attention 7c1e4f0a
```

The block carries the workflow, the labels, the first line of the question under the node's id, the recommendation with its reason, each option with what it does, and the commands that answer this occurrence. The rest of the message is one command away: `archon workflow attention <run-id>` prints it in full. A gate prints its approve command with its occurrence. A failed run, a lost owner and an unreadable item name the run and the command that shows more (`archon workflow get <run-id>`). The close of an ask is one line, and says who answered when that was recorded. `archon workflow attention` without `--watch` prints the same blocks. `--json` is the complete machine form and carries every field.

Read the watch unfiltered. A filter between the watch and its reader can hold lines back: some shells replace `grep` with a tool that writes nothing to a pipe until its input closes, so an ask would arrive only when the watch ends.

Every JSON line carries `needs`, which says what the line asks of you:

| `needs` | Meaning | Lines |
|---|---|---|
| `answer` | Someone has to answer | `attention` for an attention wait or a gate |
| `look` | Someone has to look, and the action is run control | `attention` for an unreadable item; a `usage_limit` wait that replaces an item that needed someone; a failed `terminal`; `owner_lost`; `degraded`; `error` |
| `nothing` | Nobody has to act | every other line, including `resolved` and `unmatched`: a closed ask leaves nothing to do |

`needs` says what someone must do; the level decides what is shown. The watch writes the `answer` and `look` lines, and the `resolved` or `unmatched` line of an item it wrote, so you stop working on an ask that closed. It writes nothing else. A run that completed with any other outcome or was cancelled, a run that resumed, and a `usage_limit` wait, which continues by itself, produce no line. `--watch --notices` adds those `nothing` lines, for a reader that also wants to know what happened to the work: every run that ended or resumed, usage-limit waits opening and closing, and the [notices](#notices-what-the-work-did) runs emit. It still leaves out `ready` and `bookmark`, which only a program on `--protocol` reads. To learn that one run finished, use `archon workflow wait <run-id>`; to see what finished, `archon workflow runs`.

- **`--label` turns a queue or a class on or off.** Labels are the only routing: `--label stage=merge` writes only the items a wait labelled `stage=merge`, and one watcher per class is one process per `--label` set. Labels belong to attention waits, so `terminal` and `owner_lost` lines arrive for every run in scope whatever the filter.
- **A silent stream proves nothing.** The watch has no heartbeat, so no line can mean that nothing needs you or that the stream stopped reading. A program that must tell the two apart uses `--protocol` and its `bookmark` lines.
- **A restart starts from the open items.** The snapshot is the current open set. Runs that failed while nothing watched are not replayed; `archon workflow runs` lists them. Replay from a cursor is part of `--protocol`.
- **Act on the item, then answer by its `runId` and `occurrence`.** An answer to an item someone else answered first is refused, so a `resolved` line you have not read yet cannot make you answer twice.

### Notices: what the work did

A run that ends says nothing about what it did: a queue pass that merged three pull requests and one that found nothing both complete. A notice is how a workflow says it. A node calls `archon workflow notice "<text>" --label k=v` (or `notice()` from [`archon:script`](/guides/script-nodes/#the-script-api)) when something worth knowing happened, and the engine records it with the run. A notice never pauses the run, holds no slot and cannot be answered.

```bash
archon workflow notice "Merged pull request 7 into dev" --label kind=merged --label pr=7   # inside a node
archon workflow attention --watch --notices --all            # as it happens, with everything that needs you
archon workflow attention --notices --since 24h --all        # what was done since yesterday
archon workflow attention --notices --since 24h --all --count-by label:kind
```

Each notice prints as one line: when, what, its labels.

```text
2026-11-11T14:02Z  Merged pull request 7 into dev  kind=merged pr=7
```

With notices, one command answers each of the simple questions someone asks the seat:

| Question | Command |
|---|---|
| What merged today? What did the factory do since 08:00? | `archon workflow attention --notices --since 2026-11-11T08:00:00Z --all` for a time of day (an ISO time with its offset), or `--since 8h` for the last eight hours; add `--label kind=merged` for one kind |
| What is building right now? | `archon workflow status --all`: every running or paused run, each with its `Notice:` line, the latest notice it emitted |
| What is waiting for me? | `archon workflow attention --all` |

The labels in these commands are examples: a workflow chooses its own. For the second question to have an answer, a run says what it is about when it starts the work, for example `archon workflow notice "Building issue 12" --label kind=build --label issue=12`.

- **Only a reader who asks receives them.** A notice is a `notice` line with `needs: "nothing"`, so the plain `--watch` never writes one; `--watch --notices` and `--protocol` do. `--label` selects notices the way it selects items.
- **Node-emitted labels are the workflow's own.** Archon does not interpret them. What deserves a node-emitted notice, and which labels it carries, is the workflow's decision, like what deserves an ask.
- **A live run carries its latest notice.** `archon workflow status` prints it as `Notice:` under the run, and `--json` gives each run a `notice` of `{ at, node, text, labels }`, or null when it emitted none. That is what the run is about now, with no second read.
- **The window list is the recap.** `--notices --since` reads the recorded notices of the window, oldest first, and `--count-by` counts them per project or per label value. `--json` prints `{ ok, action: "attention", scope, since, notices }`, each notice with `at`, `runId`, `workflow`, `parentRunId`, `project`, `node`, `text` and `labels`.
- **A notice is not a log.** The text is one line of at most 300 characters, with at most 16 labels, neither with control characters, and a run may emit 50. An emit past a bound exits 1 and says which. Details belong in an artifact; keep secrets out of the text, which every reader of the stream sees.
- **The notice command requires a node of a running run.** The command reads the run and node from the environment Archon gives a node, as `archon state` does, and refuses anywhere else. A node of a [container run](/guides/container-isolation/) cannot: it has no host CLI to call, so `notice()` throws `HostCommandError` there.

The engine also records a notice when a `trigger fire` with a delivery ID and source run is skipped by resource admission, if the source run has room in its shared 50-notice allowance. It belongs to the source run even after it ends, with `node: null` and engine-owned labels identifying the binding, resource and blocker (`kind=trigger_fire_skipped`). At or above the ceiling, admission records the skip without a notice; the skip remains visible through `archon trigger inspect`. Scheduled skips and fires without a delivery ID or source run produce no notice. These notices share the same bounds and listing/watch paths; see [trigger admission](/guides/workflow-triggers/#choose-a-resource-capacity-and-overlap-policy) for preparation failure behavior.

### The full protocol for programs

`--watch --protocol --json` is the stream for a program that keeps its own copy of the open set. It writes every change across every run in scope, with a `ready` marker, a `bookmark` heartbeat and a line for every run that ends or resumes, and it can replay from a cursor with `--after`. A person or an answering agent does not need it: the plain watch above is a filter over this stream.

A stream starts with one `attention` line per readable open item, with `snapshot: true`, and one identifier-free `degraded` warning for each batch report of an affected paused run (an unreadable row or a readable parent whose descendant cannot be read), then a `ready` line. Startup awaits acceptance of each line before `ready`. Without degradation, the snapshot is the complete open set: an item you held that is absent is gone. With degradation, absence alone cannot establish that work is gone. After `ready`, the stream follows every change the store commits, whichever process made it: a detached run, a trigger, the server, another host on the same database.

| `type` | When | Fields |
|---|---|---|
| `attention` | An item opened or changed | `cursor`, `snapshot`, `project`, `workflow`, `parentRunId`, `item` |
| `resolved` | An item this stream sent closed or was replaced | `cursor`, `project`, `runId`, `workflow`, `parentRunId`, `occurrence`, `reason`; with `reason: "answered"`, also `answeredVia`, `answeredBy`, `answeredFromRun` and `answeredAt` |
| `unmatched` | A label write moved an open item outside `--label` | `cursor`, `project`, `runId`, `workflow`, `parentRunId`, `occurrence`, `revision` |
| `terminal` | A run ended | `cursor`, `project`, `runId`, `workflow`, `parentRunId`, `status`, `outcome`, `cause`, and `reason` on a launch failure or failed outcome |
| `resumed` | A failed run resumed, an engine-cancelled fan-out child recovered, or a paused or stale-running run resumed and cleared a stored error | `cursor`, `project`, `runId`, `workflow`, `parentRunId`, `status: "running"` |
| `owner_lost` | A running run's owner process on this host is gone | `cursor`, `project`, `runId`, `workflow`, `parentRunId`, `observedStatus` |
| `notice` | A node or the engine [recorded a notice for a run](#notices-what-the-work-did) | `cursor`, `project`, `runId`, `workflow`, `parentRunId`, `at`, `node`, `text`, `labels` |
| `ready` | Initial snapshot delivery finished; coverage may be degraded | `cursor` |
| `bookmark` | 30 seconds passed with no other line, and the stream read the store up to `cursor` | `cursor` |
| `degraded` | A snapshot item cannot be read or projected, or repeated failure to project a run; coverage may be incomplete. The stream keeps running | `cursor`, `reason: "run_unreadable"` |
| `error` | `--after` named a cursor this install did not issue, or the store no longer reads the stream's position. The last line; exit 4 | `error: "cursor_invalid"` |

- **Every line carries `needs`**, as the [plain watch](#stream-the-queue) describes it. A stream started with `--after` cannot know which items the earlier stream held, so at `level=quiet` it sends every `resolved` and `unmatched` line.
- **`answeredBy` is who answered an attention wait**, when the answer recorded it: `{ "declared": "<name>" }` for a name given with `--as`, which is a claim Archon does not check, or `{ "userId": "<id>" }` for an answer through a chat platform. It is null for a gate and for an answer that named nobody.
- **`answeredFromRun` is the run an answer was given from**: `{ "runId", "nodePath" }` when a workflow node answered an attention wait, and null for an answer from outside a run and for a gate. No flag or request field sets it: Archon reads it from the node's environment, which a node process can change, so treat it as attribution and not as proof. An answer can carry both it and `answeredBy`.
- **Keep an open set keyed by `runId`.** Each `attention` line replaces that run's item, including when its kind or `resetAt` changes while `revision` stays 1. `resolved` removes it. Its `reason` is `answered`, or `withdrawn` when the run resumed, ended, was deleted or moved to a different pause. For a fan-out child, remove only that child.
- **Deliveries are at least once.** Replacing by `runId` is idempotent. Dedupe answerable pauses on `(runId, occurrence, revision)`, and `terminal` and `resumed` on `(runId, cursor)`. Don't dedupe every kind by occurrence: usage-limit waits have none. `owner_lost` is a live observation and is not replayed. Only a run whose recorded owner is on this host and user can be reported lost.
- **Reconnect from a cursor before any event you did not finish.** A cursor names a feed event, and one event can emit two lines with the same cursor (`resolved` then `attention`, or `resolved` then `terminal`). `--after <cursor>` skips the whole event, so checkpoint only on a handled `bookmark` or from before the partly handled event. The new stream sends the snapshot and `ready`, then replays readable changes after the cursor. If the cursor is rejected, reconnect without `--after`.
- **A silent stream is not reading.** A stream that cannot read the store sends no `bookmark`, so no line for well over 30 seconds means it is stuck.
- **`degraded` means gaps.** The operator log names the run that failed to project; the warning does not. Repair the read failure, reconnect to refresh the open set, and replay from a cursor before the gap to recover missed transitions. The stream sends no recovered signal.
- **Filter by parent.** Every run line carries the run's `workflow` and `parentRunId`, the same values as the queue item's. A `workflow` of null means the stream could not read the run's row, because it was deleted, so that line's `parentRunId` says nothing. Keep top-level runs with `workflow != null and parentRunId == null`, or one parent's direct children with `parentRunId == "<run-id>"`. `ready`, `bookmark`, `degraded` and `error` have no `workflow` field and must pass through the filter, for example `jq 'select((has("workflow") | not) or (.workflow != null and .parentRunId == null))'`.
- **A failed run says where it failed.** On a `terminal` line with `status: "failed"`, `cause` is `{ node, errorClass }`: the first failed node from the run's terminal record, and the failure kind that node's failure recorded, such as `exec_failed` or `timeout`. `errorClass` is null when the failure recorded no kind, as older runs did. `cause` is null for other statuses, for a run that failed outside a node, and for a run that ended before terminal records existed. A replayed line keeps the cause it had, even after the run resumed and failed again. For a recorded `launch_failed` event, `reason` is `["launch failed before the first node"]` and `cause` is null. This fixed indication is stable on replay too. The line never carries error text; read it with `archon workflow get <run-id>`, which prints the first line of the failed node's error as `Reason:`, falling back to the run's own error when no failed-node error is available, including launch failures.
- **A failed outcome says why.** On a `terminal` line with `outcome: "failed"`, `reason` is up to two lines of at most 200 characters from the value the workflow's `returns:` node produced: its first lines when it is text, or its text fields as `key: text` when it is an object. A workflow that reports a failed outcome should put its diagnosis there. `reason` is absent when the node returned no text. The text watch prints these lines under the run, and `archon workflow get <run-id>` prints them as `Reason:` and carries them as `reason` in `--json`.
- **`--label` filters `attention`, `resolved` and `notice`.** `terminal`, `resumed` and `owner_lost` arrive for every run in scope. A label write that leaves an item outside the filter sends `unmatched`.
- **Items report the row when the stream read it.** The stream reads about once a second, and PostgreSQL wakes it on each commit. A pause opened and answered between two reads may never appear.

The stream only reads. Stopping it affects no run.

### Stream over HTTP

`GET /api/runs/attention/stream` is the full protocol as server-sent events. Add `level=quiet` to receive only the lines the plain `--watch` writes, or `level=notices` for the lines `--watch --notices` writes; `level=protocol` is the default. A `level=quiet` stream that resumes from `Last-Event-ID` also sends every `resolved` and `unmatched` line, because the server cannot know which items the earlier connection sent; ignore one for an item you do not hold. Each line above is one event, and the event's `data` is the line exactly as `--watch --protocol --json` writes it, `needs` included, so switch on its `type`. Events have no `event` name, so one `onmessage` handler receives every line. The scope is the whole install unless `project` names one; `label=k=v` repeats as on the list route. It needs the same API access as the list route.

The event `id` is a cursor to resume from. A browser `EventSource` sends the last one back as `Last-Event-ID` when it reconnects, which works as `--after` does: the new stream sends the snapshot and `ready`, then replays readable changes after that cursor. The id is the cursor of the last event whose lines were all sent, so a reconnect can repeat lines of the event in progress but never skips one. Dedupe repeats with the keys above. Some lines carry no `id`; the client keeps the one it has.

On an `error` line the server ends the stream. Close the `EventSource` and open a new one without `Last-Event-ID`; the lines before `ready` are the open set. The stream ends when the client disconnects.
