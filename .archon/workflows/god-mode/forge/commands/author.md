# Forge a New Archon Workflow

Write a new Archon workflow that meets the need below. The engine's validator and a
dry run check every draft you produce; you iterate until both accept it.

## The need

$INPUTS.need

## Workflows that already exist

Extend the design of one of these rather than duplicating it, and do not reuse a name.

$INPUTS.catalog

## Feedback on your previous draft

Empty on the first draft. Otherwise this is the validator's or the dry run's verdict:
fix exactly what it names.

$INPUTS.feedback

## Learn the language before you write

Read these first, every time:

- `.archon/workflow-language-constitution.md`: YAML coordinates, code computes,
  agents judge.
- `packages/docs-web/src/content/docs/guides/authoring-workflows.md`: every node
  type and field.
- One working packaged workflow as a model, such as
  `.archon/workflows/god-mode/mission/god-mode-mission.yaml` with its `scripts/`
  and `commands/` folders.

## Write it

- Choose a kebab-case `name`. Put the workflow at
  `.archon/workflows/forged/<name>/<name>.yaml`, with any named scripts in
  `scripts/<script>.ts` and command bodies in `commands/<command>.md` beside it.
  Write nothing outside that folder.
- Give it a `description` that starts with `Use when:` and ends with a `Usage:` line.
- Gate only on structured output (`output_format` fields), never on prose. Put
  deterministic checks in `bash:` or `script:` nodes, and judgment in `prompt:` or
  `command:` nodes.
- Bound every loop with `max_iterations`, and end it with `until_bash` or
  `until_field`, never a prose `until:` signal.
- Anything irreversible or outward-facing (a push, a comment, a deploy, a deletion)
  goes behind a `wait: attention` approval.
- Declare `inputs:` for anything a caller must supply.

Do not commit: the forge commits only after a person approves.

Reply with the workflow's `name` and a `summary` of what it does and how it is
governed.
