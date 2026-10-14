---
title: The Attention Queue
description: List, read, label and answer paused runs from outside Archon, and route classes of questions to your own handler workflows.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 5
---

Every paused run that needs someone is an item in the attention queue. A person at a
terminal, an agent wired to the queue through a skill, or a workflow you write can list
the items, read one, and answer it, all as JSON. Archon routes nothing: every answerer
sees every item, the answer names the pause it is for, and a second answer to the same
pause is refused.

## The contract

| Operation | CLI | HTTP |
|---|---|---|
| List | `archon workflow attention --json [--project <id\|name\|key> \| --all] [--label k=v]… [--sort age\|label:<key>]` | `GET /api/runs/attention?project=…&label=…&sort=…` |
| Count | `archon workflow attention --json --count-by project\|label:<key>` | `GET /api/runs/attention?countBy=…` |
| Read one | `archon workflow attention <run-id> --json` | `GET /api/runs/<run-id>/attention` |
| Label | `archon workflow attention label <run-id> --occurrence <id> [--set k=v]… [--unset k]…` | `POST /api/runs/<run-id>/attention/labels` |
| Answer | `archon workflow answer <run-id> --occurrence <id> …`, or `respond`, `approve`, `reject` | `POST /api/workflows/runs/<run-id>/answer` |
| Give up on the run | `archon workflow abandon <run-id>` | `POST /api/workflows/runs/<run-id>/abandon` |

The [CLI reference](/reference/cli/#workflow-attention) lists every flag. The list, the
single read and `workflow wait` all derive from the same run projection, so they cannot
disagree about what a run needs.

- **Scope.** The CLI defaults to the project of the working directory. `--project` names
  another project and `--all` covers the install. Over HTTP there is no working directory,
  so the default is the install.
- **Filters.** `--label k=v` is an exact match on the label's value, and repeated filters
  must all match. No filter or field depends on who is asking.
- **Order.** `age` puts the oldest pause first. `label:<key>` sorts by that label's value
  as a plain string. The engine reads no meaning into labels or messages.

## Queue items

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
  paused run Archon cannot describe; `reason` and `detail` say why, and the action is to
  look at it and resume or abandon it.
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

1. **Watch.** A scheduled workflow polls `archon workflow attention --json --all` and keeps
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
