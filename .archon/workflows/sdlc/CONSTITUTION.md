# SDLC pack constitution

How the SDLC pack is written. The workflow language is governed by [`workflow-language-constitution.md`](../../workflow-language-constitution.md) and project-wide judgment by [`AGENTS.md`](../../../AGENTS.md). The pack is the reference implementation for operators who build their own pack on Archon, so it stays small enough to read in one sitting.

## Agents judge, the engine moves the work

YAML coordinates, code computes, agents judge. A stage is an agent node with a prompt and a small typed output. The engine owns everything between stages: the item, admission of one run per workflow per item, outcomes, asks and answers, the hand-off from one stage to the next, the checkout a stage continues in, round limits, links and the merge record. The pack grows no record, queue, claim, lease, sweep or state document of its own. Where the engine lacks a primitive the pack needs, that is an engine gap to file, not a script to write.

## A script is the last resort

Before writing a script, try an agent on the job: most of the pack's work is judgment, and a script that judges freezes one guess into code. A script gives plain facts or acts at a boundary where an agent's word is not enough, such as recording a merge as the forge reports it. Every script says in its first lines why an agent cannot do its job. The pack has one.

## Nodes talk in typed values

Nodes and stages pass values through `output_format`, outcomes, `result_of` inputs and answers, never through prose another node parses. Keep an output to the fields a later stage reads. A report too large for an output is a file the output names by its path.

## Every stage ends

A stage never pauses for an operator. It finishes its work and ends with a named outcome; when a decision is not its own, it leaves the decision as an ask on the item and ends. Its answer starts the next run. An outcome that hands nothing on is a deliberate end, such as a closed issue, and the engine's item tracker reports it. Every way back to the builder has a round limit.

## Intake is a label

Work starts only when a maintainer labels an issue `archon-triage`, or when an operator starts a stage by hand. An issue nobody labelled reaches no agent. A stage may label an issue it filed only to continue work a maintainer already started, as the split stage does for its pieces.

## Every workflow works on any project

Agents discover a project's commands, branches and CI. Prompts carry practice that transfers between projects. A project's opinions live in policy: defaults in [`.shared/policy/`](.shared/policy), which a project's `.archon/sdlc/policy/<topic>.md` adds to and overrides. A node names only the policy its decision needs. A value that must be exact is a typed setting in [`.pack/pack.yaml`](.pack/pack.yaml), and there is one, `ci`. Pack files carry no tracker references, history, provider or model names.

## Prompts are the product

The prompts are tuned against real runs, and changes to them are measured on real items before they replace what was there. Their input lines say what the structure passes; their judgment text is what makes the pack good. Keep that text when the structure changes.

## Smaller is the default

Before adding a node, a binding or a policy line, look for one to delete. Measure a structural change against the current pack (outcome correctness, wall clock, cost) before it replaces it.

## No pack tests

The pack has no tests. Agent judgment is checked by its outcome on real items and in evals; the engine tests the workflow language with its own fixtures; `archon validate workflows`, `archon pack bindings` and `archon trigger check` check the wiring. A script that grows a rule worth testing is a script that should be an engine primitive.
