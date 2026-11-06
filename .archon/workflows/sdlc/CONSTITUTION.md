# SDLC pack constitution

How the SDLC pack is written. The workflow language is governed by [`workflow-language-constitution.md`](../../workflow-language-constitution.md), project-wide judgment by [`AGENTS.md`](../../../AGENTS.md), and pack conventions such as guards and public writes are in [`README.md`](README.md). Where the pack is still being shaped, a section says how it works today and where it is heading.

## Agents judge, scripts act at boundaries

YAML coordinates, code computes, agents judge. A new step starts as an agent node with a small typed output. Before writing a script, try an agent on the job: most of the pack's work is judgment, and a script that judges freezes one guess into code.

A script is for a fixed rule whose result must be exact: a public write that reads its result back, a claim on a work item, a fact read from git or the forge. It gives agents facts and acts on their decisions; it never re-judges them.

Don't guard what doesn't need guarding. A guard protects its own node's action or stands in front of an irreversible one ([`README.md`](README.md#guards)). An invariant something else establishes is a sentence in the prompt. Check once, where it would show: the review's check that the pull request's head is the reviewed commit already catches a skipped push.

## Nodes talk in typed values

Nodes pass values through `output_format`, never through prose another node parses. Keep outputs to the fields the next node reads. Every run ends with a typed outcome a person can read: done, or not done and why.

## The engine owns lifecycle

Pauses, waits, claims, leases and terminal states are the engine's. Work items live in the engine's state documents and questions go to people as attention items; the pack grows no store, lifecycle or retry loop of its own. Every loop has a round limit.

## Every workflow works on any project

Agents discover a project's commands, branches and CI and record them as typed output. Prompts carry practice that transfers between projects. A project's strong opinions live in policy: defaults in [`.shared/policy/`](.shared/policy), which a project's `.archon/sdlc/policy/<topic>.md` adds to and overrides. A node names only the policy its decision needs. Anything that must be exact, such as label names or allow-lists, is typed configuration. Pack files carry no tracker references or history.

## CI is the validation

An implementer checks only what it changed; CI is the full validation. One agent node judges CI: green marks the pull request ready, red from the change goes back to the implementer, and a flake outside the change gets one re-run. Any other red ends the delivery not ready and the stage pauses. Without CI, that agent runs the full validation once. A red pull request never stays ready.

## Stages hand off through queues

The implement-review-fix loop is one composed run; queues sit between stages, never inside it. A run claims a work item with a conditional write. Labels are declared once, in [`.shared/labels.ts`](.shared/labels.ts).

- Today: issue events start intake, which records triage on the work item and mirrors it as labels. The build queue claims triaged items; the merge queue claims items whose work-item build record is ready.
- Direction: a ready pull request gets a label, and that label starts the merge queue.

## Stops the pack can't answer pause

An unanswerable stop pauses as an attention item labelled with its stage and class, such as `build: scope` or `merge: base`.

- Today: a person or an orchestrating agent answers it; `archon workflow attention --count-by label:build` shows which build classes recur.
- Direction: a recurring class gets a small handler workflow that answers its items through the normal answer channel, without changing the main path or the engine.

## Smaller is the default

Before adding a node, look for one to delete. Measure a structural change against the current pack (outcome correctness, wall clock, cost) before it replaces it.

## Tests help authoring

Don't test the engine in the pack, or the pack in the engine. A pack test checks a script at a tool boundary: it writes an issue once, reads back a pushed head, merges only what was approved.

A fixture stubs the agent nodes so a dry run (`archon workflow test`) checks certain nodes' outputs without spending AI credits. Write one for an outcome a person cares about, not one per route. Agent judgment is checked by its outcome in real runs and evals.

Don't test a prompt's wording, the YAML's shape or a run's route; those pins make the pack harder to change. Most pack files need no test. Delete a test that only checks structure when it breaks.
