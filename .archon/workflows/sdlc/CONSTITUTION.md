# SDLC workflow constitution

How we write the SDLC pack and the workflows built like it. The workflow language rules are in [`workflow-language-constitution.md`](../../workflow-language-constitution.md); this page is about how we use them. Pack conventions such as guards are in [`README.md`](README.md).

## 1. Agents first

A new step starts as an agent node: a prompt plus a small typed output. Most of the pack's work is judgment: reading a plan, reviewing a diff, working out why CI is red. Agents do that well, and a script that tries to do it freezes one guess into code.

## 2. Determinism after a failure, not before

A script node, a guard, a wait or a retry is added only after a real run failed in a way an agent node can't handle. The node names that failure. The exception is a guard in front of an irreversible action, the kind [`README.md`](README.md#guards) keeps. An invariant someone can imagine is not a reason to add a node; say the invariant in the prompt.

## 3. One check at the boundary, not one per step

If a later step already proves something went wrong, don't add a step to prove it earlier. Example: the agent that writes a correction pushes it, and the review's check that the PR head matches the reviewed commit catches a skipped push.

## 4. Typed outputs, small

Nodes talk through `output_format`, never through prose another node parses. Keep outputs to the few fields the next node or the run outcome reads. Every run ends with a typed outcome a person can read: done, or not done with the reason.

## 5. Outcomes over routes

Draw the workflow as nodes and outcomes before building it. A fixture shows an outcome a person cares about, once. Don't add a fixture per route through the graph, and don't pin a prompt's wording in one.

## 6. CI is one agent node

One agent waits for CI and judges it. Green: it marks the PR ready. Red because of the change: the work goes back to the implementer. Red from a flake or an infrastructure failure on a path the change doesn't touch: the agent may re-run the failed jobs once and judge again, in the same round. Still red after that re-run, or red for any other reason, such as a broken base branch: the run pauses, not ready, with the cause, as section 11 describes. No polling loops, no retry nodes, no classification scripts. Every loop has a round limit. Never leave a red PR ready.

## 7. CI is the validation

An agent tests, lints and type-checks the code it changed, nothing more. The project's full validation is its CI, which runs on every push across every platform it supports. A full local run in a node repeats CI more slowly, on one platform, and costs every node after it. A project with no CI gets its full validation from the CI agent, once, before the work is marked ready.

## 8. The pack works for any project

The pack doesn't know a project's commands, branches, CI names or language. An agent discovers them and records them as typed output. Pack files carry no tracker references and no history; they describe what is true now.

## 9. Smaller is the default

A workflow should be simple to write: a few nodes, a few prompts, and a script only where section 2 allows one. The pack is a set of workflows, not an application. When it grows its own store, lifecycle or test framework, cut it back.

Before adding a node, look for one to delete. A structural change is drawn with the maintainer first, and benched against the current pack before it replaces it. The bench reports outcome correctness, wall clock and cost.

## 10. Stages are queues joined by labels

The pack is a set of queues joined by labels on the forge. Triage labels an incoming issue. That label starts the check or delivery the issue needs. A pull request that is ready gets a label, and that label starts the merge queue. A new stage is one more queue on the same pattern.

Each queue is a standing workflow that a trigger starts. Its work item is a state document: it links the runs that worked on the item, and a run claims the item with a conditional write, so two runs never take the same one. The implement-review-fix loop stays one composed run; queues sit between stages, never inside that loop.

Label names are pack configuration, and the project owns them.

## 11. A new failure pauses; a recurring one gets a handler

A failure the pack has no answer for doesn't end the run. The run pauses as an attention item labelled with the failure's class, such as `ci: other` or `merge: conflict`.

When a class recurs, write a small handler workflow for it. A trigger on the class label starts the handler, and the handler answers the pause through the normal answer channel. A class with no handler waits for any answerer. The count of attention items per label shows which handler to build next.

Adding a handler changes neither the pack's main path nor the engine.

## 12. Policy is a project document

Pack policy, such as what triage accepts or when a pull request may merge, lives in markdown policy documents the project can reword. They work like the project's other sidecar documents: a judging node reads them at `.archon/sdlc/policy/<topic>.md`, falling back to the pack's default. The pack ships a default for each, and a project's own document adds to it: the node reads the default first and the project's document after it, and where the two conflict, the project's line wins. A project's document may be nothing but its additions, or a pointer to documents the project already has, such as "Triage against `.archon/direction.md`, and against `docs/product/` for feature scope", and the agent reads what it points to.

Each node names only the policy documents its decision needs; no policy goes to every node. Agents interpret policy prose, and nothing parses it. Anything that must be exact, such as label names, allow-lists of users or numeric caps, stays typed configuration.

## 13. Tests check behavior, not structure

The engine tests the workflow language: that `when:` gates, includes expand, loops stop and outputs validate. The pack doesn't test those again, and it supplies no fixture for an engine test. The engine tests itself with its own fixtures.

A pack test checks what a script does at a tool boundary, such as writing an issue exactly once, reading back a pushed head, or merging only what was approved. Agent judgment is checked by evaluating the outcome, not with fixtures. Nothing tests a prompt's wording, the YAML's shape or the route a run takes. Pins like that make the pack harder to change and teach agents to satisfy the pins instead of reaching the outcome.

Most pack files need no test. A prompt, a policy document, or a script with no tool-boundary behavior gets none. When a change breaks tests that only check structure, delete those tests.
