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
- The CLI, through `archon trigger fire` and `archon trigger drain --host <hostId>`. Each admitted run executes in its own detached process.

Both hosts use the same admission records, so a server and a scheduled CLI command can serve the same host ID without starting a run twice.

## Find runs needing your input

The console's **Needs your input** banner lists every run that needs attention, including triggered runs and runs older than the first page of the feed. Approval gates keep their decision and response controls. A `wait: attention` run shows its question with answer controls for its form and an **Abandon** action; a wait paused before attention waits took answers shows **Resume** instead.

Keep the console open to receive live updates from runs started by another process. **Dismiss** hides an occurrence for this browser session; reloading or a new pause brings it back. Resuming still requires the server to have access to the run's working path.

## Get notified with the console closed

In **Settings → Alerts**, enable **Also notify this browser when the console is closed** and allow notifications. Subscription requires a signed-in web user or an identity supplied by your trusted authentication proxy. Push works over HTTPS or localhost in a browser supporting Web Push. On iOS, first install Archon as a home-screen web app.

Every opted-in browser on this install receives notices for approval gates and `wait: attention` pauses, including runs started by the CLI or triggers. Runs already rendered inline by a chat plugin are excluded. A notified run also gets a completion notice. Notifications name the workflow and the kind of attention; messages, outputs and identities stay in Archon. Click the notification to open the run page and act there.

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

Each route receives one message per approval gate or `wait: attention` pause occurrence,
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

## Find your run-as user ID

Every binding names the Archon user whose provider configuration and credentials the run uses, as `runAsUserId`. To use your own CLI identity, run:

```bash
archon trigger whoami
```

It prints `runAsUserId`, the ID to put in the binding, and `cliIdentity`, the name it resolved from `ARCHON_USER_ID` or `$USER`. It creates the Archon user for that identity when none exists yet. Use the same store for this command and the host that executes the binding: the same `ARCHON_HOME` with `store: files`, or the same `DATABASE_URL` with database storage. User IDs belong to that installation store.

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

For plain schedules, use the trigger workflow to read the current source state when it runs. To report identified items from an external system, use the [polling recipe](#poll-a-system-that-cannot-send-webhooks). Do not depend on one invocation for every wall-clock interval.

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

A queued request also blocks newer requests for the same resource, so a new arrival never passes older queued work, except work held back because another run holds its checkout (below). Different resources can run concurrently. Pending and running root runs hold their resource; a run releases it when it completes, fails, or is cancelled.

A paused run gives back its resource at a host-continued wait or gate. Once its process stops at a time or event wait, or at an approval gate or attention wait, the run releases its slot and later work can be admitted. Its continuation takes a slot again before it executes, ahead of queued new starts, because the run never lost its admission. When the resource is full, the run stays `paused`, keeps any answer it was given, and waits for capacity: `archon workflow wake` reports it as `waiting_for_capacity`, and a continuation host retries it about once a minute. Paused runs that wait for capacity take free slots in the order they were first refused. A refused resume keeps the run's place once it is ready to continue, its wait due or signaled or its pause answered, whichever surface resumed it. A refused resume of a run that is not ready records no place, so it holds no capacity. A parent blocked on a child workflow, a container write-back, and any container run keep their slot until they continue, because no continuation host retries them. A run paused because its source is unreadable also keeps its slot, even when a continuation host will retry it. Automatic continuation of waits, gates and unreadable-source pauses requires a continuation host: `archon serve`, or [`archon workflow wake --watch`](/reference/cli/#workflow-wake). Runs paused before this behavior existed keep their slot until they continue.

A run admitted on a resource holds its checkout until it completes, fails, or is cancelled, including while it is paused and has given back its slot. Admission therefore passes over a queued request that would run in a checkout another run admitted on the same resource holds: the same `in-place` directory, or the same explicit worktree `branch` in that codebase. The request keeps its place in the queue, and the free slot goes to the next request that can run. When that run ends, the request is admitted ahead of later requests for that checkout, one request per checkout at a time. A new request for a held checkout queues, or with `skip` is skipped, with the holding run as its blocker. A worktree lane without a `branch` gets its own checkout and is never held back this way.

Guarded starts also wait behind live runs outside the resource, including manual runs and runs on other resources, when they hold the same directory or registered reusable worktree. The holding run is named in inspection. Workflows declaring `mutates_checkout: false` can proceed beside these foreign holders; same-resource checkout serialization still applies. The resolved declaration is captured during preparation, so later workflow edits do not change a queued request. Older stored requests without that declaration are treated as guarded. Admission observes holders without changing their state. Foreign pending runs hold their checkout only during the executor's five-minute dispatch window; running and paused holders keep blocking until they end. Expiry releases only foreign checkout occupancy, leaving the pending run and any resource admission unchanged.

A drain processes untouched queued requests assigned to one host and admits them while the resource has free capacity.

Host listing retains failures for damaged requests assigned to the selected host, including malformed launches or a file request that disagrees with its containing slot. The host drains independent resources before reporting those failures together, preserving the request ID and original error (and the document path for file requests). On a damaged resource, drains can admit valid predecessors up to the first malformed request; they never pass that entry. Damaged data stays unchanged for repair. Direct resource drains use the same valid prefix and log the damaged request ID; new admission, resume, and request inspection remain strict. `trigger fire` reports failures belonging to its receipt as command failures. Failures belonging to other receipts, or whose receipt cannot be identified, produce warnings while the accepted receipt is printed; `trigger drain` still fails for any reported drain failure.

In the file store, a missing or corrupt slot queue or request envelope may hide which host owns a candidate. Listing reports those unclassifiable candidates as unattributed failures with their document paths and original errors. The host attempts independent resources before reporting failure. Unreadable slot membership reports its document error when it could affect admission, drain, or resume. An intact admitted request on a different resource with a provably separate checkout does not prevent independent work from draining. Repair damaged documents before relying on drain to reach their resource or checkout. A request whose host is known is reported as a failure even when it is the resource's only queued member. A start receipt that cannot be read or validated is reported on every host pass as an unattributed failure naming its document path and keeping the original error. Its bindings are not prepared until the document is repaired; the document is left unchanged, and other receipts and queued requests continue.

The server rechecks its own host about every five seconds, including requests waiting on foreign holders. `archon trigger drain --host <hostId>` runs one drain and can run after every earlier Archon process has exited, because the queue is durable. For CLI-only hosts, schedule this drain to keep queued work advancing after a foreign holder ends. Neither recovers a request that was already admitted to a run.

A malformed stored checkout-guard declaration is never admitted. Drains pass over that request and log `resource_start.invalid_queued_guard` with its request ID, so valid queued work can continue. The request stays queued and can be inspected and withdrawn with the trigger CLI. New starts with malformed declarations are rejected before storage.

If a known foreign admitted run has a missing or corrupt stored launch and no recorded working path, admission cannot identify its checkout. Guarded starts targeting an in-place path or explicit branch wait (or skip) with that run named as blocker until its launch is repaired or it ends; read-only starts and branchless worktrees can still proceed. SQL logs `db.foreign_launch_invalid_checkout_unknown` or `db.foreign_launch_missing_checkout_unknown` with the foreign run ID.

The file store records admitted run membership in its slot independently of the request, retaining it when a paused run gives back capacity. Slot documents written by older versions remain readable; releasing an older holder records its membership before removing the capacity holder. In both stores, surviving local slot membership requires a matching admitted request; admission, drain, and other local resumes fail until that evidence is repaired or the holder ends. Recorded slot membership determines whether a holder is local or foreign, even when its request falsely names another resource. A request that disagrees with its local slot membership is rejected; a proven foreign holder still permits read-only starts.

A run released by an older version may have neither retained membership nor a capacity holder. Its request alone cannot establish its resource: a request with readable admitted status, resource, and prepared launch keeps that checkout serialized even for read-only starts, while independent checkouts can proceed. Damaged `hostId`, `id`, `overlap`, `blocker`, or `position` fields do not prevent this checkout-only observation. Direct local requests and resume still require a valid complete request. Unreadable checkout projections fail admission and direct drains explicitly. An intact admitted request without contradictory slot membership can resume through normal capacity arbitration, including a paused or failed run released before the upgrade. The checkout remains held while the run is paused.

When independent slot membership is absent, a historical resume trusts the surviving structurally valid admitted request's resource association. If that resource field was damaged to name another valid resource, serialization on the original resource is not guaranteed until the admission evidence is repaired or the holder ends. Surviving contradictory membership is still rejected, guarded starts still wait behind foreign checkout holders, and capacity waiters keep their original priority.

If an older released holder also loses its request document, the stored data cannot distinguish it from a manual run. It receives foreign-holder behavior, so read-only starts can pass it even on its former resource. Preserve or repair the request and slot membership before relying on same-resource serialization in that damaged state.

If a request was admitted but its run remains `pending`, for example because its host stopped before starting it, inspection supplies an explicit `trigger execute` retry. The engine admits only one execution claimant. A drain does not retry it automatically, and the run keeps holding its resource until it runs or is abandoned. When a server-hosted start fails this way, the server logs `resource_start.start_failed` with the run ID and the `archon trigger inspect` command to run.

To stop a running run that a `trigger execute` process owns, use `archon workflow cancel <runId>`. Cancel stops its safely targetable process groups, then records the run as `cancelled`, which releases the resource. If node output pipes remain held, cancel warns that an unsignalled process still holds them. POSIX host commands that started or completed also produce a warning about possible untracked background work, including after continuation. Neither a survivor nor cleanup is confirmed. These owner-stop warnings retain owned checkouts; inspect processes with `lsof`, verify ownership, and stop leftovers before checkout reuse or removal. The next drain admits queued work for it. A run the server executes has no detached owner process, so `archon workflow cancel` refuses it and leaves it unchanged; cancel it from that server instead (Web UI, API, or chat).

A `trigger execute` process stopped with SIGTERM or SIGINT marks its own running run failed before it exits, which also releases the resource. A crash or SIGKILL cannot do that and leaves ownership ambiguous.

If an admitted run has ambiguous ownership after a crash, inspect the request and its blocking run. `archon workflow abandon` is the explicit escape hatch here. If the run's owner answers on this host, abandon stops its safely targetable process groups before recording the run cancelled. A waiting start can then be admitted, even if an output-holder warning reports that an unsignalled process still holds node output. Abandon retains owned checkouts when owner-stop warnings report held output or possible untracked background work, including descendant checkouts and their root. Use `lsof` on the retained checkout before reusing or removing it. If no owner answers, abandon records the run cancelled and prints the host and pid the run recorded; an owner on another host cannot be stopped from here, so verify it has stopped before abandoning. Archon does not abandon a run because it is old or unreachable. Automatic queue draining and recovery of ambiguous execution are separate operations.

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
  },
  "schedule": { "intervalSeconds": 60, "runAtLoad": false }
}
```

The configuration still requires `schedule`, but `fire` does not install or run that schedule. Schedule the poll script itself, rather than `trigger schedule install`, which fires without event values. Set `ARCHON_HOME` and `ORDERS_URL` for the scheduled user, and use absolute executable paths:

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

The final drain also advances queued work on ticks with no items. On CLI-only hosts, continue scheduling drains until queued work has started.

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

Untouched queued work can be removed with `archon trigger withdraw <request-id>`. Receipt and admission records are retained in the installation store (database or file store). This first version has no automatic trigger-record retention policy. Do not map credentials or unnecessary source content into workflow inputs. A run started by a trigger records its receipt and binding IDs in its `resource_start` metadata; its request ID is the run ID, so `archon trigger inspect <run-id>` shows the request. CLI-hosted execution writes the ordinary run output to `ARCHON_HOME/logs/trigger-run-<request-id>.log`. Fresh trigger runs have no chat conversation or message history. Inspect their output with `archon workflow get <run-id>` and `archon workflow logs <run-id>`. Previously queued launches that carry a real conversation retain that history destination.
