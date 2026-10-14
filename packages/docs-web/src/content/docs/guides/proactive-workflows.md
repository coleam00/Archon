---
title: Proactive workflows
description: Start agent work from an event, let a cheap agent decide whether it matters, and keep a person on the loop before anything leaves the run.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 10
---

A proactive workflow starts without anyone asking. An event arrives, an agent decides whether it matters, another agent does the work, and a person approves the result before Archon acts on it. The person stays on the loop: they review finished work instead of starting each run.

Archon builds this from parts that already exist:

| Step | Archon primitive |
|------|------------------|
| Something happens | A [trigger binding](/guides/workflow-triggers/) starts a run from a GitHub webhook or a schedule |
| Decide whether it matters | A `prompt:` node on the `small` [model tier](/guides/authoring-workflows/#portable-model-references) with an [`output_format`](/guides/authoring-workflows/#output_format-for-structured-json) |
| Stop when it does not | A [`when:`](/guides/authoring-workflows/#when-condition-syntax) condition on that output |
| Do the work | A `prompt:` node on the default model |
| Ask a person | An [approval gate](/guides/approval-nodes/) |
| Act | A node that runs only after approval |

## The reference workflow

The Archon repository ships one complete example: [`.archon/workflows/examples/proactive-issue-investigation.yaml`](https://github.com/coleam00/Archon/blob/dev/.archon/workflows/examples/proactive-issue-investigation.yaml). It is not part of the bundled pack. Copy it into your project's `.archon/workflows/` to use it.

When an issue opens, it runs these nodes:

1. **`classify`** reads the issue on the `small` tier and returns `route` (`investigate` or `skip`) and a one-sentence `reason`. Most issues need no investigation, so the cheap model reads every issue and the stronger model reads only the ones routed onward.
2. **`investigate`** runs only when `$classify.output.route == 'investigate'`. It reads the issue and the code in the checkout and returns a draft `comment`. Its prompt tells it not to change files or write to GitHub.
3. **`review`** is an approval gate. Its message shows the classifier's reason and the full draft. Approving continues the run. Rejecting cancels it, so nothing is posted.
4. **`post`** sends the draft with `gh issue comment`. It is a `bash:` node rather than an agent because the person approved that exact text, and an agent could reword it after approval.

The workflow declares `repository` and `issue_number` as required [inputs](/guides/authoring-workflows/#workflow-signature-inputs-returns-and-inputs), so the trigger binding supplies them. The `review` gate needs no extra declaration: a triggered run that reaches it pauses in the attention queue and continues once someone answers.

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

A run waiting at the approval gate is `paused`, and a paused run keeps holding its resource. With the default `capacity` of 1, one unreviewed draft would queue every later issue behind it. With `capacity: 3`, new issues keep starting while up to two drafts wait; once three wait, later issues queue until one is reviewed. Runs that the classifier skips finish in seconds and release their slot.

The run uses the provider configuration and credentials of `runAsUserId`. The `gh` CLI must be authenticated for that user on the execution host, because both agents and the `post` node call it.

To run the same pattern on a timer instead, use a [schedule binding](/guides/workflow-triggers/#configure-a-native-macos-schedule). A schedule has no event to map from, so the workflow's first node has to find its own work, such as listing issues opened since the last run. Keep that cursor in a [durable state document](/guides/authoring-workflows/#durable-state-documents) and update it from a `bash:` or `script:` node, so the next run starts where this one stopped.

## Review the draft

A triggered run has no chat conversation, so the gate message is not posted to a chat. The console's [Needs your input](/guides/workflow-triggers/#find-runs-needing-your-input) banner lists the paused run with its gate message and approve and reject controls. From the CLI, find paused runs and read the draft with:

```bash
archon workflow status --all
archon workflow get <run-id>
```

Then approve or reject it. Approving continues the run to `post`; rejecting cancels it:

```bash
archon workflow approve <run-id>
archon workflow reject <run-id> "Wrong root cause"
```

## Check the routes before deploying

The fixtures beside the workflow cover its outcomes. `posted` routes an issue to investigation, auto-approves the gate, and checks that the gate message and the `post` node both carry the draft. `skipped` routes an issue to `skip` and fails if any later node runs. Run them without calling a model or GitHub:

```bash
archon workflow test proactive-issue-investigation
```

To see the run stop at the gate, stub the two agent nodes and pause there:

```bash
archon workflow run proactive-issue-investigation --dry-run --pause-at-gates \
  --stubs stubs.yaml --input repository=acme/widgets --input issue_number=42
```

where `stubs.yaml` holds:

```yaml
classify: { route: investigate, reason: "a regression with a stack trace" }
investigate: { comment: "The cause is the null check in parser.ts" }
```

## Adapting it

- **Change what counts as worth investigating** in the `classify` prompt. Keep its output an enum so the `when:` condition stays an exact comparison.
- **Change the work** in the `investigate` prompt. Keep the instruction not to write anywhere; the gate exists so a person sees the result before it leaves the run.
- **Change the action** in the `post` node. If the action itself needs judgment, such as applying a fix, use an agent node after the gate and have the gate approve the plan rather than exact text.
