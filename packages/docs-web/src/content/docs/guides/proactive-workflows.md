---
title: Proactive workflows
description: Start agent work from an event, let a cheap agent decide whether it matters, and pause for an answer before anything leaves the run.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 10
---

A proactive workflow starts without anyone asking. An event arrives, an agent decides whether it matters, another agent does the work, and the run pauses until its result is approved before Archon acts on it. Whoever answers reviews finished work instead of starting each run.

Archon builds this from parts that already exist:

| Step | Archon primitive |
|------|------------------|
| Something happens | A [trigger binding](/guides/workflow-triggers/) starts a run from a GitHub webhook or a schedule |
| Decide whether it matters | A `prompt:` node on the `small` [model tier](/reference/workflow-language/#portable-model-references) with an [`output_format`](/reference/workflow-language/#output_format-for-structured-json) |
| Stop when it does not | A [`when:`](/reference/workflow-language/#when-condition-syntax) condition on that output |
| Do the work | A `prompt:` node on the default model |
| Ask for approval | A [`wait:` node with the `approval` form](/reference/workflow-language/#attention-waits) |
| Stop on reject | A `cancel:` node with a `when:` condition on the answer |
| Act | A node that runs only when the answer is `approve` |

## The reference workflow

The Archon repository ships one complete example: [`.archon/workflows/examples/proactive-issue-investigation.yaml`](https://github.com/coleam00/Archon/blob/dev/.archon/workflows/examples/proactive-issue-investigation.yaml). It is not part of the bundled pack. Copy it into your project's `.archon/workflows/` to use it.

When an issue opens, it runs these nodes:

1. **`classify`** reads the issue on the `small` tier and returns `route` (`investigate` or `skip`) and a one-sentence `reason`. Most issues need no investigation, so the cheap model reads every issue and the stronger model reads only the ones routed onward.
2. **`investigate`** runs only when `$classify.output.route == 'investigate'`. It reads the issue and the code in the checkout and returns a draft `comment`. Its prompt tells it not to change files or write to GitHub.
3. **`review`** is a `wait:` node with `form: approval`. Its `attention:` message shows the classifier's reason and the full draft. The answer is `{decision, text}`, where `decision` is `approve` or `reject`. Rejecting does not end the run by itself; the next two nodes branch on the decision.
4. **`drop`** runs only when `$review.output.decision == 'reject'`. It is a `cancel:` node, so a rejected draft cancels the run and nothing is posted.
5. **`post`** runs only when `$review.output.decision == 'approve'` and sends the draft with `gh issue comment`. It is a `bash:` node rather than an agent because the review approved that exact text, and an agent could reword it after approval.

The workflow declares `repository` and `issue_number` as required [inputs](/reference/workflow-language/#workflow-signature-inputs-returns-and-inputs), so the trigger binding supplies them. The `review` node needs no extra declaration: a triggered run that reaches it pauses in the attention queue and continues once someone answers.

Every agent node returns a small typed object. Nodes never parse another node's prose, and the `when:` condition compares an enum field, not free text.

## Start it when an issue opens

Bind the workflow to GitHub issue openings in your [webhook source configuration](/guides/workflow-triggers/#configure-github-event-starts). The [workflow triggers guide](/guides/workflow-triggers/) also covers signed Standard Webhooks and CLI-driven polling for systems that cannot send webhooks.

This binding maps the issue number from the event and the repository from a literal:

```json
{
  "bindingId": "widgets-issue-investigation",
  "hostId": "build-host-1",
  "runAsUserId": "2a568f73-e217-40ca-b17d-a784d19fd43a",
  "resource": "github:acme/widgets:issue-investigation",
  "capacity": 3,
  "overlap": "queue",
  "launch": {
    "cwd": "/srv/archon/widgets",
    "workflowName": "proactive-issue-investigation",
    "inputs": {},
    "isolation": { "kind": "default" }
  },
  "selector": {
    "kind": "issue.lifecycle",
    "actions": ["opened"],
    "repository": { "host": "github.com", "path": "acme/widgets" }
  },
  "inputMapping": {
    "issue_number": { "source": "field", "field": "subject.number" },
    "repository": { "source": "literal", "value": "acme/widgets" }
  }
}
```

A run waiting at `review` is `paused`, and it gives its resource slot back while it waits, so unreviewed drafts do not block later issues. `capacity: 3` bounds how many investigations execute at once. When a draft is approved, its run continues ahead of queued issues once a slot frees. This needs a continuation host: `archon serve`, or `archon workflow wake --watch` beside the trigger host. See [resource, capacity, and overlap](/guides/workflow-triggers/#choose-a-resource-capacity-and-overlap-policy).

The run uses the provider configuration and credentials of `runAsUserId`. The `gh` CLI must be authenticated for that user on the execution host, because both agents and the `post` node call it.

To run the same pattern on a timer instead, use a [schedule binding](/guides/workflow-triggers/#configure-a-native-macos-schedule). A schedule has no event to map from, so the workflow's first node has to find its own work, such as listing issues opened since the last run. Keep that cursor in a [durable state document](/reference/workflow-language/#durable-state-documents) and update it from a `bash:` or `script:` node, so the next run starts where this one stopped.

## Review the draft

A triggered run has no chat conversation, so the attention message is not posted to a chat. The console's [Needs your input](/guides/workflow-triggers/#find-runs-needing-your-input) banner lists the paused run with its message and approve and reject controls. From the CLI, find paused runs and read the draft with:

```bash
archon workflow status --all
archon workflow get <run-id>
```

Then approve or reject it. Approving continues the run to `post`. Rejecting continues it to `drop`, which cancels the run. The reason is recorded as the answer's `text`:

```bash
archon workflow approve <run-id>
archon workflow reject <run-id> "Wrong root cause"
```

## Check the routes before deploying

The fixtures beside the workflow cover its outcomes. A stub for `review` stands in for its answer and must match the approval form's output. `posted` routes an issue to investigation, answers `review` with `{ decision: approve, text: "" }`, and checks that the attention message and the `post` node both carry the draft. `rejected` answers `review` with `decision: reject` and expects the run to end cancelled at `drop`; `post` has no stub, so the fixture fails if it runs. `skipped` routes an issue to `skip` and fails if any later node runs. Run them without calling a model or GitHub:

```bash
archon workflow test proactive-issue-investigation
```

To see the run stop at `review`, stub only the two agent nodes. With no stub for `review`, the simulation pauses there, as a real run would:

```bash
archon workflow run proactive-issue-investigation --dry-run \
  --stubs stubs.yaml --input repository=acme/widgets --input issue_number=42
```

where `stubs.yaml` holds:

```yaml
classify: { route: investigate, reason: "a regression with a stack trace" }
investigate: { comment: "The cause is the null check in parser.ts" }
```

## Adapting it

- **Change what counts as worth investigating** in the `classify` prompt. Keep its output an enum so the `when:` condition stays an exact comparison.
- **Change the work** in the `investigate` prompt. Keep the instruction not to write anywhere; `review` exists so the result is approved before it leaves the run.
- **Change the action** in the `post` node. If the action itself needs judgment, such as applying a fix, use an agent node after `review` and have `review` approve the plan rather than exact text.
