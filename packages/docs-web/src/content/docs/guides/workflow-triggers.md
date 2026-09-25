---
title: Start workflows from schedules and GitHub events
description: Configure governed workflow starts from native schedules and verified GitHub webhooks.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 10
---

Triggers start ordinary governed workflow runs. A trigger binding selects the workflow, execution user, inputs, execution host, shared resource, and overlap policy. The schedule or webhook decides when to request a start; it does not bypass workflow validation, provider configuration, isolation, or resource admission.

Schedules and event bindings are deployment configuration. They do not belong in workflow YAML.

Every binding names a `hostId`. A host prepares accepted work for its own ID, admits it, and starts the run. Two hosts ship with Archon:

- The server, when `ARCHON_TRIGGER_HOST` names its host ID. It prepares and starts work as soon as a webhook receipt commits, and it checks for queued work every few seconds, so a queued start begins shortly after the run blocking it ends. The server never guesses its host ID; without `ARCHON_TRIGGER_HOST` it records webhook receipts but starts nothing.
- The CLI, through `archon trigger fire` and `archon trigger drain --host <hostId>`. Each admitted run executes in its own detached process.

Both hosts use the same admission records, so a server and a scheduled CLI command can serve the same host ID without starting a run twice.

## Find your run-as user ID

Every binding names the Archon user whose provider configuration and credentials the run uses, as `runAsUserId`. To use your own CLI identity, run:

```bash
archon trigger whoami
```

It prints `runAsUserId`, the ID to put in the binding, and `cliIdentity`, the name it resolved from `ARCHON_USER_ID` or `$USER`. It creates the Archon user for that identity when none exists yet. Run it with the same `ARCHON_HOME` or `DATABASE_URL` as the host that executes the binding, because user IDs belong to one Archon database.

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

`intervalSeconds` is required and has no default. `runAtLoad` is also required. Set it to `true` to request one start when launchd loads the job, or `false` to wait for the first interval.

Test the binding once before installing it:

```bash
archon trigger fire --config /Users/alice/.archon/triggers/repository-refresh.json
```

The command returns a durable receipt and disposition, then runs accepted work in the background. Install the per-user LaunchAgent after the one-shot request succeeds:

```bash
archon trigger schedule install --config /Users/alice/.archon/triggers/repository-refresh.json
```

Archon installs only jobs in the `com.archon.trigger.*` namespace. The plist contains the absolute executable and arguments, working directory, and `ARCHON_HOME`. It does not copy provider credentials or other environment variables. Scheduled runs use the same native provider configuration and credentials available to the configured user.

Use `archon trigger list` to find recent native or webhook receipts, then inspect a receipt or resource-start request by its UUID:

```bash
archon trigger inspect 1f3be5de-4e63-4da2-b352-20d95ba83b37
```

Remove future firings with the same configuration file:

```bash
archon trigger schedule remove --config /Users/alice/.archon/triggers/repository-refresh.json
```

Removing a schedule does not cancel work that Archon already accepted. To change its interval or startup behavior, remove the existing job before installing the updated configuration.

### macOS scheduling limits

The installed LaunchAgent runs in the current user's GUI login domain. The user must be logged in, and logout ends that launchd session. No scheduler runs while the computer is powered off.

`StartInterval` behavior during sleep or while the prior command is still running is native launchd behavior and differs across macOS releases. Archon does not promise replay of missed intervals. `runAtLoad` requests one invocation when the job loads; it is not a missed-run queue.

Use the trigger workflow to read the current source state when it runs. Do not depend on one invocation for every wall-clock interval.

## Drive the same commands from Linux or Windows

Archon does not install or manage Linux or Windows scheduler definitions. Configure the host scheduler to run the same one-shot command with an absolute executable path, an absolute config path, the configured working directory, and `ARCHON_HOME`:

```text
/opt/archon/bin/archon trigger fire --config /home/alice/.archon/triggers/repository-refresh.json
```

A server with `ARCHON_TRIGGER_HOST` set already drains its host. Without a running server, schedule a cold drain for a host that receives webhook starts but has no timer binding:

```text
/opt/archon/bin/archon trigger drain --host build-host-1
```

Use the first command as a systemd `ExecStart` or cron command on Linux. On Windows Task Scheduler, set the absolute Archon executable as the program and pass `trigger fire --config C:\Users\Alice\.archon\triggers\repository-refresh.json` as its arguments. Configure the working directory and `ARCHON_HOME` separately in the scheduler.

These recipes share Archon's trigger boundary, but the host scheduler owns login, sleep, wake, missed-time, and credential-loading behavior. Test the real scheduled task under its configured user before relying on unattended execution.

## Choose a resource, capacity, and overlap policy

`resource` names the work that must not overlap. Use the same sufficiently qualified resource for every schedule or webhook binding that can mutate that work. A trigger ID or workflow name does not imply a resource.

`capacity` sets how many runs can hold the resource at once. It is optional and defaults to `1`, so by default runs for one resource never overlap. Set it higher for work that tolerates a bounded number of concurrent runs, such as `"capacity": 2`. Every binding that names a resource must declare the same capacity. A start that declares a different capacity is rejected and recorded as `resource_capacity_conflict` instead of silently using either value. To change a resource's capacity, use a new resource name.

The `overlap` setting controls a request that arrives while the resource is full:

- `skip` records the blocking run and retains no promise to execute later.
- `queue` retains the prepared request in durable FIFO order.

A queued request also blocks newer requests for the same resource, so a new arrival never passes older queued work. Different resources can run concurrently. Pending, running, and paused root runs continue to hold their resource; a run releases it when it completes, fails, or is cancelled.

A drain processes untouched queued requests assigned to one host and admits them while the resource has free capacity. The server drains its own host continuously. `archon trigger drain --host <hostId>` runs one drain and can run after every earlier Archon process has exited, because the queue is durable. Neither recovers a request that was already admitted to a run.

If a request was admitted but its run remains `pending`, for example because its host stopped before starting it, inspection supplies an explicit `trigger execute` retry. The engine admits only one execution claimant. A drain does not retry it automatically, and the run keeps holding its resource until it runs or is abandoned. When a server-hosted start fails this way, the server logs `resource_start.start_failed` with the run ID and the `archon trigger inspect` command to run.

To stop a running run that a `trigger execute` process owns, use `archon workflow cancel <runId>`. Cancel terminates that process and its descendants, then records the run as `cancelled`, which releases the resource. The next drain admits queued work for it. A run the server executes has no detached owner process, so `archon workflow cancel` refuses it and leaves it unchanged; cancel it from that server instead (Web UI, API, or chat).

A `trigger execute` process stopped with SIGTERM or SIGINT marks its own running run failed before it exits, which also releases the resource. A crash or SIGKILL cannot do that and leaves ownership ambiguous.

If an admitted run has ambiguous ownership after a crash, inspect the request and its blocking run. `archon workflow abandon` is the explicit escape hatch here. If the run's owner answers on this host, abandon stops its process tree before recording the run cancelled, so a waiting start is admitted only after that process has exited. If no owner answers, abandon records the run cancelled and prints the host and pid the run recorded; an owner on another host cannot be stopped from here, so verify it has stopped before abandoning. Archon does not abandon a run because it is old or unreachable. Automatic queue draining and recovery of ambiguous execution are separate operations.

## Configure GitHub event starts

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

The maintained GitHub source plugin supports issue and pull-request lifecycle events, issue or pull-request label changes, check-run changes, and commit-status changes. Selectors match an exact event kind and one of the configured actions. They can also restrict the repository, issue or pull-request number, and the predicates supported for that event kind. Input mappings copy a supported event field or supply a typed JSON literal. A required field that is unavailable rejects that binding instead of inventing a value.

The plugin authenticates the raw payload using the configured shared secret. The server validates its resolved receipt, verifies that the configured run-as users exist, and commits the receipt before returning success. Preparing and starting the run happen after the response, so a slow workflow never delays GitHub's delivery. An invalid signature creates no trusted receipt. A signed source event does not select the Archon user who runs the workflow. Every binding must name an authorized `runAsUserId`. The optional GitHub event actor remains provenance and never becomes an Archon credential selector.

On the first verified delivery, Archon records the source instance, delivery ID, verified-content digest, selected binding ID and revision, resolved inputs, and launch intent. Replaying the same `(sourceInstanceId, deliveryId)` reuses the original receipt and does not evaluate changed or newly added bindings. Editing a binding does not turn an old delivery into a new start. Reusing a delivery ID with different verified content is rejected. When GitHub supplies no delivery ID, Archon cannot provide source-level replay deduplication.

GitHub does not automatically redeliver every failed webhook. Check delivery status in GitHub and use GitHub's explicit redelivery or your reconciliation process after a transport or processing failure. Archon retains safe receipt and disposition data for inspection; it does not retain the raw webhook body as a trigger archive.

## Preparation and retained records

The receipt freezes the evaluated bindings and resolved inputs. The execution host later captures the workflow source and reads any `configSource` run configuration. Queue admission freezes that prepared source and configuration; editing live files afterward does not change queued work.

A process that stops during preparation leaves its recorded preparation owner visible. After verifying that exact process has stopped, use `archon trigger recover-preparation <receipt-id> <binding-id> --owner <recorded-owner-id> --yes`, then drain the configured host. A failed validation is recorded as rejected and requires a corrected new request.

Untouched queued work can be removed with `archon trigger withdraw <request-id>`. Receipt and admission records are retained in the installation database. This first version has no automatic trigger-record retention policy. Do not map credentials or unnecessary source content into workflow inputs. A run started by a trigger records its receipt and binding IDs in its `resource_start` metadata; its request ID is the run ID, so `archon trigger inspect <run-id>` shows the request. CLI-hosted execution writes the ordinary run output to `ARCHON_HOME/logs/trigger-run-<request-id>.log`. Server-hosted runs record their messages in the run's conversation.
