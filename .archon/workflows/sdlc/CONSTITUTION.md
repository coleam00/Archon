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

Draw the workflow as nodes and outcomes before building it. Test each outcome once with a fixture. Don't add a fixture per route through the graph.

## 6. CI is one agent node

One agent waits for CI and judges it. Green: it marks the PR ready. Red because of the change: the work goes back to the implementer. Red from a flake or an infrastructure failure on a path the change doesn't touch: the agent may re-run the failed jobs once and judge again, in the same round. Red for any other reason, such as a broken base branch: the run stops, not ready, with the cause. No polling loops, no retry nodes, no classification scripts. Every loop has a round limit. Never leave a red PR ready.

## 7. CI is the validation

An agent tests, lints and type-checks the code it changed, nothing more. The project's full validation is its CI, which runs on every push across every platform it supports. A full local run in a node repeats CI more slowly, on one platform, and costs every node after it. A project with no CI gets its full validation from the CI agent, once, before the work is marked ready.

## 8. The pack works for any project

The pack doesn't know a project's commands, branches, CI names or language. An agent discovers them and records them as typed output. Pack files carry no tracker references and no history; they describe what is true now.

## 9. Smaller is the default

Before adding a node, look for one to delete. A structural change is drawn with the maintainer first, and benched against the current pack before it replaces it. The bench reports outcome correctness, wall clock and cost.
