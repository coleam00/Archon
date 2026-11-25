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
- The CLI, through `archon trigger fire` and `archon trigger drain --host <hostId>`. Each admitted run executes in its own detached `trigger execute` process, and when that run ends the same process drains that host and this install's hosts again, so queued work and [starts the end caused](#start-a-stage-when-a-run-on-an-item-ends) are admitted with no other command.

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

Archon can keep one status comment on the issue or pull request an [item](/reference/cli/#items) is about, and post a new comment when someone has to act or the work is over, so someone reading the tracker sees what Archon is doing with it without opening Archon. It is off unless `~/.archon/config.yaml` turns it on; repository config cannot carry it:

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

A server is optional. Three paths bring the tracker up to date, each with the same pass over every tracked project:

- **`archon serve`** runs a pass every 5 seconds.
- **A CLI process that may have started, paused, resumed or ended a run**, such as `workflow run`, `workflow approve`, `workflow cancel` or `trigger fire`, runs one pass on its way out, after the command's work. A detached run's own process runs one when the run ends. A tracker pass never changes the command's exit code; a pass it could not finish is logged and left for the next one.
- **[`archon tracker sync`](/reference/cli/#tracker)** runs one pass on demand, for example from a schedule, and reports what it posted.

One pass per project runs at a time, across every process on the database, so a server and a CLI process never post the same comment twice or edit the status comment out of order. A pass that finds another process running the project's pass asks it for one more pass and leaves the work to it; the server's timer does not ask, since it comes back in 5 seconds. A pass held by a process that is gone is taken over once the holder's own host can prove it gone. A holder on another host stays held until that host runs a pass, or until `archon tracker release <project>` lets go of it. The release cannot check whether a holder on another host stopped: a holder still running its pass keeps posting while the next pass runs, so the two can post a comment twice or edit the status comment out of order. Release a holder on another host only after confirming its process is gone.

Writes go through the forge plugin's `workitem.comment.upsert` operation. Each process checks each project's plugin once, before its first pass, so a running server checks only at startup. A plugin that does not claim the host, lacks the operation or has no credential is logged as `item_tracker.misconfigured`, and that project gets nothing from that process: the server shows it as `tracker:<project>` with state `misconfigured` in `/api/health` until a restart, and `tracker sync` reports it and exits 1. A write that fails is logged as `item_tracker.write_failed` and stays owed for the next pass; one the forge refuses for good, such as a key naming an issue that does not exist, is not retried by the same process, so a running server tries it again only after a restart and each CLI pass tries it once. A failed write never fails or delays a run.

Turning the tracker on writes nothing for what an item already holds: the first process to activate a project records the ended runs, open questions, open asks and rulings already there as shown. The server activates at startup, a CLI process before it can start, resume or pause a run, and `tracker sync` before its pass. The tracker counts as on from that first activation; anything that happens after it is posted by the next pass, whichever process runs it. Two installs, or two projects, that map the same issue edit the same comment, which is not supported.

## Find your run-as user ID

Every binding names the Archon user whose provider configuration and credentials the run uses, as `runAsUserId`. To use your own CLI identity, run:

```bash
archon trigger whoami
```

It prints `runAsUserId`, the ID to put in the binding, and `cliIdentity`, the name it resolved from `ARCHON_USER_ID` or `$USER`. It creates the Archon user for that identity when none exists yet. Use the same store for this command and the host that executes the binding: the same `ARCHON_HOME` with `store: files`, or the same `DATABASE_URL` with database storage. User IDs belong to that installation store.

A workflow pack can declare the bindings it recommends. [`archon pack bindings`](/reference/cli/#pack-bindings) writes them as the files described below for one repository, and you register each as this page describes.

## Configure a native schedule

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

`intervalSeconds` is required and has no default. `runAtLoad` is also required. Set it to `true` to request one start when the scheduler loads the job, at install and at each login, or `false` to wait for the first interval.

`schedule` itself is optional. A configuration without it is a [fire-only binding](#start-a-binding-only-with-trigger-fire).

Test the binding once before installing it:

```bash
archon trigger fire --config /Users/alice/.archon/triggers/repository-refresh.json
```

The command returns a durable receipt and disposition, then runs accepted work in the background. Install the timer after the one-shot request succeeds:

```bash
archon trigger schedule install --config /Users/alice/.archon/triggers/repository-refresh.json
```

The timer belongs to the operating system's own scheduler: a LaunchAgent on macOS, a systemd user timer on Linux, and a Task Scheduler task on Windows. Archon installs only jobs named `com.archon.trigger.*` (on Windows, under the `\Archon\` task folder). Each job runs the same `trigger fire --config <file>` command as the installing user, with the absolute executable and arguments, the working directory, `ARCHON_HOME`, and the `PATH` of the shell that ran `install`, so scheduled runs find `bun`, `uv`, `gh`, git credential helpers, and provider CLIs where your terminal finds them. A scheduler's default `PATH` lacks them; launchd's is only `/usr/bin:/bin:/usr/sbin:/sbin`. Its output is appended to `ARCHON_HOME/schedules/com.archon.trigger.<id>.log`, and `archon trigger schedule status --config <file>` reports whether the timer is installed and when it last ran. See [trigger schedules](/reference/cli/#trigger-schedules) for what each platform writes.

A tick's environment holds what the scheduler gives every job, plus that working directory, `ARCHON_HOME`, and the recorded `PATH`. Nothing else from your shell comes along. Archon loads `ARCHON_HOME/.env` at each tick, as it does at any start, so put any other variable a run needs there. Credentials stay where their provider keeps them: the `gh` login, Git Credential Manager, a provider CLI's own login. A credential that exists only as a variable in your shell is not there: keep it with its provider.

### Check bindings after an update

Run `archon trigger check` after a pack or engine update. It reads every binding file in `ARCHON_HOME/triggers`, and every timer `schedule install` installed for this `ARCHON_HOME`, wherever the timer's config file is: it reads the job definitions the scheduler holds, so a timer installed with `--config` pointing outside the triggers directory is checked too. It reports a binding whose started workflow is missing or does not load, or does not declare an input the binding passes, and a timer or [`on` binding](#start-a-stage-when-a-run-on-an-item-ends) that lacks a required input, by the same validation a start runs, against the definitions a start without an item reads: the binding's base branch as fetched now, with the launch checkout's uncommitted changes on top (see [where a run reads its definitions](/reference/configuration/#where-a-run-reads-archonconfigyaml)). A [fire-only binding](#start-a-binding-only-with-trigger-fire) missing a required input is not reported, because `trigger fire --inputs` may supply it. A timer whose config file is gone or invalid fails every tick, so check reports it with the scheduler command that removes the job by hand. These bindings are listed under `bindings`, each with its `timer` (the installed job's definition file, or null), and the command exits nonzero when any has a problem. Check only reads: it starts nothing and changes nothing.

A run that is still running when you update Archon hands off through the installed version when it ends ([after an update](#start-a-stage-when-a-run-on-an-item-ends)). A start that is already waiting, prepared and queued or held unprepared, keeps the binding and inputs its receipt froze: a waiting start whose binding is registered again without an input it used to pass is refused when it is prepared. Re-register bindings while none of their starts waits, or hold the install and let those starts run first.

Use `archon trigger list` to find recent native or webhook receipts, then inspect a receipt or resource-start request by its UUID:

```bash
archon trigger inspect 1f3be5de-4e63-4da2-b352-20d95ba83b37
```

Remove future firings with the same configuration file:

```bash
archon trigger schedule remove --config /Users/alice/.archon/triggers/repository-refresh.json
```

Removing a schedule does not cancel work that Archon already accepted. To change its interval or startup behavior, or to record a changed `PATH`, remove the existing job before installing again. A schedule installed before Archon recorded `PATH` needs the same remove and install once; until then its runs cannot find tools outside launchd's default `PATH`. A macOS schedule installed before Archon wrote its output to a log needs it once too, and until then `status` cannot say when it last ran.

### Scheduling limits

No scheduler runs while the computer is powered off, and Archon does not promise replay of missed intervals. `runAtLoad` requests one invocation when the job loads; it is not a missed-run queue. No platform starts a scheduler invocation while the previous one is still running. That invocation is `trigger fire`, which ends once it has handed its start to a background executor, so a workflow still running when the next tick comes does not stop that tick: the new start follows the binding's [overlap policy](#choose-a-resource-capacity-and-overlap-policy). The [wake job](/reference/cli/#wake-timers) uses the same rule the other way: its invocation is a `workflow wake --watch` that does not end, so the scheduler starts it again only after it exits, within the job's interval: 5 seconds by default, or a minute on Windows.

On macOS, the LaunchAgent runs in the current user's GUI login domain. The user must be logged in, and logout ends that launchd session. `StartInterval` behavior during sleep is native launchd behavior and differs across macOS releases.

On Linux, the timer runs in the user's systemd manager, which runs while the user has a session. To keep it running without one, enable lingering with `loginctl enable-linger`. A host without a reachable user manager, such as a container or WSL without systemd, has no timer to install.

On Windows, the task runs as the logged-on user, so it runs only while that user is logged on, and keeps access to the Credential Manager that `gh` and Git Credential Manager use. The task runs the job headless on a separate desktop, so neither the tick nor anything its run starts (agents, consoles, a browser) should open a window on your screen. This is not yet confirmed on a real Windows desktop; until it is, expect that a window may still appear. Nothing on that desktop can be seen, so a run that waits for a prompt, such as an expired Git Credential Manager login, waits unseen until it ends. Later ticks still fire, and their starts follow the binding's capacity and overlap policy: one may run alongside the waiting run when a slot is free, and on a full resource `overlap: queue` queues it while `skip` drops it. Log in once from your own session to clear the prompt. A timer installed by an Archon that opened a console window at each run keeps doing so until you remove it and install it again. Task Scheduler repeats a task every whole number of minutes from 1 minute to 31 days, so `intervalSeconds` must be a multiple of 60 in that range.

For plain schedules, use the trigger workflow to read the current source state when it runs. To report identified items from an external system, use the [polling recipe](#poll-a-system-that-cannot-send-webhooks). Do not depend on one invocation for every wall-clock interval.

## Drive the same commands from another scheduler

Use this on a host with no scheduler `schedule install` supports, or when you prefer your own. `schedule install` on such a host prints the exact command to schedule by hand. Configure the scheduler to run the same one-shot command with an absolute executable path, an absolute config path, the configured working directory, `ARCHON_HOME`, and a `PATH` that contains the tools your workflows run, such as `bun`, `uv`, `gh`, and provider CLIs:

```text
/opt/archon/bin/archon trigger fire --config /home/alice/.archon/triggers/repository-refresh.json
```

A server with `ARCHON_TRIGGER_HOST` set already drains its host. Without a running server, schedule a cold drain for a host that receives webhook starts but has no timer binding:

```text
/opt/archon/bin/archon trigger drain --host build-host-1
```

The host scheduler owns login, sleep, wake, missed-time, and credential-loading behavior. Test the real scheduled task under its configured user before relying on unattended execution.

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

### When a node starts other work

A node that runs `archon trigger fire`, or starts other work through the CLI, can fail for two reasons that its error does not name.

**`archon` on `PATH` is another install.** The node fails with `Unknown command: trigger`, or another unknown command or flag, while the same command works in your terminal. A node finds `archon` on its own `PATH`, and a scheduled run has the `PATH` recorded when its schedule was [installed](#configure-a-native-schedule), so an older global install, such as an `archon.exe` from an earlier Windows setup, can come before the install running the workflow. Name the install's own CLI instead:

1. In a `runtime: bun` script, call `trigger.fire` from [`archon:script`](/guides/script-nodes/#the-script-api). It already uses the running install's CLI.
2. Anywhere else, run the argv in `ARCHON_CLI_COMMAND` (see [workflow host integration](/reference/forge/#workflow-host-integration-and-audit)). In a bash node with `jq`: `cli=(); while IFS= read -r arg; do cli+=("$arg"); done < <(jq -r '.[]' <<<"$ARCHON_CLI_COMMAND"); "${cli[@]}" trigger fire --config <file>`.
3. Otherwise, name the CLI by absolute path.

A container execution receives no `ARCHON_CLI_COMMAND`, so start the work from a node that runs on the host.

**The node's run has no GitHub identity.** This applies only with [per-user GitHub identity](/adapters/github-app-setup/#step-8-optional-enable-per-user-github-identity) on, to a run whose user has not connected a token. Archon scrubs GitHub credentials from that run's nodes, and a CLI a node starts inherits the scrub: Archon's env files do not restore it inside a run, and the forge credential lookup reports an empty `GH_TOKEN` as missing rather than asking `gh` for the host's login. The node's own `gh` and git commands stay scrubbed.

The work a node fires does not use the calling run's credential. The fire reads the remote (default-branch detection, the item's landing branch, the base branch its definitions come from) with the binding's `runAsUserId` credential. The process that executes the started run carries that user's credential too, so the git Archon runs before the first node (the landing check, worktree fetches, submodules), the forge check and the nodes all use it, for `gh` and for git over HTTPS to `https://github.com`. So only the run-as user needs a token, connected with [`archon auth github`](/reference/cli/#auth-github). [`archon trigger whoami`](#find-your-run-as-user-id) prints the user for your CLI identity.

When the run-as user has no token, the fire and the started run are scrubbed as well, and nothing falls back to the calling process's or the host's login. A fired start that reads its definitions from the base branch of a private repository over HTTPS fails before admission with `Cannot read <ref>, the base branch this run's definitions come from: ...`, or `Cannot read the base branch for this run's definitions: ...` when the base is detected from the remote. A workflow that declares forge needs is refused before admission with `credential environment GH_TOKEN or GITHUB_TOKEN is empty`, and others fail at their first GitHub command that needs authentication. A public repository still fetches anonymously, and SSH remotes still use the host's SSH keys. `ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK=true` is not a fix for one node; it lets every unconnected user's run on the install use the shared token.

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

## Land an item's runs on its own branch

A chain of stages on one item (order, plan, build, land) is cut from the project's base branch unless the item says otherwise. Record the branch the item's change lands on, and every stage a trigger file starts on the item works in a worktree cut from that branch, with `$BASE_BRANCH` set to it, so the change it proposes targets that branch:

```bash
archon workflow landing --item WO-12 --branch feat/checkout-redesign --from origin/main
archon workflow link --item issue-42 --kind part_of --to WO-12
archon workflow link --item issue-43 --kind part_of --to WO-12
```

`--from` creates `feat/checkout-redesign` on the project's remote from that remote's `main` before recording it. The example assumes the remote is `origin`; with `worktree.remote: upstream`, name `upstream/main`, the tracking branch of the remote that is fetched. A branch the remote already has is left as it is. Leave `--from` out to record a branch that exists, or one you will create later. `issue-42` and `issue-43` record no branch of their own, so their stages take the branch of the item they are part of. Their changes land together on `feat/checkout-redesign`, can be tested there as a whole, and the work order lands once on the base. A stage run on `WO-12` itself also targets `feat/checkout-redesign`; start the final landing onto the base with `--base <base>`, or on another item.

A start takes its base in this order, highest first:

1. `--base` on a `workflow run`.
2. The item's own landing branch.
3. The landing branch of an item it is `part_of` through an active link, nearest first. Two items at the same distance with different branches refuse the start, naming both.
4. The binding's `launch.isolation.baseOverride`. A trigger file's value is the same for every item the file starts, so the item's branch outranks it.
5. `worktree.baseBranch`, the project's stored default branch, then the remote's HEAD, as in [base branch precedence](/reference/cli/#base-branch-precedence).

The branch is read when the start runs, not when it is prepared, so a start that waited in the queue takes the branch the item records then. A run already started keeps the base it recorded. A stage that takes another run's checkout (`checkout: "ended-run"` or `"asking-run"`) keeps that checkout and reports the branch as `$BASE_BRANCH`. A stage whose binding sets `launch.isolation` to `in-place` cannot be cut from the branch, so on an item with a landing branch it fails as `launch_failed` before its first node; use `default` or `worktree` isolation. A branch the project's remote does not have fails the start as `launch_failed` before its first node, with a message naming the branch, the remote, the item it came from and the `archon workflow landing --from` command that creates it; run that, or record another branch. Nothing falls back to the base branch. `archon workflow runs --item <key>` shows the branch and where it came from. Recording again replaces the branch.

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

- `{ "result": "<JSON Pointer>" }` reads the ended run's result with an RFC 6901 pointer. The result is the value `archon workflow get <run-id> --json` shows at `terminal_record.returns.value`, the same value a `result_of` input reads: the `output_format` value of its `returns:` node, or an untyped node's text as a string, and nothing when that text passed the output cap. `""` passes the whole result. It pins the result of the run whose end started the stage; a stage that declares a [`result_of` input](/reference/workflow-language/#reading-an-earlier-runs-result) instead reads the latest completed run's result when it starts, with no mapping.
- `{ "input": "<name>" }` passes one of the ended run's own inputs, so a stage can hand on what it was given, such as the item's text or a policy path. An input the run was not given passes nothing.
- `{ "item": "answers" }` passes every answer given on the item, from every stage that left asks there, as [an asks-settled binding passes them](#start-a-stage-again-when-its-asks-are-answered). Use it when a stage started after the answers must know everything decided on the item, not only what the run that ended was given.

The values are resolved when the run completes and frozen into the start's receipt, where `archon trigger inspect` shows them. As with other event inputs, they reach only a workflow that declares them under `inputs:`.

A result pointer that names nothing in the result starts nothing. The run still completes, because its own work succeeded, but the command that ended it prints that the next stage was not started, naming the file and the pointer, and `archon trigger list` shows the receipt as `unmatched` with the same `reason`. `archon trigger check` cannot catch this: whether a pointer resolves depends on what the run returned. The receipt is the end's one hand-off, so fixing the file does not start the owed stage. Fix the file, then start the stage by hand with the inputs the binding should have passed, written to a JSON file:

```bash
archon trigger fire --config ~/.archon/triggers/build-after-plan.json --item <key> --inputs inputs.json
```

A run on an item is refused before it starts, naming the file, when a run-ended binding its end could fire in its project is broken: the started workflow does not exist or would refuse the binding's inputs (an input the binding maps or sets in `launch.inputs` that it does not declare, or a required input neither supplies), the ended workflow does not declare the binding's outcome or an input it reads, or, for a binding with [`checkout: "ended-run"`](#work-in-the-checkout-the-ended-run-left), either workflow pins `worktree.enabled: false`. The run is cancelled before its first node, so a binding that names a missing stage is found before the stage feeding it does any work. With `--detach`, the refusal is the command's result and the run is cancelled before the child starts. `archon trigger check` reports these problems, and also a `launch.cwd` that does not exist, a binding that starts the workflow that ended, and two files that start the same stage, which no run is refused for.

A file can change while a run is running. The ended run fails instead of completing, naming the file, when a file in the directory is not JSON or has an invalid `on`, when two files with `on` share a `sourceInstanceId`, or when a binding for the ended workflow in its project names an outcome that workflow cannot complete with or reads an input it does not declare. A run never completes without the hand-off it owes. Fix the file, then run `archon workflow resume <run-id>`; the resumed run completes and writes the start.

The start is written in the same database transaction that completes the run, so it exists exactly when the end does. A run completes once, so its end causes each start once. Right after the commit, the CLI process that ended the run prepares the starts its own completion wrote, each on the host its binding names, and spawns each admitted run's executor, as `trigger fire` does for its receipt. A hand `archon workflow run` needs no trigger host for the next stage to start.

A run keeps the Archon it started on, so a run that ends after you update Archon would prepare its next start with code older than the pack on disk. It does not. When the installed Archon is no longer the one the ending process loaded (a new commit in a source checkout, or a replaced or removed binary), that process prepares nothing. Its starts stay pending, and it starts `archon trigger drain --host <hostId>` from the installed Archon in the background, once for each host its starts or this install's trigger files name, so the next stage is prepared by current code with no watcher running. The drain's output goes to `ARCHON_HOME/logs/run-end-drain-<run-id>.log`. If that drain cannot start, for example because a Homebrew upgrade removed the binary the run started from, the starts wait as pending bindings for their host's next drain. A preparation that fails in a process that sees the installed Archon change, such as a `workflow wake --watch` pass on the old version, also leaves its start pending instead of rejecting it.

Then that process drains every host this install serves, so a start queued behind the slot, checkout or item the run released is admitted whoever started the run. The hosts an install serves are the hosts its trigger files in `ARCHON_HOME/triggers` name (`binding.hostId`, in a file of any form). This holds for any CLI process that ends a run, such as `workflow run`, `workflow cancel`, `workflow abandon` or `workflow answer`. The one addition is a `trigger execute --host <hostId>` process: a drain of `<hostId>` handed it its run, so its run end also drains `<hostId>`, which keeps the queue of a timer whose config lives outside the triggers directory moving. A host named only by work in a shared database, or only by `ARCHON_TRIGGER_HOST` in a CLI process's environment, is another machine's or process's: its own drain admits its work. Each pass of [`archon workflow wake`](/reference/cli/#workflow-wake) drains the same hosts, so a start whose admitting process died is admitted at the watcher's next pass. A trigger file that does not read is reported by name, and the other hosts still drain.

A run the server ends, one started from the Web UI, chat, a webhook or the server's own trigger host, has no such step. A start on the host the server's `ARCHON_TRIGGER_HOST` names begins on the server's loop, within about five seconds. A start on any other host of this install is admitted at the next CLI run end or `workflow wake` pass. On a host no trigger file on this install names, or when no watcher runs, it waits as a pending binding until that host drains: run `archon trigger drain --host <hostId>` there, or schedule it. A binding whose feeding stage runs on the server should name the server's host.

If the process dies after the commit, what is left depends on how far it got:

- **Before the start was admitted**, the start waits as a pending binding until the next drain of its host: another CLI run ending on this install, the next `archon workflow wake` pass, a `trigger fire`, `archon trigger drain --host <hostId>` or the server's loop. `archon workflow runs --item <key>` lists it under the item's starts waiting to start, with what will drain it. That drain starts exactly one run.
- **After the start was admitted and before its executor was spawned**, the start's run exists as `pending` and holds its slot, but no process runs it. No drain retries it. `archon workflow runs --item <key>` shows a start as starting, with no command, once its executor answers as the run's owner. It shows a start as not started, with the command that runs it, only when nothing can be running it: the process that handed it over recorded that the hand-off started nothing (a Windows run's job broker that refused the start before spawning its executor counts), or the process it recorded handing it to no longer exists on this host. Every other start, such as one whose executor is still booting, one handed to another host or user, one whose hand-off was never recorded, or one a Windows run's job broker started or whose relay broke off, since the broker does not report the executor's process, reads as one this process cannot confirm, pointing to `archon trigger inspect`. `archon trigger list` lists each under its receipt's `awaitingExecution`, with the same `state`. Check it with `archon trigger inspect <request-id>`, then run it once with `archon trigger execute <request-id> --host <hostId>`. A second `trigger execute` of the same request is refused.

While a start waits it has no run yet. `archon workflow runs --item <key>` lists it under the item's starts waiting to start (`queued` in `--json`), with its request id, resource and how many queued starts of that resource and host are ahead of it, or, with none ahead, that it is next for a free slot, and the host that drains it, with what will drain it: the next run end or wake pass on this install, or, for a host no trigger file on this install names, the wake watcher's next pass for a start from an observed label while the label is on the item, and otherwise that host's own drain; `archon trigger withdraw <request-id>` withdraws it. A start not yet prepared (`held` in `--json`) is listed the same way, by its receipt. A queued start that waits behind another run of its workflow on the item names that run ([below](#one-run-of-a-workflow-per-item)). A start its binding's `overlap: skip` refused is listed under the item's refused starts (`skipped` in `--json`).

`archon workflow runs --item <key> --json` lists the item's runs in the order they started, each with an `awaitingExecution` (above, `null` unless its start is admitted and not yet running; otherwise `{requestId, hostId, state, executor}`, where `state` is `starting`, `unowned` or `unknown` and `executor` is the process the start was recorded as handed to, `{host, pid, uid}`, or null), a `heldBehind` (`null` unless it is a start waiting behind another run of its workflow on the item) and a `cause`: `{"kind": "run_ended", "runId", "sourceInstanceId"}` for a start a run's end caused, where `sourceInstanceId` is the trigger file's, `{"kind": "asks_settled", "runId"}` for one the settling of a run's asks caused ([below](#start-a-stage-again-when-its-asks-are-answered)), `{"kind": "run_fired", "runId", "node"}` for one a node fired, `{"kind": "receipt", "receiptId", "sourceInstanceId"}` for any other trigger, or `null` for a start by hand. The receipt records the ended run as its `sourceActor` (`{"source": "archon-run-ended", "id": <run id>, "display": <outcome>}`) and, for a binding without [`linked`](#start-a-stage-on-an-item-when-the-items-it-links-to-end), uses the ended run's ID as its delivery ID. Start times on SQLite have one-second resolution; runs that start in the same second are listed in the order they were written.

Run-ended bindings need the database store, as items do. With `store: files`, `archon trigger check` refuses any run-ended file, and such a file never fires: the file store refuses every run on an item, and a run with no item causes nothing.

### When nothing follows a run

A run on an item can end where nothing starts: no binding starts from its outcome. If it also left no [ask](#start-a-stage-again-when-its-asks-are-answered) and no wait, nothing will move the item again. The engine records that in the write that completes the run, and `archon workflow attention` lists the item as `stopped`, with the stage, the outcome it ended in and the summary the workflow declares in [`returns.summary`](/reference/workflow-language/#workflow-signature-inputs-returns-and-inputs). The item takes no answer. It stays listed until another run starts on the item, in whatever status; a run started by hand on the item closes it. Deleting that later run does not reopen it: the delete records on the item that a run moved it on, and the stop itself is kept. An item nothing more will happen on is ended with [`archon workflow end`](/reference/cli/#workflow-end), which closes it without a run.

A run whose end does start a binding also stops its item when that start is refused: at its [start limit](#limit-how-often-a-stage-starts-on-an-item), or before launch. Before launch means at the hand-off, when the run's checkout cannot be handed on, an input the binding maps names nothing or the items it links to cannot be read, or in preparation. `refused` lists each start refused before launch, one entry per binding, beside a start limit's `limit` when there is one: its `receiptId` and `bindingId`, the `workflow` it was for, `refusedAt`, and a `reason`: `checkout_refused`, `inputs_unmapped` or `link_refused` at the hand-off; `no_default_provider` when no default AI provider is set; otherwise the preparation stage that failed (`run_as_user_failed`, `run_configuration_failed` or `launch_preparation_failed`). The latest `refusedAt` is the item's `pausedAt`. The text names each one, gives `archon ai default <provider>` for a missing provider, and always `archon trigger inspect <receipt-id>`, which shows the refusal. A foreground `archon workflow run` whose end caused the refused start prints it under its result, and still exits 0: the run itself completed. `archon workflow get <run-id>` prints it too, for a run that `trigger fire` started detached. The same holds for an [asks-settled binding](#start-a-stage-again-when-its-asks-are-answered) whose start is refused, including after a stage that declares no outcome. A start refused before launch is recorded on the causing run even when that run also left asks or waits, which the item lists first: it is `stopped` once they close with no later run. It is recorded there too when the start was on a linked item (`linked`): the causing run's item is then the one listed. Nothing retries the start; fix the cause and start the stage by hand. Only the database store records this stop. A refused start with no causing run, such as the first start on a new item or a label start, is not listed ([#6231](https://github.com/coleam00/Archon/issues/6231)).

An outcome after which the item is done, such as a landed change, is not a stop. List it in [`returns.final`](/reference/workflow-language/#workflow-signature-inputs-returns-and-inputs) and a run that ends in it is not listed. Whether a binding started something is decided once, when the run completes: a file added to the triggers directory later does not clear an item that already stopped.

`archon trigger check` lists, under `stops`, each outcome after which an item would stop: an outcome of a workflow a binding names (ended, asking, or started by any binding, including a fire-only file or an installed timer) that is not final, that no run-ended file in the project binds, of a workflow that declares neither `returns.asks` nor `returns.waits`. It is a report, not a problem: it does not change the exit status.

### See how a pack's stages connect

`archon pack graph <pack> --json`, or `GET /api/packs/{pack}/graph?codebaseId=<id>`, reads a pack's stages and the arrows between them for one project: a run that ended with an outcome, or the settling of the asks a run left. A drawing, a console view or an agent can build from it alone. A pack with stages `plan`, `build` and `ship`, whose `.pack/pack.yaml` declares `build-after-plan` and `ship-after-build`, with only the first file copied into the triggers directory:

```json
{
  "pack": "factory",
  "loaded": [{ "source": "project", "key": "factory", "dir": "/home/alice/acme/widgets/.archon/workflows/factory" }],
  "otherCopies": [],
  "stages": [
    {
      "name": "plan",
      "returns": "decide",
      "outcome": {
        "field": "outcome",
        "form": "enum",
        "values": [
          { "value": "planned", "startsNothing": false, "final": false },
          { "value": "blocked", "startsNothing": true, "final": false }
        ]
      },
      "asks": true,
      "waits": false,
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
          { "value": "built", "startsNothing": true, "final": false },
          { "value": "stuck", "startsNothing": true, "final": false }
        ]
      },
      "asks": false,
      "waits": false,
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
    { "name": "ship", "returns": null, "outcome": null, "asks": false, "waits": false, "nodes": [] }
  ],
  "arrows": [
    {
      "from": { "stage": "plan", "outcome": "planned" },
      "to": "build",
      "linked": null,
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
      "linked": null,
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
- An arrow's `linked` is the binding's [`linked`](#start-a-stage-on-an-item-when-the-items-it-links-to-end), with its `items` when it names them, or `null` when the stage starts on the ended run's own item. Its `entries` maps each input of the started stage that reads the started item's [own entry](#name-the-linked-items-that-start) to that entry pointer, for example `{ "brief": "/brief" }`, and is `{}` when none does. An active arrow shows the installed file's `entries`, an inactive one the declaration's. A declared arrow is active only through a file with the same `kind`, `holder` and `items`; `entries`, like any input mapping, does not part them.
- An arrow is `active` when a trigger file launches it in this project. A declared arrow with no file is reported with `active: false`, not left out. `to` may be a workflow outside the pack. An active arrow's `installed.problems` is what `archon trigger check` reports as the check a run gets before it starts: when it is not empty, every run of `from.stage` on an item is refused before it starts, so the arrow starts nothing until the file is fixed. A file whose `launch.cwd` no longer exists is in no project, so the end of a run never starts it; it is shown with that problem because which project it was meant for cannot be known.
- A declared binding that names a workflow which is not a stage as the pack loaded keeps the name as written, and its `declared.problems` says so. When that stage failed to load, its load error is in `discoveryErrors`; the rest of the graph is still read.
- An arrow from an [asks-settled binding](#start-a-stage-again-when-its-asks-are-answered) has `from: { "stage", "settled" }` in place of `outcome`, where `settled` is the binding's `answered`, `withdrawn` or `any`, and `option` when the binding names one ([options](#start-a-different-stage-for-each-option)); a pack binding that lists several options is one arrow per option. It starts nothing for an outcome, so it does not change `startsNothing`.
- `waits` says the stage declares `returns.waits`, as `asks` says it declares `returns.asks`.
- `startsNothing` marks an outcome no active arrow without problems leaves, and `final` one the stage lists in [`returns.final`](/reference/workflow-language/#workflow-signature-inputs-returns-and-inputs): after it the item needs nothing more. A run on an item that ends in an outcome that starts nothing and is not final, leaving no ask or wait, [stops the item](#when-nothing-follows-a-run), which `archon workflow attention` lists.
- `discoveryErrors` lists every workflow that failed to load from the source the pack was read from. A stage that failed is missing from `stages`, so a non-empty list means the graph may be incomplete.
- `loaded` is the copy of the pack the graph was read from, `{ source, key, dir }`, and `otherCopies` every other copy of the same pack in reach under another key, such as an installed `acme.factory` beside a project `factory`. Asking for that key reads that copy. `dir` is `null` for a bundled pack a compiled binary reads from its embedded bytes.
- When the pack's workflows are not in the checkout, pass `--workflow-source <dir>` (`workflowSource=` on the API), the directory a binding's `launch.discoveryCwd` names. It may be [the pack's own folder](/reference/cli/#a-pack-folder-as-the-source). The arrows are still those of the checkout's project.

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

## Start a stage on an item when the items it links to end

A run-ended binding with `linked` starts its stage on the items the ended run's item is [linked](/reference/cli/#workflow-link) to, instead of on that item. With it, a work order can start its own stage as its members finish, and an item that depends on another can start when that one finishes, with no operator watching. It is the same binding as above, read at the same moment, through the same receipt, preparation, admission, capacity, overlap and queue order, and written in the same transaction that completes the run.

```json
"on": {
  "runEnded": {
    "workflowName": "review",
    "outcome": "approved",
    "linked": { "kind": "part_of", "holder": "to" },
    "inputs": {
      "member": { "item": "key" },
      "verdict": { "result": "/verdict" }
    }
  }
}
```

- `kind` is the link kind to follow: `depends_on`, `part_of` or `duplicate_of`. The engine gives the kind no meaning; the file says which kind matters.
- `holder` is the end of the link the started item is on. The ended run's item is on the other end. A link reads from `from` to `to`, so members that are `part_of` an order (`archon workflow link --item m1 --kind part_of --to order-3`) start the order with `holder: "to"`, and an item that `depends_on` another (`--item issue-42 --kind depends_on --to issue-17`) starts when `issue-17` ends with `holder: "from"`.

Without `items` ([below](#name-the-linked-items-that-start)), the stage starts on every holder each time one of its linked items ends `workflowName` with `outcome`: an order of three members starts its stage three times. The engine does not count: the stage judges whether its item is ready, for example by reading the item's links and their runs with [`item()`](/reference/workflow-language/#reading-the-item-a-run-belongs-to) or `archon workflow runs --item`, and ends early when it is not. That is also what lets an order proceed when one member was declined, or weigh what each member returned. `inputs` maps from the run that ended as above, plus `{ "item": "key" }`, the key of the item whose run ended. A linked file cannot map `{ "item": "answers" }`: those answers belong to the item whose run ended, not to the holder the stage starts on, so the file is refused. The started stage reads its own item's answers with `archon workflow runs --item`.

Only links active when the run completes count: a link ended before then causes nothing, and an item with no active link of the kind never starts by this binding. A failed or cancelled run, or a run that completes with another outcome, starts nothing. A linked binding takes no `checkout`, because the ended run left its checkout for its own item.

`archon workflow runs --item <holder> --json` shows each started run with `cause` `{"kind": "run_ended", "runId": <the run whose end caused it>, "sourceInstanceId"}`. The receipt's delivery ID is `<ended run ID>:<holder item ID>`. `archon trigger check` checks a linked binding as it checks any run-ended binding, does not report it as a duplicate of a same-item binding to the same stage, and does not report one that starts the workflow whose end fires it, since that start is on another item. Two linked files to the same stage over the same `kind` and `holder` are reported as duplicates whatever `items` they name.

### Name the linked items that start

With `items`, the ended run decides which holders start and what each is given. `items` is a JSON Pointer into the ended run's result that holds a list. Each entry is an item key, or an object with a string `key`. Only the holders the list names start; a holder it does not name gets nothing. An input `{ "entry": <JSON Pointer> }` reads from the started item's own entry, so each start gets its own value; `""` is the whole entry. A split that links the members it creates to their parent and returns `start: [{ "key": "m1", "brief": "..." }, ...]` starts each named member with its own brief:

```json
"on": {
  "runEnded": {
    "workflowName": "split",
    "outcome": "split",
    "linked": { "kind": "part_of", "holder": "from", "items": "/start" },
    "inputs": {
      "brief": { "entry": "/brief" },
      "part_of": { "item": "key" },
      "land_on": { "result": "/land_on" }
    }
  }
}
```

- A named key whose item holds no active link of `kind` at `holder` to the ended run's item, including a key that is no item at all, is refused: an `unmatched` receipt on the ended run's item, with delivery ID `<ended run ID>:unlinked:<key>` and a `reason` that names the key and the link. The others still start, and the run still completes.
- A list that cannot be read starts nothing and is refused once on the ended run's item, naming the file and the pointer: the pointer does not resolve, its value is not a list, an entry has no key, or a key is named twice. The engine never falls back to every holder.
- An empty list starts nothing.
- An `entry` pointer that does not resolve in one entry refuses only that holder's start, on the holder.
- `{ "entry" }` is refused when the file is read unless `linked.items` is set.

`archon trigger list` shows the refusals with their reasons.

A workflow pack can declare this binding as a [`run_ended:` binding](/reference/workflow-language/#pack-bindings) with `linked`; [`archon pack bindings`](/reference/cli/#pack-bindings) writes it, checked, and `archon trigger add` registers it.

A form that starts the stage once, when every linked item has ended the workflow with the outcome, is not built yet ([issue 5867](https://github.com/coleam00/Archon/issues/5867)).

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
- With `option`, every answered ask of the set chose that option ([below](#start-a-different-stage-for-each-option)).

`inputs` maps each input of the started workflow to data from the set and the run that left it, and nothing else:

- `{ "answers": true }` passes the settled set as a list, in the order the run left the asks. Each entry is `{ question, closedAs, answer, option, by, via, at }`: `closedAs` is `answered` or `withdrawn`; `answer` is the stored answer (`decision` and `text`), or `null` for a withdrawn ask; `option` is the chosen option's `id` and what it `does`, or `null`; `by`, `via` and `at` say who closed it, through which surface and when.
- `{ "item": "answers" }` passes every answer given on the item, this settled set's included: each ask any run left there that was answered or withdrawn, in the order they were answered or withdrawn (`at`), oldest first, so an answer that changes an earlier one comes later in the list. Each entry is the `{ "answers": true }` entry plus `workflowName`, the workflow whose run left the ask. Open asks are left out, and so are asks replaced by a later run of their workflow before they settled, whose question that later run asked again. Map both when a stage needs to know what was just decided and everything decided before it: a build started by its second set of answers then still has the first.
- `{ "result": "<JSON Pointer>" }` reads the result the run completed with, which the run keeps on its record for this. It is the same value a run-ended binding's `result` reads.
- `{ "input": "<name>" }` passes one of that run's own inputs.

The values are resolved when the set settles and frozen into the start's receipt, so an answer given on the item later is not in them. A pointer that names nothing, a run whose record is gone when a binding reads its result or inputs, or an ask on the item this binary cannot read when a binding reads `{ "item": "answers" }`, writes the receipt as `unmatched` with the reason and starts nothing. The command that recorded the answer prints it with the `archon trigger inspect` command for the receipt, and so it does for a binding whose preparation failed, for example because the stage it names is gone. The receipt is the settlement's one hand-off, so fixing the file does not start the owed stage, and `trigger fire` does not rebuild the settlement's inputs. Fix the file, then start the stage by hand with the inputs the binding should have passed, written to a JSON file: the answers as `archon workflow runs --item <key> --json` lists them (for `{ "item": "answers" }`, all its `answers` entries of kind `ask`), and the asking run's inputs and result.

```bash
archon trigger fire --config ~/.archon/triggers/build-after-answers.json --item <key> --inputs inputs.json
```

A binding with `checkout`, which a fire refuses, is recovered [as below](#work-in-the-checkout-the-asking-run-left).

The start is written in the same database transaction that records the settlement, so it exists exactly when the settlement does, and a set settles once, so answering the last ask twice starts the stage once. The files are read at every close of an ask. A file that is not JSON or has an invalid `on`, or two files with `on` that share a `sourceInstanceId`, refuses the close that would settle a set, naming the file, and nothing is recorded; fix the file and answer again. A run on an item is refused before it starts when an asks-settled binding for its workflow in its project names a missing stage or an input either workflow does not declare, so a broken binding is found before the asking stage does any work.

Answering is not starting. Who may answer or withdraw an ask is unchanged: the rule of the run that left it. The started run acts as the binding's `runAsUserId`, as any binding start does, so an operator who may answer and may not start work still only answers.

`archon workflow runs --item <key>` shows the started run's `cause` as `{"kind": "asks_settled", "runId"}`, naming the run whose asks they were. The receipt records that run as its `sourceActor` (`{"source": "archon-asks-settled", "id": <run id>, "display": "answered" | "withdrawn"}`) and uses its ID as the delivery ID. `archon trigger check` lists asks-settled bindings under `asksSettled` and reports one whose asking workflow declares no `returns.asks`.

Asks-settled bindings need the database store, as asks do. A [`wait: attention`](/reference/workflow-language/) node is unchanged: it pauses its own run and resumes it with the answer, and starts nothing.

A workflow pack can declare this binding as an [`asks_settled:` binding](/reference/workflow-language/#pack-bindings); [`archon pack bindings`](/reference/cli/#pack-bindings) writes it, checked, and `archon trigger add` registers it.

### Start a different stage for each option

An ask's options can lead to different stages. `"option": "<id>"` in `on.asksSettled` narrows a binding to answers that chose that option, so one ask offering `send-back`, `replan` and `hold` can start `deliver` again on `send-back`, start `plan` on `replan`, and start nothing on `hold`. Two files on the same asking workflow do it:

```json
"on": { "asksSettled": { "workflowName": "deliver", "settled": "answered", "option": "send-back", "checkout": "asking-run" } }
```

```json
"on": { "asksSettled": { "workflowName": "deliver", "settled": "answered", "option": "replan" } }
```

The rules:

- `option` is one option `id`, as the ask declared it, and takes `"settled": "answered"`: a withdrawn ask chose nothing. When the asking workflow [declares its options](/reference/workflow-language/#declared-options-one-set-for-every-ask), `archon trigger check` reports an `option` that is not one of them (or `other`): no answer would start the binding.
- The binding starts when the set has at least one answered ask and every answered ask chose that option. Withdrawn asks are not counted. The engine compares the chosen option's `id` and never reads answer text.
- A set whose answered asks chose different options matches no binding with `option`. Neither does an answer that chose no option the ask offers, such as a text-only answer. The reserved `other` is an option, so a binding may name it.
- A binding without `option` starts as before, whatever was chosen.

`archon trigger check` reports two files in one project, on the same asking workflow, that would both start when one option is chosen: two files naming the same option, or one naming an option beside one that names none and takes answers. Two files that name no option and start different stages are not reported; several stages may start on one settlement on purpose.

When a settled set starts nothing, because no binding names the option chosen or no binding matches at all, the answer says so on every surface: `archon workflow answer` and the chat attention tool end their reply with "No trigger binding starts on this settlement, so nothing was started.", and the `--json` output and `POST /api/attention/answer` or `/withdraw` reply have `"nothingStarted": true`. A choice like `hold` reads as a stop, not as a lost start.

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

The branch and commit are read when the asking run completes, not when its asks settle, and kept on that run's record with the worktree that holds them: the run's own, or, for an asking run with `mutates_checkout: false`, the worktree of the run whose checkout it was given. Completion keeps the asking run's own worktree, where it would otherwise have removed it: its terminal record says `retained` with reason `in_use`. Nothing else holds a worktree while the asks are open, so `archon isolation cleanup` can still remove it, and then the start is refused. When the last ask closes and the worktree is still there, the branch and commit are handed to the start and shown on its receipt as `checkoutFrom`. The start checks the worktree again when it runs, so one removed while the start waited for its host or its resource is refused too; unlike `checkout: "ended-run"`, the branch is never checked out again in a new worktree.

The start is refused, naming why:

- **The asking run left no branch** (it ran in place, its worktree was gone or on another branch when it completed), **its worktree is gone when the asks settle**, **its record is gone**, or **it recorded no checkout**, because the file gained `checkout` after the run completed or an older Archon ran it. The receipt is `unmatched` with a `reason` that begins `Checkout:`; `archon trigger list` shows it.
- **The worktree is gone when the start runs.** The started run fails before its first node with `launch_failed`, naming the worktree.
- **The branch moved after the asking run's commit, or is gone.** This holds for a stage with `mutates_checkout: false` too: its copy is cut only while the branch is still at that commit. The started run fails before its first node with `launch_failed`, and `archon workflow get <run-id>` shows the branch, the commit it is at and the commit the asking run ended on.

`archon trigger check`, and the check a run gets before it starts, report a binding whose asking or started workflow pins `worktree.enabled: false`. `archon trigger fire` refuses a file with `checkout`, because a fire has no asking run.

To start a refused stage by hand, adopt the run that holds the checkout, not necessarily the asking run. It is `metadata.asks_checkout.handoff.runId` in `archon workflow get <asking-run-id> --json`: the asking run itself, or, for an asking stage with `mutates_checkout: false`, the run whose checkout it was given. The read-only stage's own copy is throwaway, and adopting it is refused once it is cleaned up, as for [a read-only check](#work-in-the-checkout-the-ended-run-left). When the answer that settled the set prints the stage as not started, it names that run in the command it prints.

Pass what the binding would have passed, too. `--adopt` carries the checkout, not the answers or inputs, and a stage started without its answers runs without the decisions. Read the answers from `archon workflow runs --item <key> --json` (the `answers` entries of kind `ask` whose `runId` is the asking run, or all of them for an input mapped from `{ "item": "answers" }`) and the asking run's inputs from `archon workflow get <asking-run-id> --json`, then give each input the binding maps with `--input`, or `--input-file` for one held in a file:

```bash
archon workflow run build --adopt <holder-run-id> --item <key> \
  --input-file decisions=decisions.json --input plan="<the asking run's plan>"
```

When `asks_checkout` records a refusal or nothing, or the worktree or branch is gone, or the branch moved, run the asking workflow again on the item instead: adoption continues the branch as it is now and does not check the commit.

### Who prepares the start

The start is always written with the settlement, whichever surface recorded the last answer. Preparing it belongs to the host the trigger file's `hostId` names, as for a run-ended binding, so when the start is prepared depends on which process recorded that answer. Preparing it hands it to admission, which runs it at once only when its resource has a free slot and no other run of its workflow holds the item. Otherwise it waits in its host's queue under `overlap: queue`, or is recorded skipped under `overlap: skip`. The asking run is already complete when its set settles, so a binding that starts the asking workflow again is never held behind that run.

- **`archon workflow answer --ref` or `--withdraw`.** Right after the commit, the CLI process prepares the starts its settlement wrote, each on the host its binding names, and spawns the executor of each one admission admits, as the end of a hand `workflow run` does for a run-ended binding, then drains this install's hosts ([who drains](#start-a-stage-when-a-run-on-an-item-ends)). No trigger host needs to be running. A start that still waits is printed with what will admit it.
- **The server: the Web UI, the API or chat.** The server runs work only for the host its `ARCHON_TRIGGER_HOST` names. A start on that host is prepared on its loop, within about five seconds. A start on any other host, or on any host when the server sets no `ARCHON_TRIGGER_HOST`, waits as a pending binding to be prepared at that host's next drain: a CLI run ending on an install whose trigger files name it, that install's next `archon workflow wake` pass, a `trigger fire`, `archon trigger drain --host <hostId>` or the loop of a server that serves it. The server never prepares a start for a host it does not serve. If you answer through the server, name the server's host in the binding, or run that host's drain.
- **A process that dies after the commit.** If it died before the start was admitted, the start waits as a pending binding until its host's next drain, such as the next `archon workflow wake` pass, which prepares it exactly once and admits, queues or skips it like any other start. If it died after admission and before spawning the executor, the run exists as `pending` and no drain retries it; run it once with `archon trigger execute <request-id> --host <hostId>`, as [for a run-ended start](#start-a-stage-when-a-run-on-an-item-ends).

## Limit how often a stage starts on an item

A loop that spans runs needs a round limit: a check returns a change to the build, the build's end starts the check again, and nothing ends it. `binding.limit` caps how many times one binding starts its stage on one item:

```json
"binding": {
  "bindingId": "check",
  "limit": { "name": "check", "starts": 3, "resetOn": "plan" },
  ...
}
```

- **What counts.** Admission counts, per item, the starts it admitted under `name` and those still queued, since a queued start is already promised. A start that waited in the queue across a reset counts in the new count once it runs. A start that was skipped, refused or withdrawn does not count. The count lives in the item's start requests, so it survives restarts. Every binding file that names the same `name` counts against one number.
- **At the limit.** Admission refuses the next start, in the transaction that would admit it, and writes no request and no run. The binding is `rejected` with a reason that names the limit, the item and how many starts were used; `archon trigger list` and `archon trigger inspect <receipt-id>` show it. When a run's end (a run-ended binding) or its settled asks (an asks-settled binding) caused the refused start, and that run left no open ask or wait, nothing follows the run, so `archon workflow attention` lists the item as [`stopped`](#when-nothing-follows-a-run) with a `limit`: its `name`, `starts`, `granted` and `used`, and the `bindingId` and `workflow` of the refused start. A start of that workflow on the item by hand, or a start a granting binding makes, moves the item on and closes the listing. A refused start that a fire, a schedule or a node caused is not listed. The engine writes no ask.
- **Reset.** When a run of `resetOn` completes on the item, the count starts again, and so do the grants: only starts and grants made after that completion count, plus starts still waiting in the queue at that moment, which run after it. The completion is recorded in event order, so a start in the same second as the reset still counts on the side it happened. Without `resetOn` the count never resets by itself. The reset is recorded apart from the run, so cleaning up that run later does not bring earlier rounds back.
- **One more round.** An asks-settled binding with `"grants": "<name>"` allows one more start on the item each time it starts: the answer that settles the asks is how an operator raises the limit for that item alone. No answer text is read; the option the binding matches on is the decision. Only an asks-settled trigger file may set `grants`.
- **No item.** The count is per item, so a limited start that names no item is refused, and the file store, which keeps no items, refuses every limited start.

A stage reads where its limit stands from `archon workflow runs --item <key> --json`: its own run's `startLimit` names the limit it started under, and `startLimits` lists each limit on the item with `starts`, `granted`, `used`, `left`, `since` (when the count last reset, or null) and `bindings`: the trigger files on this install whose binding counts under the limit, each with its `bindingId`, the `workflow` it starts and, for a run-ended binding, the `runEnded` `{ workflowName, outcome }` that starts it (null for an asks-settled one). A stage finds the limit of the binding its outcome would start there, by that binding's id or by its own workflow and outcome, without knowing how the limit is named. `bindings` is null when the trigger files did not read. A limit is listed once a start has counted under it on the item, so a binding with no entry has every start left. `used` counts the starts still queued under the limit as well as those that ran, so `left: 0` means no further start is allowed without a grant or a reset, not that the reading run is the last: starts already queued still run. A stage that reads `left: 0` while none of the item's `queued` starts is of its own workflow is the last allowed round, and can leave an ask instead of returning the change. A binding without `limit` starts as often as it matches.

A pack declares this as [`limit:` and `grants:`](/reference/workflow-language/#pack-bindings), and `archon pack bindings` names the limit after the binding, so all of its outcome or option files share one count. An older binary on the same database neither counts a limited start it prepares nor records a reset when it completes a run.

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

The server rechecks its own host about every five seconds, including requests waiting on foreign holders. On a CLI-only host, the process that ends a run starts what its end caused and drains every host this install's trigger files name (see [who drains](#start-a-stage-when-a-run-on-an-item-ends)), so work queued behind any run that ends on this install is admitted when it ends, hand-started or not. Each `archon workflow wake` pass drains the same hosts, so a start whose admitter died waits one pass. `archon trigger drain --host <hostId>` runs one drain and can run after every earlier Archon process has exited, because the queue is durable. It is still needed, scheduled or by hand, in what is left: a host no trigger file on this install names, whose queue its own machine drains; and, with no wake watcher running, a slot freed by a process that drains nothing (a run the server ends on a host it does not serve, or one held by another machine's run), or an admitter that died. Neither recovers a request that was already admitted to a run; run that with `trigger execute` (below).

A malformed stored checkout-guard declaration is never admitted. Drains pass over that request and log `resource_start.invalid_queued_guard` with its request ID, so valid queued work can continue. The request stays queued and can be inspected and withdrawn with the trigger CLI. New starts with malformed declarations are rejected before storage.

If a known foreign admitted run has a missing or corrupt stored launch and no recorded working path, admission cannot identify its checkout. Guarded starts targeting an in-place path or explicit branch wait (or skip) with that run named as blocker until its launch is repaired or it ends; read-only starts and branchless worktrees can still proceed. SQL logs `db.foreign_launch_invalid_checkout_unknown` or `db.foreign_launch_missing_checkout_unknown` with the foreign run ID.

The file store records admitted run membership in its slot independently of the request, retaining it when a paused run gives back capacity. Slot documents written by older versions remain readable; releasing an older holder records its membership before removing the capacity holder. In both stores, surviving local slot membership requires a matching admitted request; admission, drain, and other local resumes fail until that evidence is repaired or the holder ends. Recorded slot membership determines whether a holder is local or foreign, even when its request falsely names another resource. A request that disagrees with its local slot membership is rejected; a proven foreign holder still permits read-only starts.

A run released by an older version may have neither retained membership nor a capacity holder. Its request alone cannot establish its resource: a request with readable admitted status, resource, and prepared launch keeps that checkout serialized even for read-only starts, while independent checkouts can proceed. Damaged `hostId`, `id`, `overlap`, `blocker`, or `position` fields do not prevent this checkout-only observation. Direct local requests and resume still require a valid complete request. Unreadable checkout projections fail admission and direct drains explicitly. An intact admitted request without contradictory slot membership can resume through normal capacity arbitration, including a paused or failed run released before the upgrade. The checkout remains held while the run is paused.

When independent slot membership is absent, a historical resume trusts the surviving structurally valid admitted request's resource association. If that resource field was damaged to name another valid resource, serialization on the original resource is not guaranteed until the admission evidence is repaired or the holder ends. Surviving contradictory membership is still rejected, guarded starts still wait behind foreign checkout holders, and capacity waiters keep their original priority.

If an older released holder also loses its request document, the stored data cannot distinguish it from a manual run. It receives foreign-holder behavior, so read-only starts can pass it even on its former resource. Preserve or repair the request and slot membership before relying on same-resource serialization in that damaged state.

An owned launch that records a preparation error, such as failing to create isolation, ends its still-pending run as `failed`. The full error remains in `trigger inspect` (by receipt or request ID) and `workflow get`. Attention watchers show the run ID and `launch failed before the first node`, without error text. Terminal runs no longer hold resource capacity, so the next drain can admit queued work.

If a request was admitted but its run remains `pending`, for example because its host stopped or was killed without recording a preparation error, inspection supplies an explicit `trigger execute` retry. `archon trigger list` names such requests under each receipt's `awaitingExecution`, and `archon workflow runs --item <key>` shows them on the item; it reads `unowned` only when its hand-off recorded that it started nothing or the process it was handed to is gone, and `unknown` when that cannot be told. The engine admits only one execution claimant. A drain does not retry it automatically, and the run keeps holding its resource until it runs, is cancelled, or is abandoned. `archon workflow cancel <run-id>` withdraws it when no process on this machine holds it, so it never starts. Cancel cannot see a starter on another machine that shares the database, so when the request's host runs elsewhere, cancel it only once that host is stopped ([`workflow cancel`](/reference/cli/#workflow-cancel)). Archon does not infer failure from process death. Server launch errors log `resource_start.start_failed` with the run ID and the `archon trigger inspect` command for its recorded status and recovery options.

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

## Hold all new starts on an install

To stop new work from starting without cancelling anything, for maintenance, a restart, a full disk, a spending limit or a machine you need for something else, set the install hold:

```bash
archon hold set    # nothing new starts
archon hold lift   # start what was held
```

The hold is a fact of the install's database: every process that uses it sees it, it survives restarts, and only `archon hold lift` removes it. While it is set, no new run is admitted from any source, and nothing that would have started is lost:

- **Timers, `trigger fire`, webhooks and polls.** The receipt is recorded as usual, but its binding is not prepared. It stays pending, so no source is captured and no request is admitted, queued or skipped.
- **Run-ended and asks-settled hand-offs.** A run that ends while the hold is set finishes normally and writes the start it owes; that start stays pending like a fired one. The same holds for a settlement of asks.
- **Queued requests.** Requests already waiting for capacity, their item or their checkout keep their places and are not admitted.
- **Hand starts** (`archon workflow run`, chat, Web or API). The start creates its `pending` run and waits in its own process, printing `Waiting for the install hold`, then starts after the lift. `--no-wait` refuses it instead. A waiting start dies with its process, as one waiting for a full resource does.

Runs already running or paused are not touched: they finish, pause at their gates and waits, resume and take answers as usual. A run admitted before the hold, and a `workflow:` child of a running run, still start.

To update Archon, you do not need to wait for running runs to end: a run that ends after the update leaves its next start to the installed version ([after an update](#start-a-stage-when-a-run-on-an-item-ends)). Starts that already wait while their bindings are registered again are another matter ([check bindings after an update](#check-bindings-after-an-update)).

`archon workflow status`, `archon trigger list`, the `trigger fire` output and `archon workflow runs --item <key>` say that the hold is set, who set it and when, and which starts it keeps; with `--json` they carry `hold` and the held starts ([CLI reference](/reference/cli/#hold)).

`archon hold lift` drains each host this install serves ([who drains](#start-a-stage-when-a-run-on-an-item-ends)). Held starts on a host no trigger file on this install names stay held for that host's own drain; the lift names those hosts. Held bindings are prepared in the order they arrived, with the workflow source and run configuration as they are at the lift, and then admitted, queued or skipped by their `overlap` as at any other time. An `overlap: skip` start is therefore skipped only if capacity, its item or its checkout blocks it after the lift, never because of the hold. Requests that were already queued go first, so the held starts do not jump them. Each start is admitted at most once. A frequent timer on an `overlap: queue` binding builds up one start per tick during a long hold; withdraw the ones you do not want with `archon trigger withdraw` after they queue. Every process on the install must run a version that knows the hold: an older one does not read it.

## Configure GitHub event starts

Every webhook route (`/webhooks/github`, `/webhooks/gitea`, and `/webhooks/sources/:sourceInstanceId`) accepts bodies up to **32 MiB (33,554,432 bytes)**, inclusive. A larger body receives HTTP **413** before its signature is checked, including a streamed delivery without `Content-Length`. Archon stops reading at the limit and creates no receipt or workflow start. Other API routes do not have this limit.

GitHub event starts use an installed source plugin. The maintained plugin is temporarily housed in this repository; it has its own module entrypoint and does not require the GitHub chat adapter or an outbound GitHub token.

From a source checkout, build the module with `bun run --cwd packages/adapters build:github-source-plugin`, then copy `packages/adapters/dist/github-source-plugin.mjs` to an operator-owned plugin directory. The compiled module can load outside the Archon source tree. Installation and module paths are explicit in this release; marketplace installation is separate work.

Set `WEBHOOK_SECRET` for the server process (the configuration's `webhookSecretEnv` names it; a source that [only observes waits](#without-a-webhook) needs none), set `ARCHON_WEBHOOK_SOURCES` to the absolute path of the host configuration below, and set `ARCHON_TRIGGER_HOST` to the `hostId` the bindings name (`build-host-1` below) so the server starts the runs. Configure GitHub's webhook URL as `https://your-archon-host/webhooks/sources/github-production`. The existing `/webhooks/github` endpoint handles conversation and wait-signaling consumers separately.

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

The maintained GitHub source plugin supports issue and pull-request lifecycle events, issue or pull-request label changes, comments created on an issue or pull request (`comment.changed` with action `created`, from GitHub's `issue_comment` event), pull-request reviews submitted or dismissed (`review.changed` with action `submitted` or `dismissed`, from GitHub's `pull_request_review` event), check-run changes, and commit-status changes. A label change carries who made it, as the `label.actor.id` and `label.actor.login` fields, and a comment carries `comment.id`, `comment.author.id` and `comment.author.login`; the comment's text is not part of the event. A review carries `review.id`, `review.state` (`approved`, `changes_requested`, `commented`, `dismissed`, or `unknown` for a state the event vocabulary does not name), GitHub's own `review.nativeState`, the commit it was made on as `review.commit`, and `review.author.id` and `review.author.login`; its text is not part of the event. A selector can restrict a review event with a `review.state` predicate. Subscribe the GitHub webhook to **Pull request reviews** to receive them. Selectors match an exact event kind and one of the configured actions. They can also restrict the repository, the issue or pull request (`subject`, a kind and a number), and the predicates supported for that event kind. A `subject.kind` predicate (`issue` or `pr`) restricts any event that has a subject to issues or to pull requests. Input mappings copy a supported event field or supply a typed JSON literal. A required field that is unavailable rejects that binding instead of inventing a value.

The plugin authenticates the raw payload using the configured shared secret. The server validates its resolved receipt, verifies for a new delivery that the configured run-as users exist, and commits the receipt before returning success. Preparing and starting the run happen after the response, so a slow workflow never delays GitHub's delivery. An invalid signature creates no trusted receipt. A signed source event does not select the Archon user who runs the workflow. Every binding must name an authorized `runAsUserId`. The optional GitHub event actor remains provenance and never becomes an Archon credential selector.

On the first verified delivery, Archon records the source instance, delivery ID, verified-content digest, selected binding ID and revision, resolved inputs, and launch intent. Replaying the same `(sourceInstanceId, deliveryId)` reuses the original receipt and binding snapshot; changed or newly added bindings do not create starts for that delivery. Editing a binding does not turn an old delivery into a new start. Reusing a delivery ID with different verified content returns HTTP 409. When GitHub supplies no delivery ID, Archon cannot provide source-level replay deduplication.

GitHub does not automatically redeliver every failed webhook. Check delivery status in GitHub and use GitHub's explicit redelivery or your reconciliation process after a transport or processing failure. Archon retains safe receipt and disposition data for inspection; it does not retain the raw webhook body as a trigger archive.

## Start a stage when what an item waits for happens

A stage that has to wait for something outside Archon, such as a change's checks finishing or a review arriving, ends instead of sleeping. It says what its item now waits for as [waits](/reference/workflow-language/#waits-what-an-item-waits-for-outside-archon) in its result. The run completes and holds no agent session, checkout or capacity slot, and on an install that receives webhooks nothing polls the forge. When the event arrives, a GitHub source plugin binding with `wake` starts the next stage on the item.

A host stage that reads a change's checks and reviews, and ends waiting when they are not in yet:

```yaml
name: host
description: Read the change's checks and reviews; wait for the ones still coming
inputs:
  head: {}
  waited: {}
returns: { node: read, outcome: verdict, waits: waits }
nodes:
  - id: read
    prompt: |
      Read the checks and reviews on the change at commit $INPUTS.head. If any is still
      running or expected, leave verdict 'waiting' and say what you wait for.
    output_format:
      type: object
      properties:
        verdict: { type: string, enum: [clear, blocked, waiting] }
      required: [verdict]
```

The engine adds `waits` to the node's output schema. A run that ends with checks still running at the head leaves:

```json
{
  "verdict": "waiting",
  "waits": [
    { "event": "checks", "about": "<full head commit id>", "within_minutes": 60 },
    { "event": "review", "about": "<full head commit id>", "within_minutes": 240 }
  ]
}
```

Two bindings in the pack wake it, one for a check and one for a review, each naming the field of the event that must equal the wait's `about`:

```yaml
bindings:
  checks-done:
    workflow: host
    resource: host
    overlap: queue
    event:
      kind: check.changed
      actions: [changed]
      predicates: [{ field: check.phase, equals: completed }]
    wake: { workflow: host, wait: checks, about: check.revision }
    inputs:
      head: { event: check.revision }
      waited: { wait: true }
  reviewed:
    workflow: host
    resource: host
    overlap: queue
    event:
      kind: review.changed
      actions: [submitted, dismissed]
    item: { field: subject.number, prefix: pr- }
    wake: { workflow: host, wait: review, about: review.commit }
    inputs:
      head: { event: review.commit }
      waited: { wait: true }
```

Here the next stage is `host` again: it reads the change once more, and either ends with a verdict or waits again. A stage can as well start another workflow. `{ wait: true }` carries the met wait, and its `runId` names the run that left it: `archon workflow get <runId> --json` shows what that run returned, at `terminal_record.returns.value`. A [`result_of: host`](/reference/workflow-language/#reading-an-earlier-runs-result) input is not the same read: it takes the latest completed `host` run on the item when the stage starts, which is a newer run than the waiting one when `host` completed again while the start waited for its slot. [`archon pack bindings`](/reference/cli/#pack-bindings) writes each as a binding for the GitHub source plugin's `bindings` array, with `wake` as `{ "workflow", "wait", "about": { "field" }, "input" }`. The start is on the item of the wait it meets. A review names its pull request, so its binding also maps that `item` (here the items are keyed `pr-<number>`) and only a wait on that item can be woken: another pull request with the same commit wakes nothing here. The GitHub plugin refuses a `wake` binding without `item` for any event kind that names its subject. A check names no single pull request, so `checks-done` maps no item and matches on the commit alone, which also lets a pull request's checks wake an item keyed by its issue. `{ wait: true }` passes the met wait to the stage as `{ event, about, workflow, runId, waitingSince, deadline }`; the started workflow declares that input.

What the engine holds to when the event arrives:

- **The wake is decided when the event is recorded.** The plugin reads the `about` field and hands it on; it compares nothing. In the transaction that records the delivery, the engine looks for an open wait of `wait.workflow` named `wait` whose `about` is exactly that value, on an item of the project the binding's `launch.cwd` is in, and on the binding's mapped item when it maps one. A match closes the set as met and writes the start on its item. A binding whose field is missing or empty is recorded as `rejected`.
- **Once.** A redelivery of the same delivery is a replay and starts nothing. Another delivery for the same set finds it met and is recorded `unmatched` with `no open wait 'checks' about '<commit>' from 'host'`. Two deliveries that arrive together start one stage.
- **A commit the waits no longer name starts nothing.** A later completed run of `host` on the item replaces its open waits with its own. After that, a check or review of the older commit, however late or however GitHub marked it, finds no open wait about that commit and is recorded `unmatched`, naming the wait it looked for. The engine compares the event with the open waits only; it does not read the forge's current head. A push to the pull request alone replaces nothing: until a run of `host` ends with waits about the new commit, an event about the old commit still meets the old waits. Bind a stage on the pull request's `pr.lifecycle` event with action `head_updated` (the GitHub source plugin's name for GitHub's `synchronize` action) when a push should end what the item waited for.
- **No event by the deadline raises attention.** An open set past any of its waits' `within_minutes` is listed by `archon workflow attention` as an `overdue_wait` item with ref `wait:<run-id>`, naming what the item waits for and since when. It stays open, and a late event still meets it. Withdraw it with `archon workflow answer --withdraw wait:<run-id>`, or run `host` on the item again. `archon workflow runs --item <key>` lists the item's open waits under `Waiting for` before and after the deadline.
- **An event without an item cannot choose between items.** When a binding maps no item (a check) and open waits on two items of the project match its event, nothing starts and the receipt is `rejected`, naming both items. A binding that maps an item only ever reaches the wait on that item.

Each completed check is its own event. A host stage waiting for `checks` is woken by the first completed check at its commit, reads the change, and may end waiting again; narrow the binding's selector with predicates when it should wake for fewer. An event that arrives while the waiting stage is still running finds no open wait, because the waits open only when the run completes, and is recorded `unmatched`. If no later event follows, the set goes overdue and appears in attention.

Wake bindings need the database store and a registered project, as items do.

### Without a webhook

An install that receives no webhooks, such as a laptop or a machine behind NAT with no `archon serve` the forge can reach, can have its check and review waits met by observing them instead. Add `observe` to the source's entry in the `ARCHON_WEBHOOK_SOURCES` file:

```json
{
  "version": 1,
  "sources": [
    {
      "sourceInstanceId": "github-production",
      "module": "/opt/archon/plugins/github/source-plugin.mjs",
      "observe": { "everySeconds": 60 },
      "config": { "version": 1, "host": "github.com", "bindings": [] }
    }
  ]
}
```

`everySeconds` is an integer of at least 15; an invalid file fails with its path and each wrong field. Put the source's bindings in `bindings` as for a webhook. Leave out `webhookSecretEnv` when the source receives no webhooks; it then refuses every delivery. A source module that cannot observe fails to load when `observe` is set.

[`archon workflow wake`](/reference/cli/#workflow-wake) observes on every invocation, and `workflow wake --watch` (what `archon workflow wake schedule install` runs) observes each source once per interval, also while runs it resumed are still running. `workflow wake` loads only the sources that declare `observe`, so a webhook-only source in the same file, such as one whose secret is set only for the server, cannot stop it. A running `archon serve` with the same file observes on its own timer and logs `webhook_source_observing` with the source and interval at boot. Set `ARCHON_WEBHOOK_SOURCES` where the process reads it: `~/.archon/.env` is read by both. To have only the wake job observe on an install that also runs a server, set it in the shell that runs `archon workflow wake schedule install` instead: the job then passes the file to its watch with `--sources`. `archon trigger check` lists the sources that observe under `observing` and says when no installed wake job reads them.

A pass reads the open waits, and the labels the source's bindings name ([below](#label-an-issue-or-pull-request-without-a-webhook)). When no wait is open and no binding names a label, it calls no source and reads nothing from the forge. Otherwise it reads, through your forge plugin and credentials as [`archon forge`](/reference/cli/#forge) does, what each wait's binding is about:

- **A check wait**, woken by a `check.changed` binding on `check.revision`: the checks at the wait's commit. Each check becomes the `check.changed` event its webhook would have carried, without the commit's pull requests; a check event names no subject.
- **A review wait**, woken by a `review.changed` binding on `review.commit` that maps its `item` from `subject.number`: the reviews of the pull request the wait's item key names under that mapping (`pr-7` with prefix `pr-` names pull request 7). Each submitted or dismissed review becomes the `review.changed` event its webhook would have carried. A review not yet submitted is skipped.

For check and review waits, only the bindings that wake an open wait are evaluated, so observing a commit's checks or a pull request's reviews never starts a binding nothing waits on, and an event about another commit than the wait's is not recorded. Label bindings are the exception: they start work with no wait open, as [below](#label-an-issue-or-pull-request-without-a-webhook). Each start goes to the wait's own item. Each event is recorded as one delivery of the source per binding and item, with the delivery id `observe:check:<host>/<path>@<commit>:<unit kind>:<unit id>:<phase>:<native result>:<binding id>:<item key>` or `observe:review:<host>/<path>#<number>:<review id>:<submitted|dismissed>:<binding id>:<item key>`, and the engine matches it against the waits exactly as it matches a webhook's. The same state observed again for the same binding and item is a replay and wakes nothing, so a completed check or a review wakes an item's wait at most once per binding, even when the stage it woke ends waiting at the same commit again. A wait that opens later on another item, or for another binding, is a new delivery. A check that had already completed, or a review already submitted, when the wait opened wakes it on the first pass; a webhook would have arrived before the wait and found nothing to wake. The engine refuses a source's read of a commit no open wait is about, or of a pull request no open wait's item key ends with.

A read that fails, such as a deleted commit or a repository the credential cannot see, is reported for its waits, and the other waits are still read. Any other wait the source binds is reported as not observed, with the reason: a wake binding of another kind, an item key that names no pull request, a project with no repository URL, a repository on another forge host, or a binding that matches the waited event but cannot start on it, such as an input mapped from a field the event lacks. `workflow wake` prints both on its `observe` line; a server logs `source_observe_failed` for a failed pass and `source_observe_unserved` once per process for each wait it cannot observe.

`workflow wake --watch --json` writes `{"ok":true,"action":"wake","observe":[{"source":…,"everySeconds":…}]}` when it starts, and one `observe` line for each pass that read waits or labels, or that has label bindings to report as not observed (see the [CLI reference](/reference/cli/#workflow-wake)). A stage start whose host could not be drained stays pending: a running watch drains that host again on its next pass, and the failure line names `archon trigger drain --host <id>` to run by hand. A one-shot `workflow wake`, or a watch that restarted, does not remember the host. Every wake pass drains the hosts this install's trigger files name, so a start on such a host is still handed on. Each pass also drains the host of every label start it observes again, so while the label is on the item, a start on that host that is queued at capacity or whose drain failed is handed on once its slot frees, also after a restart. Any other host named only by a source binding needs that command.

### Label an issue or pull request without a webhook

On the same install, putting a label on an issue or a pull request can start a workflow on its item. Give the observing source a `label.changed` binding that names the repository and the label:

```json
{
  "bindingId": "factory-intake",
  "hostId": "laptop",
  "runAsUserId": "2a568f73-e217-40ca-b17d-a784d19fd43a",
  "resource": "github:acme/widgets:intake",
  "overlap": "queue",
  "launch": {
    "cwd": "/srv/archon/widgets",
    "workflowName": "take-issue",
    "inputs": {},
    "isolation": { "kind": "default" }
  },
  "selector": {
    "kind": "label.changed",
    "actions": ["added"],
    "repository": { "host": "github.com", "path": "acme/widgets" },
    "predicates": [{ "field": "label.name", "equals": "factory" }]
  },
  "inputMapping": { "issue": { "source": "field", "field": "subject.number" } },
  "item": { "field": "subject.number", "prefix": "issue-" }
}
```

Each pass lists every open issue and pull request in the repository that carries the label, and keeps those the binding's selector can match. For an item that is new to the list or changed since the last pass, it reads when the label was last added, by the forge's own label event (the [`workitem.label.added`](/reference/forge/) operation); for an unchanged one it reuses the answer it read before (see the request cost below). The event becomes the `label.changed` event a webhook would have carried, with action `added`, the label's name (its forge id is not read, so `label.id` is empty), and who added it as `label.actor`. It is recorded as one delivery with the id `observe:label:<host>/<path>#<number>:<label event id>:<binding id>`, and starts the binding, on the item its `item` mapping names, as a webhook delivery would. The item key is not part of the id, so correcting a binding's `item` mapping does not start an add already recorded. A `label.name` predicate with `in` reads each label it names.

A binding observes the subjects its selector matches, as a webhook delivery would: a `subject.kind` predicate (`issue` or `pr`) limits it to one kind, a `subject` to one item, and a selector with neither observes both issues and pull requests. An item the selector rules out costs no label-event read. A binding for labelled pull requests, such as a review a maintainer starts on a contributor's change, selects the kind and keys its item by it:

```json
"selector": {
  "kind": "label.changed",
  "actions": ["added"],
  "repository": { "host": "github.com", "path": "acme/widgets" },
  "predicates": [
    { "field": "label.name", "equals": "review" },
    { "field": "subject.kind", "equals": "pr" }
  ]
},
"item": { "field": "subject.number", "prefix": "pr-" }
```

The example binding above names no kind, so it would also start on a labelled pull request, on the item `issue-<number>`; add `{ "field": "subject.kind", "equals": "issue" }` to keep it to issues.

- **Labels already there start nothing.** The first pass that sees a binding's label records every item that already carries it, and starts none of them. Only a label added after that pass starts work: an item that was closed during the first pass and is reopened later with its old label starts nothing, because its label was added before the binding was first seen. The forge's time of the add is compared with this host's time of the first pass, so an add within the two clocks' skew of it can fall on either side. A binding whose `bindingId`, repository or label changes is seen for the first time again. A first pass in which some reads failed still records the binding and label as seen, with the pass's start as the cutoff: an item it could not read is compared with that time once it reads, so a label it already carried starts nothing, and a label added to any item after that pass began starts work.
- **Once per add.** The same add observed again is a replay and starts nothing. Removing the label and adding it again is a new label event, so the next pass starts the binding again. A remove and re-add within the same second as an update a pass already saw can leave the item's `updatedAt` unchanged; that re-add stays unseen until the item next changes.
- **Observation sees state, not history.** A label added and removed between two passes is never seen and starts nothing. This is the one difference from an install that receives webhooks, which records every add.
- **Starts past the limit queue.** Each start is an ordinary binding start, so [`concurrency.runs`](/reference/configuration/#run-limit) and the binding's resource and overlap decide when it runs.

**Request cost.** Each pass lists the open items that carry each label a binding names, and reads the label events of an issue or pull request the selector admits only when it is new to the list, its `updatedAt` changed since the last pass of the same process (a label added or added again, a comment, an edit), or its last read found no add event for the label, which the forge can record after the list shows the label. With the GitHub plugin, a list takes one request per 100 labelled issues and pull requests, plus one more, because it stops at the first page with fewer than 100: `floor(items / 100) + 1` requests. Reading one item's label events costs the same per 100 events on that item. A long-running `archon serve` or `workflow wake --watch` whose labelled items are unchanged makes only the list requests, `list requests x 3600 / everySeconds` an hour: 100 labelled items at `everySeconds: 60` cost 120 an hour, not 6000. The first pass after a process starts, and each one-shot `workflow wake`, also reads the label events of every labelled item the selector admits: at least one request per item, and more for an item with more than 99 events. A forge plugin that does not return `updatedAt` on `workitem.list` costs that on every pass. The same forge token serves every other forge read and write on the install, so a rate limit spent here fails checks, reviews and merges too.

The source reports a label binding it does not observe, with the reason: a binding with no `added` action, one with `wake`, one that names no repository or no `label.name`, or one on another forge host. A source with `webhookSecretEnv` observes no label binding: its label events arrive by webhook, and observing too would start each twice. `workflow wake` prints each as `not observed: binding <id>: <reason>` on every pass, even when the source has nothing else to observe; a server logs `source_observe_unserved` once per process. A binding that cannot be observed reads nothing from the forge. The engine refuses a source's list of a label no binding of it names, and its read of an issue or pull request that list did not return, or returned as the other kind.

Your forge plugin must support `workitem.label.added`. An installed plugin released before it answers `unsupported_op`, and each pass reports that failure for the binding.

When you upgrade Archon, rebuild the GitHub source plugin as [above](#configure-github-event-starts), copy it over the module your configuration names, and restart the observing process (`archon serve` or `workflow wake --watch`), which loads the module once when it starts. A GitHub source plugin built before pull requests were observed reads label events without saying whether the item is an issue or a pull request, and the engine refuses each such read as an item the list did not return; each pass reports the refusal for the binding. A configuration whose `module` is `source-plugin.ts` in the same source checkout the engine runs from needs no rebuild, only the restart.

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
  order_id: { required: true }
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

The receipt freezes the evaluated bindings and resolved inputs. The execution host later captures the workflow source and resolves the run configuration: on an item, the config the item's most recent run was started with, else any `configSource` file (see [Items](/reference/cli/#items)). Queue admission freezes that prepared source and configuration; editing live files afterward does not change queued work.

An input mapped from the event, by CLI `--inputs`, a Standard Webhooks JSON Pointer, or a GitHub `field` mapping, reaches only a workflow that declares it under `inputs:`. Preparation rejects a binding that maps event values into a workflow without that declaration. Literal inputs you write into `launch.inputs` or a GitHub `literal` mapping pass through to a workflow without `inputs:`, as they do for a direct run. A workflow that declares `inputs:` rejects any undeclared name, literal or mapped.

A process that stops during preparation leaves its recorded preparation owner visible; a `trigger fire` that waits a minute on such an owner prints its owner ID. After verifying that exact process has stopped, use `archon trigger recover-preparation <receipt-id> <binding-id> --owner <recorded-owner-id> --yes`, then drain the configured host. A failed validation is recorded as rejected and requires a corrected new request.

Untouched queued work can be removed with `archon trigger withdraw <request-id>`. Receipt and admission records are retained in the installation store (database or file store). This first version has no automatic trigger-record retention policy. Do not map credentials or unnecessary source content into workflow inputs. A run started by a trigger records its receipt and binding IDs in its `resource_start` metadata; its request ID is the run ID, so `archon trigger inspect <run-id>` shows the request. When a workflow node runs `archon trigger fire`, the receipt records that run and node as its source actor, and `archon trigger inspect <run-id>` and `archon workflow get <run-id>` show them as the requesting run. It grants the started run nothing: it still runs as the binding's `runAsUserId`. CLI-hosted execution writes the ordinary run output to `ARCHON_HOME/logs/trigger-run-<request-id>.log`. Fresh trigger runs have no chat conversation or message history. Inspect their output with `archon workflow get <run-id>` and `archon workflow logs <run-id>`. Previously queued launches that carry a real conversation retain that history destination.
