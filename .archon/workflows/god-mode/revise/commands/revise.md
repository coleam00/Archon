# Revise Existing Automation

Change existing automation in this repository (a workflow, a prompt, a script, or a
policy document under `.archon/`) to meet the need below. Deterministic checks judge
every attempt, and a person reads the full diff before anything leaves this checkout.

## The need

$INPUTS.need

## Feedback on your previous attempt

Empty on the first attempt. Otherwise this is why the last attempt was not eligible:
fix exactly what it names.

$INPUTS.feedback

## Before you edit

- Read `AGENTS.md`, `.archon/workflow-language-constitution.md`, and, if you touch a
  pack, that pack's own README and constitution (for example
  `.archon/workflows/sdlc/CONSTITUTION.md`). A revision that breaks a pack's own rules
  will be rejected in review even when every check passes.
- Read the files you will change and every consumer of anything you rename.
- Prefer sharpening an existing prompt or policy over adding machinery. The smallest
  change that fixes the evidence is the best one.

## The rules your attempt is checked against

- Change only files under `.archon/`. Never change `.archon/config.yaml` or anything
  under `.archon/workflows/god-mode/`: those are refused outright.
- No workflow may stop validating, and no fixture that passed may start failing. If
  your change alters a workflow's routing, update or add its fixture beside it.
- Declare `acceptance`: shell commands that prove the change does what the need asks,
  for example the pack's tests (`bun run test <path>`), `bun run lint`, or a
  `bun run cli workflow test <pack-path>` run. At least one, and never one that passes
  regardless of the change.

Do not commit or push. That happens only after a person approves.

Reply with a pull-request `title` (outcome-focused), a `summary` of what changed and
why it fixes the evidence, and your `acceptance` commands.
