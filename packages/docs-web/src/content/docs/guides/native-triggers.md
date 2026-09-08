---
title: Native trigger admission
description: Deliver qualified issue events and scheduled ticks to an explicitly configured workflow.
---

Native triggers bind an install-owned event policy to one explicit workflow. The engine records admission and the run together, freezes workflow source, and executes the normal workflow lifecycle. This is the issue intake and host-driven scheduling slice of issue #998.

Create `triggers.json` under `ARCHON_HOME` (normally `~/.archon`). It contains an array of bindings. Register the target project first and use its codebase ID. Paths refer to the machine running Archon.

```json
[
  {
    "id": "daily-regression",
    "kind": "schedule",
    "scheduleId": "daily-regression",
    "workflow": "regression",
    "sourceRoot": "/srv/shared-workflows",
    "source": "project",
    "codebaseId": "YOUR_REGISTERED_PROJECT_ID",
    "overlap": "skip",
    "inputs": { "mode": "regression" },
    "facts": { "tick": "tick" }
  },
  {
    "id": "issue-intake",
    "kind": "github.issue",
    "repository": "example/project",
    "actors": ["trusted-operator"],
    "action": "labeled",
    "label": "ready-for-intake",
    "workflow": "intake",
    "sourceRoot": "/srv/shared-workflows",
    "source": "project",
    "codebaseId": "YOUR_REGISTERED_PROJECT_ID",
    "overlap": "allow",
    "facts": { "issue_url": "issueUrl", "delivery": "eventId" }
  }
]
```

The named workflow must exist exactly in the selected discovery scope (`project`, `global`, or `bundled`). A higher-scope override of the configured source is refused. Unknown names, source errors, ambiguous GitHub routes and undeclared inputs are refused before any agent runs. Every key in `inputs` and `facts` must be declared in the workflow's `inputs` contract. `inputs` provides fixed string values; `facts` maps input names to qualified event facts. A key cannot be supplied by both.

Available facts are `eventId` for all events; `scheduleId` and `tick` for schedules; and `repository`, `actor`, `issueNumber`, and `issueUrl` for GitHub issues. Issue bodies and titles are not command or prompt channels. A workflow can fetch the qualified issue through its own declared nodes.

## Scheduled regression

Have an ordinary OS scheduler write one event document for each intended tick:

```json
{
  "kind": "schedule",
  "scheduleId": "daily-regression",
  "eventId": "2026-09-08T12:00:00Z",
  "tick": "2026-09-08T12:00:00Z"
}
```

Then invoke:

```sh
archon workflow trigger daily-regression /srv/ticks/current.json --json
```

The command waits for its native execution to finish or pause and emits a JSON result with `disposition`, `runId`, `status`, and `outcome`. A newly executed failed workflow exits nonzero. A duplicate or skipped delivery reports the existing run without executing it. Use the scheduled time as the stable event ID; repeating a delivery must retain that ID. The scheduler drives this one command and does not inspect workflow results to select later stages.

Schedules require `overlap: "skip"`. Pending, running and paused runs hold the trigger, as do failed runs with a scheduled quota continuation. A tick delivered while held is durably skipped, with the blocking run ID. It does not enter a queue, and redelivering that tick after the blocker ends still reports skipped. A new tick may start once the prior run is terminal and has no automatic continuation.

## GitHub issue intake

Use the existing `/webhooks/github` endpoint with GitHub's `issues` subscription. Supported actions are `opened` and `labeled`. An `opened` binding must omit `label`; a `labeled` binding must name the exact added label. Each repository/action/label must resolve to at most one binding. PR events are outside this slice.

The existing HMAC verification and `GITHUB_ALLOWED_USERS` check run first. The binding additionally requires an explicit repository and actor allowlist, even if the install-wide allowlist is empty. `X-GitHub-Delivery` is required. Repository identity and issue number are validated. Existing comment mentions and their authorization retain their current behavior. Automatic issue delivery goes directly to the declared workflow, with no conversation-agent fallback or payload-selected command execution.

The endpoint acknowledges after durable admission, without waiting for workflow completion. Persistence failures return an error so a delivery can be retried. Progress and attribution are recorded in native run events and `metadata.trigger`; this surface does not post unsolicited GitHub comments.

## Recovery and inspection

Deduplication is scoped by binding ID and event ID and survives restarts and concurrent hosts. Admission stores the run relation and frozen-source identity in the same transaction. Losing a successful response therefore cannot create another run.

A crash after admission but before the execution claim leaves a pending run which redelivery can launch from its captured source. Once a host claims execution, redelivery only reports the same run. A lost owner is ambiguous and requires operator action through native run inspection, resume where supported, or abandon. Elapsed time never declares completion or authorizes an automatic replay. Keep binding IDs stable; changing one creates a new deduplication namespace. A deliberate new launch requires a new event ID under the configured event policy.

Use `archon workflow get <run-id>`, `wait`, `resume`, and `abandon` for native lifecycle management. Pauses and cancellation remain engine outcomes. Admitted run records are retained by admission foreign keys so deleting a run cannot silently permit event replay. Bulk cleanup skips those runs and their events. An uncertain admission commit also retains its candidate source capture for inspection.

This slice supports repo worktrees and folder execution through the existing isolation resolver. Container startup is refused, including a folder project's enabled container policy. It does not add a cron evaluator, polling triggers, arbitrary webhook endpoints, trigger YAML, or trigger management UI, and does not close the whole of #998.
