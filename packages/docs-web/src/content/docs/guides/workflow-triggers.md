---
title: Start workflows from schedules and signed webhooks
description: Configure governed workflow starts from native schedules, GitHub events, and Standard Webhooks.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 10
---

Native schedules, GitHub events, and Standard Webhooks deliveries start ordinary governed workflow runs through triggers. A trigger binding selects the workflow, execution user, inputs, execution host, shared resource, and overlap policy. The schedule or webhook decides when to request a start; it does not bypass workflow validation, provider configuration, isolation, or resource admission.

Schedules and event bindings are deployment configuration. They do not belong in workflow YAML.

Every binding names a `hostId`. A host prepares accepted work for its own ID, admits it, and starts the run. Two hosts ship with Archon:

- The server, when `ARCHON_TRIGGER_HOST` names its host ID. It prepares and starts work as soon as a webhook receipt commits, and it checks for queued work every few seconds, so a queued start begins shortly after the run blocking it ends. The server never guesses its host ID; without `ARCHON_TRIGGER_HOST` it records webhook receipts but starts nothing.
- The CLI, through `archon trigger fire` and `archon trigger drain --host <hostId>`. Each admitted run executes in its own detached `trigger execute` process, and when that run ends the same process drains its host again, so queued work and [starts the end caused](#start-a-stage-when-a-run-on-an-item-ends) are admitted with no other command.

Both hosts use the same admission records, so a server and a scheduled CLI command can serve the same host ID without starting a run twice.

## Find runs needing your input

The console's **Needs your input** banner lists readable runs that need attention, including triggered runs and runs older than the first page of the feed. Approval gates keep their decision and response controls. A `wait: attention` run shows its question with answer controls for its form and an **Abandon** action; a wait paused before attention waits took answers shows **Resume** instead. A run that holds its item while its owner is gone, so later starts of its workflow on that item wait behind it, is listed as **Owner gone** with the item and **Resume** and **Abandon** actions; the engine never ends it by itself. The run's own page shows the same answer controls under its log.

If stored run data cannot be read, the console shows a separate repair advisory without answer or abandon controls. These runs receive no browser or chat attention notice. Operator logs identify the unreadable runs without exposing stored origin contents; repair the data and read again. See [incomplete attention reads](/getting-started/operate/#the-queue-contract).

Keep the console open to receive live updates from runs started by another process. **Dismiss** hides an occurrence for this browser session; reloading or a new pause brings it back. Resuming still requires the server to have access to the run's working path.

## Get notified with the console closed

In **Settings → Alerts**, enable **Also notify this browser when the console is closed** and allow notifications. Subscription requires a signed-in web user or an identity supplied by your trusted authentication proxy. Push works over HTTPS or localhost in a browser supporting Web Push. On iOS, first install Archon as a home-screen web app.

Every opted-in browser on this install receives notices for readable approval gates and `wait: attention` pauses, including runs started by the CLI or triggers. Runs already rendered inline by a chat plugin are excluded. A notified run also gets a completion notice. Notifications name the workflow and the kind of attention; messages, outputs and identities stay in Archon. Click the notification to open the run page and act there.

The first browser subscription quietly records existing pauses as a baseline. New pause occurrences are delivered once across scans and server restarts. Archon sends before recording delivery, so a crash can cause a duplicate. If only some browsers receive a push, the next scan retries every browser. These duplicates replace the same browser notification because its tag is the run ID. There is no per-browser delivery ledger.

Disable the toggle to unsubscribe this browser. Expired subscriptions are removed when the push service returns 404 or 410. With no subscriptions, no pushes or delivery rows are written. In-tab alerts remain an independent setting.

Archon generates VAPID keys once in `ARCHON_HOME/web-push-vapid.json`, with owner-only file permissions. Preserve that file with the install's state: replacing it invalidates existing browser subscriptions. Browser vendors carry the encrypted minimal push payload; Archon needs outbound HTTPS access to their push services.

## Get notified in chat

An installed chat plugin that declares the `attentionNotices` capability can post to a
channel when a run needs attention. Add a route to `~/.archon/config.yaml`; repository
config cannot carry routes:

```yaml
attentionNotices:
  - platform: slack
    destination: C0123456789
```

`destination` is passed to the plugin unchanged; its meaning, such as a channel id, belongs
to the plugin. Restart the server after changing routes. A route whose platform has no
installed plugin, or whose plugin lacks the capability, is logged at startup and shows as
`misconfigured` in `/api/health`; the server still starts.

Each route receives one message per readable approval gate or `wait: attention` pause occurrence,
across scans and server restarts, including runs started by the CLI or triggers. The message
carries the gate's decisions or the wait's form and options, so the plugin can offer them as
actions. A re-ask of the same gate is a new occurrence and gets a new message. A notified run
gets one follow-up when it finishes, in the conversation the plugin returned for its notice.
Runs started from a chat thread whose plugin renders run events are excluded: they already
show in that thread. Archon sends before recording delivery, so a crash can cause a duplicate.

A route records pauses that are already open as a baseline instead of sending them. Until the
route has delivered or baselined anything, it baselines again at each startup, so a pause
that opens while the server is down is not sent for a route that has never had a pause.

Actions from chat go through the plugin's allowlist, its identity resolution and the same
authorization as every surface: the run's starter or an admin may act. A chat member acts as
the Archon user their platform identity resolves to; link it to your existing user with
`archon user link <id> slack:U123` to act on runs you started elsewhere.

## Show progress on the item's tracker

`archon serve` can keep one status comment on the issue or pull request an [item](/reference/cli/#items) is about, and post a new comment when someone has to act or the work is over, so someone reading the tracker sees what Archon is doing with it without opening Archon. It is off unless `~/.archon/config.yaml` turns it on; repository config cannot carry it:

```yaml
itemTracker:
  includeUsage: false   # cost and token counts on the comment; off unless true
  projects:
    - project: acme/widgets                     # the item's project, as GET /api/items shows it
      repo: { host: github.com, path: acme/widgets }
      keys:
        - { prefix: 'issue-', kind: issue }     # item issue-42 is issue 42 of acme/widgets
        - { prefix: 'pr-', kind: pr }           # item pr-17 is pull request 17
```

An item names its tracker subject only through its key. The rest of the key after a prefix must be a plain number (`issue-42`, not `issue-042` or `issue-42a`), and no prefix in a project may start another. An item whose key matches no rule gets nothing. Give runs those keys with `workflow run --item issue-42` or `trigger fire --item issue-42`; a stage that a run-ended binding starts stays on the item of the run that ended.

The status comment carries the marker `<!-- archon-item-status -->` and lists the item's runs in the order they started: the workflow, `in progress` or how it ended (`completed`, `failed`, `cancelled`), and the outcome it completed with. Below the table it links the newest pull request a run on the item opened through `archon forge pr.create`. The comment is written when a run on the item starts and edited when one ends or resumes, never for progress inside a run, so after the first post an edit sends no notification. Archon writes it one way: nothing reads the comment back.

A new comment is posted once for each of these, each with its own marker, so a retry edits it instead of posting twice:

- **A question.** A run on the item paused at an approval gate or an attention wait: the wait's message, its options and recommendation, and the command that answers it, `archon workflow answer <run-id> --occurrence <id> --choose <option>` (or `archon workflow respond <run-id> <decision>` at a gate). Marker `<!-- archon-item-question: … -->`.
- **An ask.** A completed run left an [ask](/reference/cli/#workflow-answer) on the item: its question, context, options with what each does and costs, the recommendation, and `archon workflow answer --ref ask:<id> --choose <option>`. Marker `<!-- archon-item-ask: <id> -->`.
- **A ruling.** A ruling recorded on the item with `archon workflow rule`: its text and when it was recorded, never who recorded it. A ruling withdrawn before the tracker saw it is not posted. Marker `<!-- archon-item-ruling: <id> -->`.
- **The result.** A run on the item ended, no run on the item is still live, no ask is open, and no stage that a [run-ended binding](#start-a-stage-when-a-run-on-an-item-ends) started on the item is still waiting for its run: the stage that ended last, how it ended, its outcome and the proposed change. A result held back by an open ask is posted once the ask is answered or withdrawn. While a run on the item cannot be read, no result is posted and the status comment says so. Marker `<!-- archon-item-result: <run-id> -->`. A run that resumes and ends again edits its result comment to show the new end, also when `archon serve` did not see it running in between.

Answer from the commands; a reply on the tracker is not read.

Archon adds no local paths, user names or ids, prompts, chat messages, node progress, logs, run results or error text to a comment; a failed run shows only its status. The text of a question, an ask or a ruling is posted as it was written, without redaction, so what its author put in it is what the tracker shows. Cost and token counts appear only with `includeUsage: true`.

Writes go through the forge plugin's `workitem.comment.upsert` operation. At startup the server checks each project's plugin once: a plugin that does not claim the host, lacks the operation or has no credential is logged as `item_tracker.misconfigured`, shows as `tracker:<project>` with state `misconfigured` in `/api/health`, and writes nothing until a restart. A write that fails is logged as `item_tracker.write_failed` and retried on the next scan; one the forge refuses for good, such as a key naming an issue that does not exist, is not retried until a restart. A failed write never fails or delays a run.

Turning the tracker on writes nothing for what an item already holds: the first startup records its ended runs, open questions, open asks and rulings as shown. The tracker counts as on from the first time `archon serve` finds a run on the project; a run that starts and ends while the server is down before then is treated as history too. Only `archon serve` writes the comment; a CLI-only install writes none. Two installs, or two projects, that map the same issue edit the same comment, which is not supported.

## Find your run-as user ID

Every binding names the Archon user whose provider configuration and credentials the run uses, as `runAsUserId`. To use your own CLI identity, run:

```bash
archon trigger whoami
```

It prints `runAsUserId`, the ID to put in the binding, and `cliIdentity`, the name it resolved from `ARCHON_USER_ID` or `$USER`. It creates the Archon user for that identity when none exists yet. Use the same store for this command and the host that executes the binding: the same `ARCHON_HOME` with `store: files`, or the same `DATABASE_URL` with database storage. User IDs belong to that installation store.

A workflow pack can declare the bindings it recommends. [`archon pack bindings`](/reference/cli/#pack-bindings) writes them as the files described below for one repository, and you register each as this page describes.

## Configure a native macOS schedule

Create `/Users/alice/.archon/triggers/repository-refresh.json`:

```json
{
  "version": 1,
  "sourceInstanceId": "macbook-repository-refresh",
  "binding": {
    "bindingId": "repository-refresh",
    "bindingRevision": null,
    "hostId": "alice-macbook",
    "runAsUserId": "2a568f73-e217-40ca-b17d-a784d19fd43a",
    "resource": "github:acme/widgets:refresh",
    "overlap": "queue",
    "launch": {
      "cwd": "/Users/alice/Projects/widgets",
      "workflowName": "refresh-repository-state",
      "inputs": {
        "repository": "acme/widgets"
      },
      "isolation": {
        "kind": "default"
      }
    }
  },
  "schedule": {
    "intervalSeconds": 1800,
    "runAtLoad": true
  }
}
```

The workflow declares the input the binding passes, so a typo in the binding fails preparation instead of reaching the run:

```yaml
name: refresh-repository-state
inputs:
  repository: { required: true }
nodes:
  # ...
```

`intervalSeconds` is required and has no default. `runAtLoad` is also required. Set it to `true` to request one start when launchd loads the job, or `false` to wait for the first interval.

`schedule` itself is optional. A configuration without it is a [fire-only binding](#start-a-binding-only-with-trigger-fire).

Test the binding once before installing it:

```bash
archon trigger fire --config /Users/alice/.archon/triggers/repository-refresh.json
```

The command returns a durable receipt and disposition, then runs accepted work in the background. Install the per-user LaunchAgent after the one-shot request succeeds:

```bash
archon trigger schedule install --config /Users/alice/.archon/triggers/repository-refresh.json
```

Archon installs only jobs in the `com.archon.trigger.*` namespace. The plist contains the absolute executable and arguments, working directory, `ARCHON_HOME`, and the `PATH` of the shell that ran `install`, so scheduled runs find `bun`, `uv`, `gh`, git credential helpers, and provider CLIs where your terminal finds them. launchd's default `PATH` is only `/usr/bin:/bin:/usr/sbin:/sbin`. The plist does not copy provider credentials or other environment variables. Scheduled runs use the same native provider configuration and credentials available to the configured user, so a credential that exists only as a variable in your shell is not there: keep it where the provider stores its login, or in Archon's config.

Use `archon trigger list` to find recent native or webhook receipts, then inspect a receipt or resource-start request by its UUID:

```bash
archon trigger inspect 1f3be5de-4e63-4da2-b352-20d95ba83b37
```

Remove future firings with the same configuration file:

```bash
archon trigger schedule remove --config /Users/alice/.archon/triggers/repository-refresh.json
```

Removing a schedule does not cancel work that Archon already accepted. To change its interval or startup behavior, or to record a changed `PATH`, remove the existing job before installing again. A schedule installed before Archon recorded `PATH` needs the same remove and install once; until then its runs cannot find tools outside launchd's default `PATH`.

### macOS scheduling limits

The installed LaunchAgent runs in the current user's GUI login domain. The user must be logged in, and logout ends that launchd session. No scheduler runs while the computer is powered off.

`StartInterval` behavior during sleep or while the prior command is still running is native launchd behavior and differs across macOS releases. Archon does not promise replay of missed intervals. `runAtLoad` requests one invocation when the job loads; it is not a missed-run queue.

For plain schedules, use the trigger workflow to read the current source state when it runs. To report identified items from an external system, use the [polling recipe](#poll-a-system-that-cannot-send-webhooks). Do not depend on one invocation for every wall-clock interval.

## Drive the same commands from Linux or Windows

Archon does not install or manage Linux or Windows scheduler definitions. Configure the host scheduler to run the same one-shot command with an absolute executable path, an absolute config path, the configured working directory, `ARCHON_HOME`, and a `PATH` that contains the tools your workflows run, such as `bun`, `uv`, `gh`, and provider CLIs:

```text
/opt/archon/bin/archon trigger fire --config /home/alice/.archon/triggers/repository-refresh.json
```

A server with `ARCHON_TRIGGER_HOST` set already drains its host. Without a running server, schedule a cold drain for a host that receives webhook starts but has no timer binding:

```text
/opt/archon/bin/archon trigger drain --host build-host-1
```

Use the first command as a systemd `ExecStart` or cron command on Linux. On Windows Task Scheduler, set the absolute Archon executable as the program and pass `trigger fire --config C:\Users\Alice\.archon\triggers\repository-refresh.json` as its arguments. Configure the working directory and `ARCHON_HOME` separately in the scheduler.

These recipes share Archon's trigger boundary, but the host scheduler owns login, sleep, wake, missed-time, and credential-loading behavior. Test the real scheduled task under its configured user before relying on unattended execution.

## Start a binding only with `trigger fire`

A binding file without `schedule` is fire-only: no clock starts it. A workflow node, a script or an operator starts it with `archon trigger fire --config <file>`, and the start goes through the same receipt, resource admission, capacity, overlap policy and deduplication as a scheduled one. Use it for a workflow that other runs start, such as a follow-up a run requests when it finishes. A fire from inside a node records the requesting run on the receipt (see [preparation and retained records](#preparation-and-retained-records)).

```json
{
  "version": 1,
  "sourceInstanceId": "widgets-follow-up",
  "binding": {
    "bindingId": "widgets-follow-up",
    "bindingRevision": null,
    "hostId": "alice-macbook",
    "runAsUserId": "2a568f73-e217-40ca-b17d-a784d19fd43a",
    "resource": "github:acme/widgets:follow-up",
    "overlap": "queue",
    "launch": {
      "cwd": "/Users/alice/Projects/widgets",
      "workflowName": "follow-up",
      "inputs": {},
      "isolation": { "kind": "default" }
    }
  }
}
```

`archon trigger schedule install` refuses a fire-only binding, because it has no timer to install. A `schedule` that is present must be complete: a file with an empty or partial `schedule` is invalid, not fire-only.

## Put a start on the item its event names

A binding can declare which field of its start's event names the [item](/reference/cli/#items) the run is on, so a run that an event starts belongs to the issue or pull request the event is about. `item` holds the `field` and an optional fixed `prefix`; the key is the prefix followed by the field's value, with a number written in decimal. There is no expression: the engine reads one field and gives the key no other meaning.

In a fire-only file, `item` sits beside `binding`, and `field` is a key of the fire's `--inputs`:

```json
{
  "version": 1,
  "sourceInstanceId": "widgets-build-round",
  "binding": { "bindingId": "widgets-build-round", "...": "as in the fire-only file above" },
  "item": { "field": "number", "prefix": "issue-" }
}
```

`archon trigger fire --config widgets-build-round.json --inputs inputs.json` with `{"number": 42}` in `inputs.json` starts a run on item `issue-42`. The fired start's item is chosen in this order:

1. `--item <key>`, or no item with `--no-item`, when the fire passes it. The mapping is not read.
2. The binding's `item` mapping. A run that fires the binding while on another item still starts on the mapped item.
3. The item of the run that fired it, as [items](/reference/cli/#items) describe.

A fire whose `--inputs` lacks the field, or holds it empty or as anything but text or a number, is refused before anything is recorded or started, and the error names the binding and the field. A redelivery of a recorded `--delivery-id` keeps the item of its first acceptance.

A GitHub source plugin binding declares `item` beside `inputMapping`, and `field` is one of the plugin's event fields, checked against the selector's event kind when the configuration loads:

```json
"item": { "field": "subject.number", "prefix": "issue-" }
```

Two events about the same issue start runs on the same item. An event whose field is unavailable rejects that binding, and its receipt records the binding as `rejected` with the reason (`Item: field 'subject.number' is missing`); other bindings the event matches still start, each on its own mapped item or on none.

A timer file refuses `item`, since a tick is about no item, and so does a run-ended file, whose start is on the ended run's item. Items need the database store and a [registered project](/reference/cli/#items): on the file store, a start whose binding maps an item is refused before a run starts.

## Start a stage when a run on an item ends

A trigger file with `on.runEnded` starts its binding when a run of a named workflow completes with a named outcome on an [item](/reference/cli/#items). It is how one stage hands an item to the next with no node that fires anything: the hand-off is a file the deployment owns, the engine reads it at the moment a run completes, and the start goes through the same receipt, preparation, admission, capacity, overlap and queue order as any binding start.

The file lives in `ARCHON_HOME/triggers/` (`~/.archon/triggers/` by default), for example as `~/.archon/triggers/build-after-plan.json`. Write it somewhere else first, for example as `build-after-plan.json`, and add it with `archon trigger add` as shown below the example, never by saving it there directly:

```json
{
  "version": 1,
  "sourceInstanceId": "build-after-plan",
  "binding": {
    "bindingId": "build",
    "bindingRevision": null,
    "hostId": "alice-macbook",
    "runAsUserId": "2a568f73-e217-40ca-b17d-a784d19fd43a",
    "resource": "build",
    "overlap": "queue",
    "launch": {
      "cwd": "/Users/alice/Projects/widgets",
      "workflowName": "build",
      "inputs": {},
      "isolation": { "kind": "default" }
    }
  },
  "on": {
    "runEnded": {
      "workflowName": "plan",
      "outcome": "planned",
      "inputs": {
        "plan": { "result": "/plan" },
        "issue": { "input": "issue" }
      }
    }
  }
}
```

A workflow pack can declare this hand-off as a [`run_ended:` binding](/reference/workflow-language/#pack-bindings); [`archon pack bindings`](/reference/cli/#pack-bindings) writes it, checked, to its `--out` directory for one repository; `archon trigger add` registers it.

```bash
archon trigger add build-after-plan.json
```

`trigger add` copies the file into `ARCHON_HOME/triggers/` under a `.tmp` name and then renames it to its own name, replacing a file of that name. Every process that completes a run reads each `*.json` there, and a file that is not complete JSON fails that run, in any project on the install. The engine reads only names ending in `.json`, so a run that completes during the copy sees the old file or the whole new one, never part of one. To change a registered file, edit a copy elsewhere and add it again; do not edit it in place. `trigger add` does not check what the file says: run `archon trigger check` after it. A file that is completely written but invalid still fails the run that reads it.

Every process that completes a run reads each `*.json` file in that directory that has `on`, at each completion, so a new file applies to the next run that ends and removing it turns the binding off. Archon reads these files only from the install's home, never from a repository. Bindings do not belong in workflow YAML. `archon trigger check` lists every run-ended binding that is active and checks it against the workflows of the project it launches in.

A binding starts once for an ended run that meets all of these:

- The run is on an item. A `workflow:` child is created with no item, so a parent that runs two stages as children never starts a third from one child's outcome.
- Its workflow is `workflowName`, matched exactly.
- It completed with `outcome`: a value of the outcome the workflow declares in [`returns: { node, outcome }`](/reference/workflow-language/), or `succeeded` or `failed` for a boolean outcome. A failed or cancelled run starts nothing; it only frees its resource. A run whose `returns:` node did not complete, for example because a `when:` skipped it, completes with no outcome and starts nothing. The command that ended it prints that, `archon workflow runs --item <key> --json` shows its `outcome` as `null`, and `archon workflow get <run-id>` shows which node was skipped.
- The binding's `launch.cwd` is in the item's project. A run of a workflow with the same name in another project never starts it. A `launch.cwd` that does not exist is in no project, so the binding is skipped; `archon trigger check` reports it.

Two files that bind the same outcome of the same workflow to the same stage in one project each write their own receipt, so the stage starts once per file on the item. A binding that starts the workflow that ended starts it again each time a run completes with that outcome, a loop the file's author owns; to repeat work inside one run, use a [`loop:` node](/reference/workflow-language/) instead. `archon trigger check` reports both.

The started run is on the same item. `inputs` maps each input of the started workflow to data from the ended run, and nothing else:

- `{ "result": "<JSON Pointer>" }` reads the ended run's result, the output of its `returns:` node, with an RFC 6901 pointer. `""` passes the whole result. It pins the result of the run whose end started the stage; a stage that declares a [`result_of` input](/reference/workflow-language/#reading-an-earlier-runs-result) instead reads the latest completed run's result when it starts, with no mapping.
- `{ "input": "<name>" }` passes one of the ended run's own inputs, so a stage can hand on what it was given, such as the item's text or a policy path. An input the run was not given passes nothing.

The values are resolved when the run completes and frozen into the start's receipt, where `archon trigger inspect` shows them. As with other event inputs, they reach only a workflow that declares them under `inputs:`.

A result pointer that names nothing in the result starts nothing. The run still completes, because its own work succeeded, but the command that ended it prints that the next stage was not started, naming the file and the pointer, and `archon trigger list` shows the receipt as `unmatched` with the same `reason`. `archon trigger check` cannot catch this: whether a pointer resolves depends on what the run returned. The receipt is the end's one hand-off, so fixing the file does not start the owed stage. Fix the file, then start the stage by hand with the inputs the binding should have passed, written to a JSON file:

```bash
archon trigger fire --config ~/.archon/triggers/build-after-plan.json --item <key> --inputs inputs.json
```

A run on an item is refused before it starts, naming the file, when a run-ended binding its end could fire in its project is broken: the started workflow does not exist or does not declare an input the binding maps, the ended workflow does not declare the binding's outcome or an input it reads, or, for a binding with [`checkout: "ended-run"`](#work-in-the-checkout-the-ended-run-left), either workflow pins `worktree.enabled: false`. The run is cancelled before its first node, so a binding that names a missing stage is found before the stage feeding it does any work. With `--detach`, the refusal is the command's result and the run is cancelled before the child starts. `archon trigger check` reports these problems, and also a `launch.cwd` that does not exist, a binding that starts the workflow that ended, and two files that start the same stage, which no run is refused for.

A file can change while a run is running. The ended run fails instead of completing, naming the file, when a file in the directory is not JSON or has an invalid `on`, when two files with `on` share a `sourceInstanceId`, or when a binding for the ended workflow in its project names an outcome that workflow cannot complete with or reads an input it does not declare. A run never completes without the hand-off it owes. Fix the file, then run `archon workflow resume <run-id>`; the resumed run completes and writes the start.

The start is written in the same database transaction that completes the run, so it exists exactly when the end does. A run completes once, so its end causes each start once. Right after the commit, the CLI process that ended the run prepares the starts its own completion wrote, each on the host its binding names, and spawns each admitted run's executor, as `trigger fire` does for its receipt. A hand `archon workflow run` needs no trigger host for the next stage to start.

That process drains a host's queue only when it serves the host: a `trigger execute --host <hostId>` process drains `<hostId>`, and any other CLI process, such as `workflow run`, `workflow cancel` or `workflow abandon`, drains the host `ARCHON_TRIGGER_HOST` names when it is set. Other work queued on a host is that host's to drain.

A run the server ends, one started from the Web UI, chat, a webhook or the server's own trigger host, has no such step. A start on the host the server's `ARCHON_TRIGGER_HOST` names begins on the server's loop, within about five seconds. A start on any other host, or on any host when the server has no `ARCHON_TRIGGER_HOST`, waits as a pending binding until that host drains: run `archon trigger drain --host <hostId>` there, or schedule it. A binding whose feeding stage runs on the server should name the server's host.

If the process dies after the commit, what is left depends on how far it got:

- **Before the start was admitted**, the start waits as a pending binding until the next drain of its host: another run ending there, a `trigger fire`, `archon trigger drain --host <hostId>` or the server's loop. That drain starts exactly one run.
- **After the start was admitted and before its executor was spawned**, the start's run exists as `pending` and holds its slot, but no process runs it. Nothing tells a dead process from a slow one, so no drain retries it. `archon workflow runs --item <key>` shows it as admitted and not started, with the command that runs it, and `archon trigger list` lists it under its receipt's `awaitingExecution`. Check it with `archon trigger inspect <request-id>`, then run it once with `archon trigger execute <request-id> --host <hostId>`. A second `trigger execute` of the same request is refused.

While a start waits it has no run yet. `archon workflow runs --item <key>` lists it under the item's starts waiting to start (`queued` in `--json`), with its request id, resource and how many queued starts of that resource and host are ahead of it, or, with none ahead, that it is next for a free slot, and the host that drains it; `archon trigger withdraw <request-id>` withdraws it. A queued start that waits behind another run of its workflow on the item names that run ([below](#one-run-of-a-workflow-per-item)). A start its binding's `overlap: skip` refused is listed under the item's refused starts (`skipped` in `--json`).

`archon workflow runs --item <key> --json` lists the item's runs in the order they started, each with an `awaitingExecution` (above, `null` unless its start is admitted and not yet running), a `heldBehind` (`null` unless it is a start waiting behind another run of its workflow on the item) and a `cause`: `{"kind": "run_ended", "runId", "sourceInstanceId"}` for a start a run's end caused, where `sourceInstanceId` is the trigger file's, `{"kind": "asks_settled", "runId"}` for one the settling of a run's asks caused ([below](#start-a-stage-again-when-its-asks-are-answered)), `{"kind": "run_fired", "runId", "node"}` for one a node fired, `{"kind": "receipt", "receiptId", "sourceInstanceId"}` for any other trigger, or `null` for a start by hand. The receipt records the ended run as its `sourceActor` (`{"source": "archon-run-ended", "id": <run id>, "display": <outcome>}`) and uses the ended run's ID as its delivery ID. Start times on SQLite have one-second resolution; runs that start in the same second are listed in the order they were written.

Run-ended bindings need the database store, as items do. With `store: files`, `archon trigger check` refuses any run-ended file, and such a file never fires: the file store refuses every run on an item, and a run with no item causes nothing.

### See how a pack's stages connect

`archon pack graph <pack> --json`, or `GET /api/packs/{pack}/graph?codebaseId=<id>`, reads a pack's stages and the arrows between them for one project: a run that ended with an outcome, or the settling of the asks a run left. A drawing, a console view or an agent can build from it alone. A pack with stages `plan`, `build` and `ship`, whose `.pack/pack.yaml` declares `build-after-plan` and `ship-after-build`, with only the first file copied into the triggers directory:

```json
{
  "pack": "factory",
  "stages": [
    {
      "name": "plan",
      "returns": "decide",
      "outcome": {
        "field": "outcome",
        "form": "enum",
        "values": [
          { "value": "planned", "startsNothing": false },
          { "value": "blocked", "startsNothing": true }
        ]
      },
      "asks": true,
      "nodes": [
        { "id": "read", "kind": "agent", "dependsOn": [], "loopGroup": null, "blocks": [], "fanOut": null },
        { "id": "decide", "kind": "agent", "dependsOn": ["read"], "loopGroup": null, "blocks": [], "fanOut": null }
      ]
    },
    {
      "name": "build",
      "returns": "verdict",
      "outcome": {
        "field": "outcome",
        "form": "enum",
        "values": [
          { "value": "built", "startsNothing": true },
          { "value": "stuck", "startsNothing": true }
        ]
      },
      "asks": false,
      "nodes": [
        { "id": "rounds", "kind": "loop_group", "dependsOn": [], "loopGroup": null, "blocks": [], "fanOut": null },
        { "id": "rounds.implement", "kind": "agent", "dependsOn": [], "loopGroup": "rounds", "blocks": [], "fanOut": null },
        {
          "id": "rounds.review__check",
          "kind": "agent",
          "dependsOn": ["rounds.implement"],
          "loopGroup": "rounds",
          "blocks": [{ "include": "rounds.review", "workflow": "review-block" }],
          "fanOut": null
        },
        { "id": "verdict", "kind": "exec", "dependsOn": ["rounds"], "loopGroup": null, "blocks": [], "fanOut": null }
      ]
    },
    { "name": "ship", "returns": null, "outcome": null, "asks": false, "nodes": [] }
  ],
  "arrows": [
    {
      "from": { "stage": "plan", "outcome": "planned" },
      "to": "build",
      "active": true,
      "declared": { "binding": "build-after-plan", "problems": [] },
      "installed": {
        "file": "/home/alice/.archon/triggers/factory-acme-widgets-build-after-plan-planned-1c9e0a7b33f2.json",
        "sourceInstanceId": "factory-acme-widgets-build-after-plan-planned-1c9e0a7b33f2",
        "problems": []
      }
    },
    {
      "from": { "stage": "build", "outcome": "built" },
      "to": "ship",
      "active": false,
      "declared": { "binding": "ship-after-build", "problems": [] },
      "installed": null
    }
  ],
  "fanOutBlocks": [],
  "discoveryErrors": []
}
```

- A stage is a workflow of the pack. Its `outcome` is what its [`returns:`](/reference/workflow-language/) declares, read through an `include:` when the returns node is in an included block; a boolean outcome lists `succeeded` and `failed`.
- `nodes` are the stage's nodes after includes are expanded, under the ids its runs record (`<include>__<id>`); `blocks` names the include each came from, outermost first. A `loop_group` is a node, and its body follows it: each body node has `loopGroup` set to the group's id, and its `id` and `dependsOn` are the step names its runs are recorded under (`<group>.<id>`, composing across nested groups, as in `rounds.review__check`). A body's included blocks are named the same way (`rounds.review`). An `include:` with `fan_out:` is one `compose_fan_out` node, because its width is known only at run time; its `fanOut.workflow` names its body in `fanOutBlocks`, which lists each such body's nodes once, including bodies a body fans out to.
- An arrow is `active` when a trigger file launches it in this project. A declared arrow with no file is reported with `active: false`, not left out. `to` may be a workflow outside the pack. An active arrow's `installed.problems` is what `archon trigger check` reports as the check a run gets before it starts: when it is not empty, every run of `from.stage` on an item is refused before it starts, so the arrow starts nothing until the file is fixed. A file whose `launch.cwd` no longer exists is in no project, so the end of a run never starts it; it is shown with that problem because which project it was meant for cannot be known.
- A declared binding that names a workflow which is not a stage as the pack loaded keeps the name as written, and its `declared.problems` says so. When that stage failed to load, its load error is in `discoveryErrors`; the rest of the graph is still read.
- An arrow from an [asks-settled binding](#start-a-stage-again-when-its-asks-are-answered) has `from: { "stage", "settled" }` in place of `outcome`, where `settled` is the binding's `answered`, `withdrawn` or `any`. It starts nothing for an outcome, so it does not change `startsNothing`.
- `startsNothing` marks an outcome no active arrow without problems leaves. With `asks: false` such an outcome ends in silence; whether that is right is the pack's call.
- `discoveryErrors` lists every workflow that failed to load from the source the pack was read from. A stage that failed is missing from `stages`, so a non-empty list means the graph may be incomplete.
- When the pack's workflows are not in the checkout, pass `--workflow-source <dir>` (`workflowSource=` on the API), the directory a binding's `launch.discoveryCwd` names. The arrows are still those of the checkout's project.

To draw one item's path, read `archon workflow runs --item <key> --json` (or `GET /api/items`): each run's `workflow` is a stage, its `outcome` the value it ended with, and a `run_ended` cause names the run whose end started it (`runId`) and the arrow (`sourceInstanceId`, the arrow's `installed.sourceInstanceId`).

### Work in the checkout the ended run left

By default the started run gets a fresh worktree cut from the base branch. With `"checkout": "ended-run"` in `on.runEnded`, it works on the ended run's branch at the commit that run ended on, so stages that must see the same checkout can be separate runs: build, then a check on the built commit, then build again on the same branch when the check sends it back. Each round is a run on the item, so `archon workflow runs --item <key>` shows how many times it went back, and each stage takes its own resource slot.

The binding's `launch.isolation` must be `{ "kind": "default" }`; the engine picks the checkout. The started workflow decides how it gets it:

- A workflow that changes its checkout (the default) continues in the ended run's worktree, on its branch. If that worktree is gone and the branch survives, the branch is checked out again in a new worktree. Admission keys the start by the branch, so it waits for or is skipped behind another run on that branch by its overlap policy, as with an explicit `branch`.
- A workflow with `mutates_checkout: false` gets a worktree of its own on a new branch cut at the ended run's commit. Checks run beside each other, and none of them is on the build's branch. When such a run ends, a binding with `checkout: "ended-run"` on its outcome hands on the branch and commit it was given, not its own branch.

This loop uses three bindings in `ARCHON_HOME/triggers/`, each added with `archon trigger add`. `check` declares `mutates_checkout: false` and completes with `pass` or `return`:

```json
{ "version": 1, "sourceInstanceId": "check-after-build",
  "binding": { "bindingId": "check", "bindingRevision": null, "hostId": "alice-macbook",
    "runAsUserId": "2a568f73-e217-40ca-b17d-a784d19fd43a", "resource": "check", "overlap": "queue",
    "launch": { "cwd": "/Users/alice/Projects/widgets", "workflowName": "check", "inputs": {},
      "isolation": { "kind": "default" } } },
  "on": { "runEnded": { "workflowName": "build", "outcome": "built", "checkout": "ended-run" } } }
```

```json
{ "version": 1, "sourceInstanceId": "build-after-return",
  "binding": { "bindingId": "build", "bindingRevision": null, "hostId": "alice-macbook",
    "runAsUserId": "2a568f73-e217-40ca-b17d-a784d19fd43a", "resource": "build", "overlap": "queue",
    "launch": { "cwd": "/Users/alice/Projects/widgets", "workflowName": "build", "inputs": {},
      "isolation": { "kind": "default" } } },
  "on": { "runEnded": { "workflowName": "check", "outcome": "return", "checkout": "ended-run" } } }
```

```json
{ "version": 1, "sourceInstanceId": "land-after-pass",
  "binding": { "bindingId": "land", "bindingRevision": null, "hostId": "alice-macbook",
    "runAsUserId": "2a568f73-e217-40ca-b17d-a784d19fd43a", "resource": "land", "overlap": "queue",
    "launch": { "cwd": "/Users/alice/Projects/widgets", "workflowName": "land", "inputs": {},
      "isolation": { "kind": "default" } } },
  "on": { "runEnded": { "workflowName": "check", "outcome": "pass", "checkout": "ended-run" } } }
```

The first `build` runs as usual, in a worktree on a new branch. Each later `build` works in that same worktree, sees every commit the builds before it made, and adds to them. Each `check` reads the commit the build before it ended on. `land` runs on the branch once a check passes. To pass inputs as well, add `inputs` beside `checkout`.

The branch and commit are read when the run completes and recorded on the start's receipt, where `archon trigger inspect` shows them as `checkoutFrom`. A run whose worktree its end hands to a stage keeps that worktree: its terminal record says `retained` with reason `in_use`, where it would otherwise have been removed. Nothing removes it automatically after that. `archon isolation cleanup` and the scheduled sweep keep it while the stage waits, still being prepared or queued for its resource, and report why, for example `start request <id> handed this checkout by run <id> is queued`. `archon trigger withdraw <request-id>` withdraws a queued start. Cleanup can remove the worktree once no run uses it and no start waits for it: the stage has run, or was withdrawn, skipped or refused.

A start never falls back to a fresh checkout of the base branch. It is refused instead:

- **The ended run left no branch**: it ran in place (with `--no-worktree`, or in a folder project), its worktree is gone, or its worktree is on another branch or a detached HEAD. The command that ended the run prints that the next stage was not started, and `archon trigger list` shows the receipt as `unmatched` with a `reason` that begins `Checkout:` and names the run and the path. To recover, run the ended workflow again on the item in a worktree; its end starts the stage. If its branch survives, `archon workflow run <workflow> --adopt <run-id> --item <key>` continues that branch instead of starting a new one.
- **The branch moved after the ended run's commit**, or is gone. The started run fails before its first node with `launch_failed`, and `archon workflow get <run-id>` shows the branch, the commit it is at and the commit the run ended on. So when two checks of one commit both return it, the second build start is refused once the first build has committed.
- **The project is a folder project, or the started workflow pins `worktree.enabled: false`.** Preparation fails; `archon trigger inspect` shows it. `archon trigger check` reports a binding whose ended or started workflow pins `worktree.enabled: false`; a folder project is only known when a start is prepared.

`archon trigger fire` refuses a file with `checkout`, because a fire has no ended run to take the checkout from. To start such a stage by hand on a run's checkout, run `archon workflow run <workflow> --adopt <run-id> --item <key>`, naming the run whose worktree or branch holds the work. After a read-only check, that is not the check: its own branch and worktree are throwaway, and adopting it is refused once they are cleaned up. Adopt the run the check was given, `metadata.checkout_handoff.runId` in `archon workflow get <check-run-id> --json`. Adoption does not check the commit: it continues the branch as it is now.

A worktree separates checkouts; it is not a sandbox. A check with `mutates_checkout: false` is not on the build's branch, but nothing stops its commands from writing to the repository. The commit check above is what refuses a build on a branch something else moved.

An older Archon binary that prepares one of these starts reads only the branch in `launch.isolation`: it runs the stage on that branch with no commit check and no read-only copy, or fails when it cannot check the branch out. It never uses the base branch.

## Start a stage again when its asks are answered

A stage can end with [asks](/reference/workflow-language/#asks-decisions-a-run-leaves-on-its-item) instead of guessing: the run completes, its questions open on the item, and an operator answers them. A trigger file with `on.asksSettled` starts its binding on the same item once every ask that run left is answered or withdrawn, with the answers as an input. Nothing is held open while the questions wait. The start belongs to the host the trigger file names, as a run-ended start does. It is prepared at once when the last answer is recorded by `archon workflow answer` or by a server that serves that host, and otherwise at that host's next drain ([below](#who-prepares-the-start)). Preparing a start is not running it: admission then runs it, queues it, or under `overlap: skip` skips it, as for any binding start ([capacity and overlap](#choose-a-resource-capacity-and-overlap-policy), [one run of a workflow per item](#one-run-of-a-workflow-per-item)).

A stage that ends in an ask and starts again with the answer takes two files in `~/.archon/triggers/`. `build-after-plan.json` starts `build` when `plan` ends, as [above](#start-a-stage-when-a-run-on-an-item-ends). `build-after-answers.json` starts `build` again when the asks a `build` run left are answered:

```json
{
  "version": 1,
  "sourceInstanceId": "build-after-answers",
  "binding": {
    "bindingId": "build",
    "bindingRevision": null,
    "hostId": "alice-macbook",
    "runAsUserId": "2a568f73-e217-40ca-b17d-a784d19fd43a",
    "resource": "build",
    "overlap": "queue",
    "launch": {
      "cwd": "/Users/alice/Projects/widgets",
      "workflowName": "build",
      "inputs": {},
      "isolation": { "kind": "default" }
    }
  },
  "on": {
    "asksSettled": {
      "workflowName": "build",
      "settled": "answered",
      "inputs": {
        "decisions": { "answers": true },
        "plan": { "input": "plan" },
        "issue": { "input": "issue" },
        "progress": { "result": "/summary" }
      }
    }
  }
}
```

`build` declares `returns: { node, asks }` and the inputs `plan`, `issue`, `decisions` and `progress`, none of them required: the start after `plan` passes `plan` and `issue`, and the start after the answers passes the same `plan` and `issue` again, with `decisions` and `progress`. A run that leaves asks completes; when the last of them is answered, the next `build` starts on the item with the answers as decisions already made. A run that leaves no asks settles nothing, so the loop ends there. Each file has its own `sourceInstanceId`.

A binding starts once for a set of asks that meets all of these:

- Every ask the run left is answered or withdrawn. Answering the first of two starts nothing; answering the second starts the stage. A set replaced by a later run of the same workflow on the item before it settled can no longer settle, so it starts nothing.
- The run that left the asks is a run of `workflowName`.
- `settled` matches how the set settled: `answered` when at least one ask was answered, so a set with some asks withdrawn counts as answered; `withdrawn` when every ask was withdrawn; `any` for either.
- The binding's `launch.cwd` is in the item's project, as for a run-ended binding.

`inputs` maps each input of the started workflow to data from the set and the run that left it, and nothing else:

- `{ "answers": true }` passes the settled set as a list, in the order the run left the asks. Each entry is `{ question, closedAs, answer, option, by, via, at }`: `closedAs` is `answered` or `withdrawn`; `answer` is the stored answer (`decision` and `text`), or `null` for a withdrawn ask; `option` is the chosen option's `id` and what it `does`, or `null`; `by`, `via` and `at` say who closed it, through which surface and when.
- `{ "result": "<JSON Pointer>" }` reads the result the run completed with, the output of its `returns:` node, which the run keeps on its record for this.
- `{ "input": "<name>" }` passes one of that run's own inputs.

The values are resolved when the set settles and frozen into the start's receipt. A pointer that names nothing, or a run whose record is gone when a binding reads its result or inputs, writes the receipt as `unmatched` with the reason and starts nothing. The command that recorded the answer prints it with the `archon trigger inspect` command for the receipt, and so it does for a binding whose preparation failed, for example because the stage it names is gone. The receipt is the settlement's one hand-off, so fixing the file does not start the owed stage, and `trigger fire` does not rebuild the settlement's inputs. Fix the file, then start the stage by hand with the inputs the binding should have passed, written to a JSON file: the answers as `archon workflow runs --item <key> --json` lists them, and the asking run's inputs and result.

```bash
archon trigger fire --config ~/.archon/triggers/build-after-answers.json --item <key> --inputs inputs.json
```

The start is written in the same database transaction that records the settlement, so it exists exactly when the settlement does, and a set settles once, so answering the last ask twice starts the stage once. The files are read at every close of an ask. A file that is not JSON or has an invalid `on`, or two files with `on` that share a `sourceInstanceId`, refuses the close that would settle a set, naming the file, and nothing is recorded; fix the file and answer again. A run on an item is refused before it starts when an asks-settled binding for its workflow in its project names a missing stage or an input either workflow does not declare, so a broken binding is found before the asking stage does any work.

Answering is not starting. Who may answer or withdraw an ask is unchanged: the rule of the run that left it. The started run acts as the binding's `runAsUserId`, as any binding start does, so an operator who may answer and may not start work still only answers.

`archon workflow runs --item <key>` shows the started run's `cause` as `{"kind": "asks_settled", "runId"}`, naming the run whose asks they were. The receipt records that run as its `sourceActor` (`{"source": "archon-asks-settled", "id": <run id>, "display": "answered" | "withdrawn"}`) and uses its ID as the delivery ID. `archon trigger check` lists asks-settled bindings under `asksSettled` and reports one whose asking workflow declares no `returns.asks`.

Asks-settled bindings need the database store, as asks do. A [`wait: attention`](/reference/workflow-language/) node is unchanged: it pauses its own run and resumes it with the answer, and starts nothing.

A workflow pack can declare this binding as an [`asks_settled:` binding](/reference/workflow-language/#pack-bindings); [`archon pack bindings`](/reference/cli/#pack-bindings) writes it, checked, and `archon trigger add` registers it.

### Work in the checkout the asking run left

By default the started run gets a fresh worktree cut from the base branch. With `"checkout": "asking-run"` in `on.asksSettled`, it works on the branch of the run that left the asks, at the commit that run ended on: a build that stopped to ask continues its change once the answer is in. The rules are those of [`checkout: "ended-run"`](#work-in-the-checkout-the-ended-run-left): the binding's `launch.isolation` must be `{ "kind": "default" }`, a workflow that changes its checkout continues on the branch, one with `mutates_checkout: false` gets a worktree of its own cut at the commit, and a start never falls back to the base branch.

```json
"on": {
  "asksSettled": {
    "workflowName": "build",
    "settled": "answered",
    "checkout": "asking-run",
    "inputs": { "decisions": { "answers": true } }
  }
}
```

The branch and commit are read when the asking run completes, not when its asks settle, and kept on that run's record with the worktree it left them in. Completion keeps that worktree, where it would otherwise have removed it: its terminal record says `retained` with reason `in_use`. Nothing else holds it while the asks are open, so `archon isolation cleanup` can still remove it, and then the start is refused. When the last ask closes and the worktree is still there, the branch and commit are handed to the start and shown on its receipt as `checkoutFrom`.

The start is refused, naming why:

- **The asking run left no branch** (it ran in place, its worktree was gone or on another branch when it completed), **its worktree is gone by the time the asks settle**, **its record is gone**, or **it recorded no checkout**, because the file gained `checkout` after the run completed or an older Archon ran it. The receipt is `unmatched` with a `reason` that begins `Checkout:`; `archon trigger list` shows it.
- **The branch moved after the asking run's commit, or is gone.** This holds for a stage with `mutates_checkout: false` too: its copy is cut only while the branch is still at that commit. The started run fails before its first node with `launch_failed`, and `archon workflow get <run-id>` shows the branch, the commit it is at and the commit the asking run ended on.

`archon trigger check`, and the check a run gets before it starts, report a binding whose asking or started workflow pins `worktree.enabled: false`. `archon trigger fire` refuses a file with `checkout`, because a fire has no asking run.

To start a refused stage by hand, pass what the binding would have passed. `--adopt` carries the asking run's checkout, not its answers or inputs, and a stage started without its answers runs without the decisions. Read the answers from `archon workflow runs --item <key> --json` (the `answers` entries of kind `ask` whose `runId` is the asking run) and the asking run's inputs from `archon workflow get <run-id> --json`, then give each input the binding maps with `--input`:

```bash
archon workflow run build --adopt <asking-run-id> --item <key> \
  --input decisions="$(cat decisions.json)" --input plan="<the asking run's plan>"
```

When the branch is gone or moved, run the asking workflow again on the item instead: adoption continues the branch as it is now and does not check the commit.

### Who prepares the start

The start is always written with the settlement, whichever surface recorded the last answer. Preparing it belongs to the host the trigger file's `hostId` names, as for a run-ended binding, so when the start is prepared depends on which process recorded that answer. Preparing it hands it to admission, which runs it at once only when its resource has a free slot and no other run of its workflow holds the item. Otherwise it waits in its host's queue under `overlap: queue`, or is recorded skipped under `overlap: skip`. The asking run is already complete when its set settles, so a binding that starts the asking workflow again is never held behind that run.

- **`archon workflow answer --ref` or `--withdraw`.** Right after the commit, the CLI process prepares the starts its settlement wrote, each on the host its binding names, and spawns the executor of each one admission admits, as the end of a hand `workflow run` does for a run-ended binding. It drains a host's other queued work only when it serves that host. No trigger host needs to be running.
- **The server: the Web UI, the API or chat.** The server runs work only for the host its `ARCHON_TRIGGER_HOST` names. A start on that host is prepared on its loop, within about five seconds. A start on any other host, or on any host when the server sets no `ARCHON_TRIGGER_HOST`, waits as a pending binding to be prepared at that host's next drain: a run ending there, a `trigger fire`, `archon trigger drain --host <hostId>` or the loop of a server that serves it. The server never prepares a start for a host it does not serve. If you answer through the server, name the server's host in the binding, or run that host's drain.
- **A process that dies after the commit.** If it died before the start was admitted, the start waits as a pending binding until its host's next drain, which prepares it exactly once and admits, queues or skips it like any other start. If it died after admission and before spawning the executor, the run exists as `pending` and no drain retries it; run it once with `archon trigger execute <request-id> --host <hostId>`, as [for a run-ended start](#start-a-stage-when-a-run-on-an-item-ends).

## Choose a resource, capacity, and overlap policy

`resource` names the work that must not overlap. Use the same sufficiently qualified resource for every schedule or webhook binding that can mutate that work. A trigger ID or workflow name does not imply a resource.

`capacity` sets how many runs can hold the resource at once. Admission reads it fresh for every start, drain and resume, from three sources, lowest first:

1. An engine default of `1` for a start that declares no number, so by default runs for one resource never overlap.
2. The capacity the start declares: a binding's `"capacity": 2` or a pack binding's `capacity:`, or, for a hand start and for a binding that sets none, the workflow's `resource: { name: build, capacity: 2 }`. Each start is checked against its own number, so bindings that share a resource do not need to agree. A drain or resume uses the number the last binding start declared.
3. The install config in `~/.archon/config.yaml`, which wins:

   ```yaml
   concurrency:
     resources:
       build: 5
   ```

   The key is the resource exactly as runs hold it: a workflow's `resource:` name, or a binding's full `resource` when its workflow declares none.

Raising a capacity admits queued work at the next drain or start. Lowering it ends no run that holds a slot; it only blocks new admissions until enough holders finish. Capacity `1` means runs for the resource never overlap.

The `overlap` setting controls a request that arrives while the resource is full:

- `skip` records the blocking run and retains no promise to execute later.
- `queue` retains the prepared request in its host's durable FIFO order.

When a `trigger fire` with a delivery ID and source run is skipped, the engine records one notice on the source run if its shared 50-notice allowance has room, even after the run ends. The notice names the binding, resource and blocking run or request and says the fire was dropped rather than queued. Inspect it with `archon workflow attention --notices --since 24h --json` or follow `archon workflow attention --watch --notices`. Scheduled skips and fires without a delivery ID or source run produce no notice. At or above the ceiling, admission records the skip without a notice. The skip remains visible through `archon trigger inspect`. A storage failure still fails admission and the host reports the preparation failure. Replaying the same delivery adds no second notice.

A queued request blocks newer starts of its own host on the same resource, so a host's queue keeps its order, except work held back because another run holds its checkout (below). A queued request of another host is waiting only for that host to drain it: it holds no slot and blocks nothing, keeps its place, and takes the next free slot when its host drains. So a hand start takes any free slot, and a drain admits its own host's requests past another host's older ones. On a busy resource, hand starts and a host that drains often can therefore delay the queued work of a host that drains less often. Different resources can run concurrently. Pending and running root runs hold their resource; a run releases it when it completes, fails, or is cancelled.

A paused run gives back its resource at a host-continued wait or gate. Once its process stops at a time or event wait, or at an approval gate or attention wait, the run releases its slot and later work can be admitted. Its continuation takes a slot again before it executes, ahead of queued new starts, because the run never lost its admission. When the resource is full, the run stays `paused`, keeps any answer it was given, and waits for capacity: `archon workflow wake` reports it as `waiting_for_capacity`, and a continuation host retries it about once a minute. Paused runs that wait for capacity take free slots in the order they were first refused. A refused resume keeps the run's place once it is ready to continue, its wait due or signaled or its pause answered, whichever surface resumed it. A refused resume of a run that is not ready records no place, so it holds no capacity. A parent blocked on a child workflow, a container write-back, and any container run keep their slot until they continue, because no continuation host retries them. A run paused because its source is unreadable also keeps its slot, even when a continuation host will retry it. Automatic continuation of waits, gates and unreadable-source pauses requires a continuation host: `archon serve`, or [`archon workflow wake --watch`](/reference/cli/#workflow-wake). Runs paused before this behavior existed keep their slot until they continue.

A run admitted on a resource holds its checkout until it completes, fails, or is cancelled, including while it is paused and has given back its slot. Admission therefore passes over a queued request that would run in a checkout another run admitted on the same resource holds: the same `in-place` directory, or the same explicit worktree `branch` in that codebase. The request keeps its place in the queue, and the free slot goes to the next request that can run. When that run ends, the request is admitted ahead of later requests for that checkout, one request per checkout at a time. A new request for a held checkout queues, or with `skip` is skipped, with the holding run as its blocker. A worktree lane without a `branch` gets its own checkout and is never held back this way.

### One run of a workflow per item

A start that names an [item](/reference/cli/#items) is not admitted while another run of the same workflow on that item is not terminal, whatever the capacity and whether or not the workflow declares `resource:`. Two starts that name one item and one workflow, from a repeated trigger, an item event that arrives twice, or an operator and an agent starting the same stage, therefore never work the item in two checkouts at once. The start waits or is refused by the policy it already has:

- A binding start follows its binding's `overlap`. With `queue` it stays queued, keeping its place, and is admitted by a drain once the holding run ends. With `skip` it is recorded skipped with the holding run as its blocker.
- A hand start (`archon workflow run`, chat or API) waits as a `pending` run and prints `Waiting for item '<key>'` with the holding run, then starts when that run ends. `--no-wait` refuses it instead and names the holding run.
- A failed run on the item stays failed while another run of its workflow holds the item; `archon workflow resume` refuses it and names that run.

A run holds its item from admission until it completes, fails, or is cancelled, including while it is paused. A hand start that is still waiting holds nothing, so a waiting process that dies strands nothing. Starts of the workflow on another item, starts of another workflow on the item, and runs on no item are admitted as before. `archon workflow runs --item <key>` shows each waiting or skipped start and the run it is held behind, and says when that run's owner is gone, with `archon workflow resume <run-id>` and `archon workflow abandon <run-id>`; the engine never ends the holding run by itself.

Guarded starts also wait behind live runs outside the resource, including manual runs and runs on other resources, when they hold the same directory or registered reusable worktree. The holding run is named in inspection. Workflows declaring `mutates_checkout: false` can proceed beside these foreign holders; same-resource checkout serialization still applies. The resolved declaration is captured during preparation, so later workflow edits do not change a queued request. Older stored requests without that declaration are treated as guarded. Admission observes holders without changing their state. Foreign pending runs hold their checkout only during the executor's five-minute dispatch window; running and paused holders keep blocking until they end. Expiry releases only foreign checkout occupancy, leaving the pending run and any resource admission unchanged.

A drain processes untouched queued requests assigned to one host and admits them while the resource has free capacity.

Host listing retains failures for damaged requests assigned to the selected host, including malformed launches or a file request that disagrees with its containing slot. The host drains independent resources before reporting those failures together, preserving the request ID and original error (and the document path for file requests). On a damaged resource, drains can admit valid predecessors up to the first malformed request; they never pass that entry. Damaged data stays unchanged for repair. Direct resource drains use the same valid prefix and log the damaged request ID; new admission, resume, and request inspection remain strict. `trigger fire` reports failures belonging to its receipt as command failures. Failures belonging to other receipts, or whose receipt cannot be identified, produce warnings while the accepted receipt is printed; `trigger drain` still fails for any reported drain failure.

In the file store, a missing or corrupt slot queue or request envelope may hide which host owns a candidate. Listing reports those unclassifiable candidates as unattributed failures with their document paths and original errors. The host attempts independent resources before reporting failure. Unreadable slot membership reports its document error when it could affect admission, drain, or resume. An intact admitted request on a different resource with a provably separate checkout does not prevent independent work from draining. Repair damaged documents before relying on drain to reach their resource or checkout. A request whose host is known is reported as a failure even when it is the resource's only queued member. A start receipt that cannot be read or validated is reported on every host pass as an unattributed failure naming its document path and keeping the original error. Its bindings are not prepared until the document is repaired; the document is left unchanged, and other receipts and queued requests continue.

The server rechecks its own host about every five seconds, including requests waiting on foreign holders. On a CLI-only host, the process that ends a run starts what its end caused and drains the host it serves (see [who drains](#start-a-stage-when-a-run-on-an-item-ends)), so work queued behind that host's runs is admitted when they end. `archon trigger drain --host <hostId>` runs one drain and can run after every earlier Archon process has exited, because the queue is durable. A CLI-only host still needs it, scheduled or by hand, when queued work waits on something no run of that host ends: a slot, checkout or item held by a hand start or by another host's run, a process that died between a run's end and admitting the start it caused, or a request whose foreign holder ends. Neither recovers a request that was already admitted to a run; run that with `trigger execute` (below).

A malformed stored checkout-guard declaration is never admitted. Drains pass over that request and log `resource_start.invalid_queued_guard` with its request ID, so valid queued work can continue. The request stays queued and can be inspected and withdrawn with the trigger CLI. New starts with malformed declarations are rejected before storage.

If a known foreign admitted run has a missing or corrupt stored launch and no recorded working path, admission cannot identify its checkout. Guarded starts targeting an in-place path or explicit branch wait (or skip) with that run named as blocker until its launch is repaired or it ends; read-only starts and branchless worktrees can still proceed. SQL logs `db.foreign_launch_invalid_checkout_unknown` or `db.foreign_launch_missing_checkout_unknown` with the foreign run ID.

The file store records admitted run membership in its slot independently of the request, retaining it when a paused run gives back capacity. Slot documents written by older versions remain readable; releasing an older holder records its membership before removing the capacity holder. In both stores, surviving local slot membership requires a matching admitted request; admission, drain, and other local resumes fail until that evidence is repaired or the holder ends. Recorded slot membership determines whether a holder is local or foreign, even when its request falsely names another resource. A request that disagrees with its local slot membership is rejected; a proven foreign holder still permits read-only starts.

A run released by an older version may have neither retained membership nor a capacity holder. Its request alone cannot establish its resource: a request with readable admitted status, resource, and prepared launch keeps that checkout serialized even for read-only starts, while independent checkouts can proceed. Damaged `hostId`, `id`, `overlap`, `blocker`, or `position` fields do not prevent this checkout-only observation. Direct local requests and resume still require a valid complete request. Unreadable checkout projections fail admission and direct drains explicitly. An intact admitted request without contradictory slot membership can resume through normal capacity arbitration, including a paused or failed run released before the upgrade. The checkout remains held while the run is paused.

When independent slot membership is absent, a historical resume trusts the surviving structurally valid admitted request's resource association. If that resource field was damaged to name another valid resource, serialization on the original resource is not guaranteed until the admission evidence is repaired or the holder ends. Surviving contradictory membership is still rejected, guarded starts still wait behind foreign checkout holders, and capacity waiters keep their original priority.

If an older released holder also loses its request document, the stored data cannot distinguish it from a manual run. It receives foreign-holder behavior, so read-only starts can pass it even on its former resource. Preserve or repair the request and slot membership before relying on same-resource serialization in that damaged state.

An owned launch that records a preparation error, such as failing to create isolation, ends its still-pending run as `failed`. The full error remains in `trigger inspect` (by receipt or request ID) and `workflow get`. Attention watchers show the run ID and `launch failed before the first node`, without error text. Terminal runs no longer hold resource capacity, so the next drain can admit queued work.

If a request was admitted but its run remains `pending`, for example because its host stopped or was killed without recording a preparation error, inspection supplies an explicit `trigger execute` retry. `archon trigger list` names such requests under each receipt's `awaitingExecution`, and `archon workflow runs --item <key>` shows them on the item. The engine admits only one execution claimant. A drain does not retry it automatically, and the run keeps holding its resource until it runs or is abandoned. Archon does not infer failure from process death. Server launch errors log `resource_start.start_failed` with the run ID and the `archon trigger inspect` command for its recorded status and recovery options.

To stop a running run that a `trigger execute` process owns, use `archon workflow cancel <runId>`. Cancel stops its safely targetable process groups, then records the run as `cancelled`, which releases the resource. If node output pipes remain held, cancel warns that an unsignalled process still holds them. POSIX host commands that started or completed also produce a warning about possible untracked background work, including after continuation. Neither a survivor nor cleanup is confirmed. These owner-stop warnings retain owned checkouts; inspect processes with `lsof`, verify ownership, and stop leftovers before checkout reuse or removal. The next drain admits queued work for it. A run the server executes has no detached owner process, so `archon workflow cancel` refuses it and leaves it unchanged; cancel it from that server instead (Web UI, API, or chat).

A `trigger execute` process stopped with SIGTERM or SIGINT marks its own running run failed before it exits, which also releases the resource. A crash or SIGKILL cannot do that and leaves ownership ambiguous.

If an admitted run has ambiguous ownership after a crash, inspect the request and its blocking run. `archon workflow abandon` is the explicit escape hatch here. If the run's owner answers on this host, abandon stops its safely targetable process groups before recording the run cancelled. A waiting start can then be admitted, even if an output-holder warning reports that an unsignalled process still holds node output. Abandon retains owned checkouts when owner-stop warnings report held output or possible untracked background work, including descendant checkouts and their root. Use `lsof` on the retained checkout before reusing or removing it. If no owner answers, abandon records the run cancelled and prints the host and pid the run recorded; an owner on another host cannot be stopped from here, so verify it has stopped before abandoning. Archon does not abandon a run because it is old or unreachable. Automatic queue draining and recovery of ambiguous execution are separate operations.

### Workflows that declare a resource

A workflow can name the resource its runs hold with a top-level `resource:` field:

```yaml
name: build
description: Build one item
resource: build
nodes: [...]
```

Every run of that workflow then takes a slot on the resource, however it starts: `archon workflow run`, a chat or API start, a `workflow:` sub-run, or a binding. A binding that starts it admits the run on the workflow's resource instead of the binding's own `resource`, so binding starts and hand starts count against one slot, and the binding's `capacity` is a declared capacity for the workflow's resource. The name is used as written: `concurrency.resources.build` in the install config is the number for every workflow that declares `resource: build`, across projects.

To set the capacity that starts of the workflow declare, write `resource: { name: build, capacity: 3 }`. Hand starts and sub-runs declare it, and so does a binding start whose binding sets no `capacity`; a binding's own `capacity` wins over it. Without either, a start declares 1. The number applies to that start only; a drain uses the number the last binding start declared.

A hand start of a full resource waits as a `pending` run and prints `Waiting for resource 'build'`, then starts when a slot frees. It waits only while no slot is free: a queued trigger request holds no slot, so a hand start takes a free slot before it, and on a busy resource can delay queued work. A hand start holds no queue position itself, so a waiting process that dies strands nothing. A queued request moves when its own host drains; a hand start does not drain another host's queue. `archon workflow run --no-wait` refuses instead and names the resource and the run holding it. Interrupting the wait (Ctrl-C or SIGTERM) fails the pending run, so it leaves no pending run and no request. On Windows a signal ends the process at once, so an interrupted wait there leaves a `pending` run to end with `archon workflow abandon`. If admission fails while the start waits, for example because the install config became invalid, the run is cancelled with the reason; a run an operator cancels while it waits ends without a slot.

An included workflow runs inside its parent's run and takes no slot of its own. A `workflow:` sub-run takes none when one of its ancestor runs already holds the same resource, so a workflow that runs another declaring its resource holds one slot. A sub-run whose ancestors hold no slot on its resource waits for one like a hand start. A workflow without `resource:` that no binding starts takes no slot; a start of it on an item still waits for another run of it on that item ([one run of a workflow per item](#one-run-of-a-workflow-per-item)).

A hand start of a workflow that declares a resource waits for its item the same way. While another run of the workflow holds the item, the slot is not given to it even when one is free, and it prints `Waiting for item '<key>'` instead of the resource.

## Configure GitHub event starts

Every webhook route (`/webhooks/github`, `/webhooks/gitea`, and `/webhooks/sources/:sourceInstanceId`) accepts bodies up to **32 MiB (33,554,432 bytes)**, inclusive. A larger body receives HTTP **413** before its signature is checked, including a streamed delivery without `Content-Length`. Archon stops reading at the limit and creates no receipt or workflow start. Other API routes do not have this limit.

GitHub event starts use an installed source plugin. The maintained plugin is temporarily housed in this repository; it has its own module entrypoint and does not require the GitHub chat adapter or an outbound GitHub token.

From a source checkout, build the module with `bun run --cwd packages/adapters build:github-source-plugin`, then copy `packages/adapters/dist/github-source-plugin.mjs` to an operator-owned plugin directory. The compiled module can load outside the Archon source tree. Installation and module paths are explicit in this release; marketplace installation is separate work.

Set `WEBHOOK_SECRET` for the server process, set `ARCHON_WEBHOOK_SOURCES` to the absolute path of the host configuration below, and set `ARCHON_TRIGGER_HOST` to the `hostId` the bindings name (`build-host-1` below) so the server starts the runs. Configure GitHub's webhook URL as `https://your-archon-host/webhooks/sources/github-production`. The existing `/webhooks/github` endpoint handles conversation and wait-signaling consumers separately.

The following configuration starts `review-pull-request` when a pull request is opened against `main` in `acme/widgets`:

```json
{
  "version": 1,
  "sources": [
    {
      "sourceInstanceId": "github-production",
      "module": "/opt/archon/plugins/github/source-plugin.mjs",
      "config": {
        "version": 1,
        "host": "github.com",
        "bindings": [
          {
            "bindingId": "widgets-pr-review",
            "hostId": "build-host-1",
            "runAsUserId": "2a568f73-e217-40ca-b17d-a784d19fd43a",
            "resource": "github:acme/widgets:review",
            "overlap": "queue",
            "launch": {
              "cwd": "/srv/archon/widgets",
              "workflowName": "review-pull-request",
              "inputs": {},
              "isolation": {
                "kind": "default"
              }
            },
            "selector": {
              "kind": "pr.lifecycle",
              "actions": [
                "opened"
              ],
              "repository": {
                "host": "github.com",
                "path": "acme/widgets"
              },
              "predicates": [
                {
                  "field": "pr.base.branch",
                  "equals": "main"
                }
              ]
            },
            "inputMapping": {
              "pull_request_number": {
                "source": "field",
                "field": "subject.number"
              },
              "repository": {
                "source": "literal",
                "value": "acme/widgets"
              }
            }
          }
        ],
        "webhookSecretEnv": "WEBHOOK_SECRET"
      }
    }
  ]
}
```

The maintained GitHub source plugin supports issue and pull-request lifecycle events, issue or pull-request label changes, comments created on an issue or pull request (`comment.changed` with action `created`, from GitHub's `issue_comment` event), check-run changes, and commit-status changes. A label change carries who made it, as the `label.actor.id` and `label.actor.login` fields, and a comment carries `comment.id`, `comment.author.id` and `comment.author.login`; the comment's text is not part of the event. Selectors match an exact event kind and one of the configured actions. They can also restrict the repository, issue or pull-request number, and the predicates supported for that event kind. Input mappings copy a supported event field or supply a typed JSON literal. A required field that is unavailable rejects that binding instead of inventing a value.

The plugin authenticates the raw payload using the configured shared secret. The server validates its resolved receipt, verifies for a new delivery that the configured run-as users exist, and commits the receipt before returning success. Preparing and starting the run happen after the response, so a slow workflow never delays GitHub's delivery. An invalid signature creates no trusted receipt. A signed source event does not select the Archon user who runs the workflow. Every binding must name an authorized `runAsUserId`. The optional GitHub event actor remains provenance and never becomes an Archon credential selector.

On the first verified delivery, Archon records the source instance, delivery ID, verified-content digest, selected binding ID and revision, resolved inputs, and launch intent. Replaying the same `(sourceInstanceId, deliveryId)` reuses the original receipt and binding snapshot; changed or newly added bindings do not create starts for that delivery. Editing a binding does not turn an old delivery into a new start. Reusing a delivery ID with different verified content returns HTTP 409. When GitHub supplies no delivery ID, Archon cannot provide source-level replay deduplication.

GitHub does not automatically redeliver every failed webhook. Check delivery status in GitHub and use GitHub's explicit redelivery or your reconciliation process after a transport or processing failure. Archon retains safe receipt and disposition data for inspection; it does not retain the raw webhook body as a trigger archive.

## Start workflows from any signed webhook

The Standard Webhooks source plugin accepts the published [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md) `v1` HMAC-SHA256 scheme. It requires `webhook-id`, `webhook-timestamp`, and `webhook-signature`; vendor-specific signatures, `svix-*` aliases, and asymmetric signatures are unsupported. Every authenticated delivery with valid JSON evaluates every configured binding. Configure the sender to send only the events you need.

From a source checkout, bundle the plugin into a standalone module in an operator-owned plugin directory. The module loads outside the Archon source tree:

```bash
bun build packages/adapters/src/sources/standard-webhooks/source-plugin.ts --target=bun \
  --outfile=/opt/archon/plugins/standard-webhooks/source-plugin.mjs
```

Set `ORDER_SIGNING_SECRET` in the server environment to your sender's signing secret (`whsec_` followed by base64-encoded key bytes). Missing or invalid secrets fail at server startup. The configuration contains only the environment variable name. Set `ARCHON_WEBHOOK_SOURCES` to this configuration's absolute path and `ARCHON_TRIGGER_HOST=orders-host` to execute its bindings. Use `https://your-archon-host/webhooks/sources/orders-production` as the sender's URL.

```json
{
  "version": 1,
  "sources": [
    {
      "sourceInstanceId": "orders-production",
      "module": "/opt/archon/plugins/standard-webhooks/source-plugin.mjs",
      "config": {
        "version": 1,
        "signingSecretEnv": "ORDER_SIGNING_SECRET",
        "bindings": [
          {
            "bindingId": "process-order",
            "hostId": "orders-host",
            "runAsUserId": "2a568f73-e217-40ca-b17d-a784d19fd43a",
            "resource": "orders:processing",
            "overlap": "queue",
            "launch": {
              "cwd": "/srv/archon/orders",
              "workflowName": "process-order",
              "inputs": {},
              "isolation": { "kind": "in-place" }
            },
            "inputMapping": { "order_id": "/order/id" }
          }
        ]
      }
    }
  ]
}
```

The workflow must declare `order_id` in `inputs:`. `inputMapping` maps input names to [RFC 6901 JSON Pointers](https://www.rfc-editor.org/rfc/rfc6901): `/order/id` selects a nested field, `/items/0` selects the first array item, `~1` escapes `/`, and `~0` escapes `~`. The empty pointer `""` selects the whole JSON document. Mapped values retain their JSON types and override literals in `launch.inputs`. A missing target rejects that binding with a recorded reason; other bindings still run. Preparation rejects undeclared inputs and missing required inputs. Mapped inputs come from the event, so preparation also rejects the binding when the workflow has no `inputs:` declaration.

### Sign a delivery from a shell

This POSIX shell recipe uses OpenSSL and preserves the exact body bytes. Set `ORDER_SIGNING_SECRET` in the sender environment to the same secret as the server, and disable shell tracing when handling secrets. Do not put the secret value in command history.

```bash
body='{"order":{"id":"order-123"}}'
delivery_id='order-123@1'
timestamp=$(date +%s)
key_hex=$(printf '%s' "${ORDER_SIGNING_SECRET#whsec_}" | openssl base64 -d -A | od -An -v -tx1 | tr -d ' \n')
signature=$(printf '%s' "$delivery_id.$timestamp.$body" | openssl dgst -sha256 -mac HMAC -macopt "hexkey:$key_hex" -binary | openssl base64 -A)
unset key_hex
curl --fail-with-body 'https://your-archon-host/webhooks/sources/orders-production' \
  -H 'Content-Type: application/json' \
  -H "webhook-id: $delivery_id" \
  -H "webhook-timestamp: $timestamp" \
  -H "webhook-signature: v1,$signature" \
  --data-binary "$body"
```

`-macopt hexkey:` supplies the decoded key bytes; `-hmac` cannot represent arbitrary binary keys. OpenSSL receives the key in its process arguments, so run this recipe on a trusted sender host. Send fresh timestamps when retrying, but retain the delivery ID and exact body. Timestamps must be within 300 seconds of receipt, in either direction. During key rotation the signature header can contain space-separated `v1,<base64>` entries; any matching entry authenticates the delivery.

`webhook-id` is the durable dedup key within this source instance. A retry of a valid JSON delivery with the same ID and exact body returns 200 and creates no new receipt or start, even if a binding's run-as user has since been removed. Reusing the ID with different body bytes returns 409, even if the JSON values are equivalent. Binding edits do not change an already accepted delivery.

| Status | Meaning |
| --- | --- |
| 200 | Receipt committed, including unmatched deliveries and replays; execution happens afterward |
| 400 | Authenticated body is malformed JSON, and its malformed receipt is retained; or the body is not UTF-8, and nothing is persisted |
| 401 | Missing headers, invalid signature or invalid/stale timestamp; nothing persisted |
| 404 | Unknown source instance |
| 409 | Delivery ID reused with different content; no new receipt or start |
| 413 | Body exceeds 32 MiB (33,554,432 bytes); reading stops before authentication, with no receipt or start |
| 500 | Processing or persistence failed; investigate and retry |

### Security boundary

A valid signature proves possession of the sender's key and integrity of the delivery. It does not make customer text or other event content trustworthy. Mapped inputs reach workflow prompts and scripts as untrusted data; author workflows accordingly. Map only the fields the workflow needs. Resolved inputs are persisted with the receipt's binding, including the whole body if you use `""`, and there is no automatic retention policy. Never map credentials into inputs.

Operator configuration owns the workflow, cwd, isolation, execution host, resource, and run-as user. The body can only supply configured input values, which preparation checks against the workflow's declarations; a workflow that declares no inputs receives none. It cannot choose any launch authority. The plugin reads secrets from the environment and never logs secrets, bodies, or signature headers. The signature covers the exact received bytes, including a leading byte-order mark. Authentication completes before receipt persistence.

## Poll a system that cannot send webhooks

The host scheduler (cron, a systemd timer, launchd, or Task Scheduler) runs an operator-owned poll script. The script lists recent items and reports each with a stable delivery key made from its ID and version, encoded as a base64 JSON pair `[id, version]` in these recipes. Archon deduplicates within the configured source instance and admits the work. It keeps no poll cursor, runs no resident poller, and promises no catch-up. Choose the API's lookback window to cover scheduler downtime; items outside that window are the script's responsibility.

These POSIX shell recipes require `curl` and `jq`. The example API at `$ORDERS_URL` returns a JSON array of objects with string `id` and `version` fields. Each version must identify immutable content. Report a new version when an item changes, and keep the same key and input content across retries.

Save this workflow as `/srv/archon/orders/.archon/workflows/process-order.yaml` and validate it with `archon validate workflows process-order --cwd /srv/archon/orders`:

```yaml
name: process-order
description: Record an order reported by a poll script.
mutates_checkout: false
inputs:
  order_id: { type: string, required: true }
nodes:
  - id: record
    bash: printf '%s\n' "$INPUTS_ORDER_ID" > "$ARTIFACTS_DIR/order.txt"
```

Replace the recording node with your order handling. Event values remain untrusted and are persisted with the receipt; pass only the fields the workflow needs.

### CLI-only host

Save `/srv/archon/polled-orders.json` using your own `runAsUserId` from `archon trigger whoami`:

```json
{
  "version": 1,
  "sourceInstanceId": "polled-orders",
  "binding": {
    "bindingId": "process-order",
    "bindingRevision": null,
    "hostId": "orders-host",
    "runAsUserId": "2a568f73-e217-40ca-b17d-a784d19fd43a",
    "resource": "orders:processing",
    "overlap": "queue",
    "launch": {
      "cwd": "/srv/archon/orders",
      "workflowName": "process-order",
      "inputs": {},
      "isolation": { "kind": "in-place" }
    }
  }
}
```

The configuration has no `schedule`, so it is a [fire-only binding](#start-a-binding-only-with-trigger-fire). Schedule the poll script itself; `trigger schedule install` would fire without event values, and refuses a fire-only binding. Set `ARCHON_HOME`, `ORDERS_URL`, and a `PATH` containing the tools your workflows run for the scheduled user, and use absolute executable paths:

```bash
#!/bin/sh
set -eu
poll_dir=$(mktemp -d)
trap 'rm -rf "$poll_dir"' EXIT HUP INT TERM
curl --fail --silent --show-error "$ORDERS_URL" > "$poll_dir/response.json"
jq -c '.[]' "$poll_dir/response.json" > "$poll_dir/items.jsonl"
while IFS= read -r item; do
  delivery_id=$(printf '%s' "$item" | jq -er '[.id, .version] | @base64')
  printf '%s' "$item" | jq -cS '{order_id: .id}' > "$poll_dir/inputs.json"
  /opt/archon/bin/archon trigger fire --config /srv/archon/polled-orders.json \
    --delivery-id "$delivery_id" --inputs "$poll_dir/inputs.json"
done < "$poll_dir/items.jsonl"
/opt/archon/bin/archon trigger drain --host orders-host
```

The final drain also advances queued work on ticks with no items. Each run's own process admits the next queued start when it ends; the drain covers queued work that waits on something else, as [described above](#choose-a-resource-capacity-and-overlap-policy).

`--inputs` reads a JSON object, including from `/dev/stdin` on Unix, and treats its values as event inputs. Each name must be declared by the workflow. Event inputs override `launch.inputs` literals; literals still pass through to workflows without `inputs:`. The local operator's access to the Archon installation is the trust boundary, so `fire` needs no signature.

An identical key and inputs reuse the original receipt and still drain the retained receipt's host, even if the binding's run-as user has since been removed. Editing the binding does not start that delivery again. The digest covers `JSON.stringify` of the parsed event inputs, or `{}` when omitted, excluding binding literals. Whitespace differences in the JSON file do not matter; object key order does, so produce stable JSON (the recipe uses `jq -S`). Reusing a key with different inputs exits non-zero with a delivery conflict. Without `--delivery-id`, every fire records a new receipt, including when `--inputs` is supplied.

### Server host

Configure the [Standard Webhooks source](#start-workflows-from-any-signed-webhook) above with its `order_id: /order/id` mapping, `ARCHON_TRIGGER_HOST=orders-host`, and the same `process-order` workflow. The poll script can run on a different trusted sender host. Set `ORDERS_URL`, `ORDER_SIGNING_SECRET`, and `ARCHON_WEBHOOK_URL` (for example `https://your-archon-host/webhooks/sources/orders-production`) in that script's environment. It also needs OpenSSL:

```bash
#!/bin/sh
set -eu
poll_dir=$(mktemp -d)
trap 'rm -rf "$poll_dir"' EXIT HUP INT TERM
curl --fail --silent --show-error "$ORDERS_URL" > "$poll_dir/response.json"
jq -c '.[]' "$poll_dir/response.json" > "$poll_dir/items.jsonl"
while IFS= read -r item; do
  delivery_id=$(printf '%s' "$item" | jq -er '[.id, .version] | @base64')
  body=$(printf '%s' "$item" | jq -cS '{order: {id: .id}}')
  timestamp=$(date +%s)
  key_hex=$(printf '%s' "${ORDER_SIGNING_SECRET#whsec_}" | openssl base64 -d -A | od -An -v -tx1 | tr -d ' \n')
  signature=$(printf '%s' "$delivery_id.$timestamp.$body" | openssl dgst -sha256 -mac HMAC -macopt "hexkey:$key_hex" -binary | openssl base64 -A)
  unset key_hex
  curl --fail-with-body --silent --show-error "$ARCHON_WEBHOOK_URL" \
    -H 'Content-Type: application/json' \
    -H "webhook-id: $delivery_id" \
    -H "webhook-timestamp: $timestamp" \
    -H "webhook-signature: v1,$signature" \
    --data-binary "$body"
done < "$poll_dir/items.jsonl"
```

The server drains accepted and queued work. Re-polling sends a fresh timestamp but identical body bytes and delivery ID, so the server returns 200 without another run. A changed body under the same key returns 409. Apply the [signing recipe's security boundary](#sign-a-delivery-from-a-shell), including running OpenSSL on a trusted host with shell tracing disabled.

## Preparation and retained records

The receipt freezes the evaluated bindings and resolved inputs. The execution host later captures the workflow source and reads any `configSource` run configuration. Queue admission freezes that prepared source and configuration; editing live files afterward does not change queued work.

An input mapped from the event, by CLI `--inputs`, a Standard Webhooks JSON Pointer, or a GitHub `field` mapping, reaches only a workflow that declares it under `inputs:`. Preparation rejects a binding that maps event values into a workflow without that declaration. Literal inputs you write into `launch.inputs` or a GitHub `literal` mapping pass through to a workflow without `inputs:`, as they do for a direct run. A workflow that declares `inputs:` rejects any undeclared name, literal or mapped.

A process that stops during preparation leaves its recorded preparation owner visible. After verifying that exact process has stopped, use `archon trigger recover-preparation <receipt-id> <binding-id> --owner <recorded-owner-id> --yes`, then drain the configured host. A failed validation is recorded as rejected and requires a corrected new request.

Untouched queued work can be removed with `archon trigger withdraw <request-id>`. Receipt and admission records are retained in the installation store (database or file store). This first version has no automatic trigger-record retention policy. Do not map credentials or unnecessary source content into workflow inputs. A run started by a trigger records its receipt and binding IDs in its `resource_start` metadata; its request ID is the run ID, so `archon trigger inspect <run-id>` shows the request. When a workflow node runs `archon trigger fire`, the receipt records that run and node as its source actor, and `archon trigger inspect <run-id>` and `archon workflow get <run-id>` show them as the requesting run. It grants the started run nothing: it still runs as the binding's `runAsUserId`. CLI-hosted execution writes the ordinary run output to `ARCHON_HOME/logs/trigger-run-<request-id>.log`. Fresh trigger runs have no chat conversation or message history. Inspect their output with `archon workflow get <run-id>` and `archon workflow logs <run-id>`. Previously queued launches that carry a real conversation retain that history destination.
