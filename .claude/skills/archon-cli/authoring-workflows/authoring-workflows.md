---
name: archon-cli-authoring
description: Design and write an Archon workflow: outcome-first decomposition, gate design, node types, loop channels, packaging, fixtures. Read when creating or editing workflow YAML.
---

# Authoring Workflows

Design and write an Archon workflow — for code work, business operations, or any
governed process. The method is outcome-first; the mechanics follow from it.
Exemplars: the bundled sdlc pack in any Archon checkout under
`.archon/workflows/sdlc/<primitive>/` — read a pack YAML before writing your own.
Archon is not code-only: triage an inbox of tickets, reconcile accounts,
screen applicants, keep CRM records honest — the same node types, gates, and
discipline apply. What changes per domain is where the gates come from (below).

## The design sequence

Work through these questions in order, with the user where marked:

1. **Desired outcome.** What artifact or world-state exists when this succeeds?
   One sentence. If it cannot be stated as an outcome, it is not ready to build.
2. **Specificity (with the user).** Is this workflow written against ONE project
   or outcome, or meant to be generally reusable? This changes everything
   downstream: a project-specific workflow may hardcode that repo's real gates,
   real commands, real rules, and speak in its vocabulary — which makes it far
   more powerful than any generic equivalent. Ask before designing.
3. **Reuse check.** Which of the USER'S OWN workflows already do part of this?
   (`archon workflow list`, then read their YAML.) Compose those via `include:`.

   **The bundled sdlc pack is NOT a component library.** Its workflows exist to
   teach how good workflows are written — read them as worked examples of gate
   placement, prompt contracts, and fixture discipline, never `include:` them
   into a user workflow by default. Their prompts and gates are deliberately
   general so they fit any project; a user workflow composed out of them inherits
   that generality and loses the specificity that made it valuable. If the user
   asks for "something like archon-ship but for my repo", write a new workflow in
   their project's terms, using the pack only as the craft reference.
4. **Primitives.** Thinking in primitives is right: name the small jobs that
   compose into the outcome — investigate, decide, implement, verify, publish;
   or intake, enrich, judge, route, notify for an ops queue.
   Package each coherent reusable primitive as a workflow folder with declared
   `inputs:` and `returns:`. It can then run alone or compose into a parent with
   `include:` and `with:`. Nodes implement a primitive's internals and the small
   one-off glue in a parent: use an AI node for judgment and code for a checkable
   fact. The primitive set comes from THIS outcome, not from copying another
   workflow's node list.
5. **Gate placement (with the user).** Where must the run stop before
   continuing, and what decides? Three gate kinds, all first-class:

   - **Deterministic gates** — a `bash:`/`script:` node owning an exit code or a
     `when:` on a declared field. Use wherever a checkable fact settles it —
     in code work: tests pass, file exists; in ops: totals reconcile, every
     row has an owner, the export count matches the source. Cheapest and least
     arguable.
   - **Prompt command gates** — an independent verifier judging another agent's
     output against an evidence bar. Start the verifier with `context: fresh`,
     have it read the diff/artifact/entry, check claims and criteria, and return a
     structured boolean that drives the loop or branch. When gate design is
     unknown, START HERE: an agent checking agents is the most powerful
     general-purpose gate and catches what no fixed check anticipated. Keep the
     verdict structured (`output_format` boolean) so a machine consumes it; keep
     the judgment prose in the prompt. Grounded on an **authored sidecar** — a
     versioned rubric/directions file in the repo — an agent judgment gate stands
     in for a typical human reviewer: same criteria, same questions, recorded
     answers, every run.
   - **Human `approval:` gates** — only two cases justify them: an
     **interactive** workflow where a human is present at the console and reads
     each iteration, or a **super load-bearing** action — irreversible,
     public-facing, or expensive beyond easy rollback (deploy, post publicly,
     delete data, send customer-facing communication). Everything else should be
     decidable by code or by another agent. Remember: any `approval:` gate forces
     `interactive: true` at the workflow level. The fresh launch cannot detach;
     continuation actions on an already-paused run can.

   On a project-specific workflow the user often already knows some of these —
   "never push before I see the diff", "stop if the migration touches billing",
   "no applicant advances without both scorecards agreeing" — collect them
   verbatim; they become approval gates, cancel nodes, or `when:` conditions.
   Everything else defaults to a prompt command gate until a real run proves
   which part can be made deterministic.

   **Gates are latent in every domain.** Any process humans govern already
   invented its controls: double-entry, reconciliation, four-eyes review,
   checklists, read-backs. Elicitation is the authoring work — have a strong
   model propose candidate gates from domain knowledge, then have the user (the
   domain expert) validate which ones actually bind. A proposed gate earns trust
   only after it has demonstrably refused a planted bad outcome — prove gates red
   the way you prove fixtures red.
6. **Data flow.** What does each node hand the next? Declared values
   (`$node.output`, `output_format` fields, workflow `inputs:`/`returns:`) carry
   scalars; artifacts (`$ARTIFACTS_DIR`) carry documents and evidence for humans.
7. **Prompting** per node → see `../prompting-mistakes/prompting-mistakes.md` before writing prose.
8. **Wiring** into YAML (below), then **fixtures**: every authored workflow ships
   a dry-run fixture under `<pack>/<workflow>/fixtures/*.stubs.yaml` declaring its
   expected outcome. Prove red paths red before trusting them — on a clean tree.
   Fixtures prove the paths that dry-run can execute. A reachable `workflow:` or
   `include:` + `fan_out:` node fails dry-run by design, so prove that path with a
   small real acceptance run while keeping fixtures for the surrounding wiring.
9. Validate: load-time errors surface in `archon workflow list`; then
   `archon workflow test <workflow>` runs supported fixture paths without AI spend.

## Start simple, then adapt to what runs teach

The first version is deliberately under-engineered:

- Use few nodes, short prompts, and key gates. Do not add determinism without evidence;
  before a real run, it is only a guess about where things fail.
- Dogfood it immediately on something real — a genuine task in the actual repo,
  not a demo. The run itself is the test.
- Adapt from evidence, not anticipation: a failure shows which gate was missing;
  a wasted review shows which check earned its place. Add machinery only where a
  logged occurrence demands it.
- Iterate in place: edit the folder, rerun the same kind of task, compare the
  artifacts. The workflow converges on the project instead of being designed
  up front.

All mechanical detail lives in `node-reference.md` (every node type and field,
when:/trigger_rule wiring, fixtures) with the full substitution semantics in
`variables.md` — read both when writing YAML.

## File layout — one folder per workflow

A workflow IS a folder: everything it needs travels with it, and the folder is
copyable between repos as one unit. To start one in a repo:

```bash
mkdir -p .archon/workflows/my-pack/my-workflow/{commands,scripts,fixtures}
```

```text
.archon/workflows/<pack>/<workflow>/
├── <workflow>.yaml      # name, description, inputs:, returns:, nodes:
├── commands/*.md        # prompt files referenced by command: nodes
├── scripts/*.py|.ts     # deterministic logic (Python/uv preferred, TS/bun fine)
└── fixtures/*.stubs.yaml
```

Substantive prompts live in command files, not inline. Inline `bash:` only for
one-or-two-line glue; anything with branching is a script file. Never shell as a
script language for logic. Ask the user their script-language preference if they
will maintain it.

## Node types — one per node

`command` (prompt file) · `prompt` (inline) · `bash` (shell, no AI) · `script`
(py/ts, no AI) · `loop` (iterate one AI node) · `loop_group` (repeat a sub-DAG) ·
`approval` (human gate) · `cancel` (terminate with reason, usually behind `when:`) ·
`wait` (durable suspension) · `workflow` (governed child run) · `include`
(plain load-time composition or runtime-width in-run composition with `fan_out:`).

Selection rules of thumb:

- A machine-verifiable check → `bash:`/`script:` node, never an AI asked to "check".
- Model judgment that gates downstream spend → AI node with `output_format` boolean
  + a downstream gate or loop channel reading that field.
- Repeated act→verify cycle → `loop_group` with the verify node's structured
  boolean driving completion.

## Loop completion channels — pick by tier

- Completion externally checkable → `until_bash: "<exit-0 check>"`.
- Completion is the model's judgment → `output_format` + `until_field: <bool-field>`.
- Prose sentinel (`until: TOKEN`) only at interactive gates a human reads.
  Declare at least one channel per loop.

## Structured output: only where a machine decides

Declare `output_format` when a `when:`, `until_field`, or script consumes the
field. Otherwise let output stay whole-string prose — schemas are a reliability
tax on non-enforcing providers. Provider-agnostic YAML always: tiers
(`small|medium|large`) never literal model ids, no `provider:` keys in bundled work.

## Isolation and interactivity

- At workflow level, `worktree.enabled: true` pins worktree isolation. Omission
  leaves the choice to the caller. On a `workflow:` child node,
  `isolation: worktree` explicitly gives the child its own worktree. A worktree
  bounds git files; it does NOT isolate `~/.archon`, env, database, or sessions.
- Any `approval:` gate requires `interactive: true` at the workflow level. A fresh
  interactive launch cannot detach; continuation actions on an already-paused run can.
- Composition (`include:`) runs inside the parent's single run/isolation/audit
  trail. Use `workflow:` sub-runs only when a separately governed launch is the
  actual requirement.

## Common mistakes

Read before writing YAML:

- **Prose between nodes as a wire format.** Emitting a token so the next node can
  grep it. Fix: structured output + typed reads, or a script exit code.
- **AI doing what code should.** "Check if tests pass" as a prompt. Fix: bash/script
  node owning the exit code.
- **Parsing model prose to decide.** Regex over `$node.output`. Same fix.
- **Hardcoding the project's toolchain** (`tsc`, `pytest`) in default-workflow
  gates. Deterministic checks verify only what Archon owns (git state, artifacts,
  exit codes of agent-discovered commands).
- **Silent fallbacks.** An optional input that degrades quietly instead of failing.
  Fail loud with the missing thing named.
- **Trusting exit codes / run status as verdicts.** A declined task exits 0;
  gate on artifacts existing and validating, and on declared outcome fields.
- **Skipping fixtures.** Unfalsified wiring is unknown wiring. Expected-red paths
  especially: seen red on a clean tree, or they prove nothing.
- **Inline everything.** Long prompts inline in YAML, logic inline in bash.
  Files age better, diff better, and are reusable across nodes.
