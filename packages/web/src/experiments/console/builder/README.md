# Builder (console experiment — data layer)

The **data layer** of the in-console workflow builder. Ported from the standalone
`archon-workflow-studio` as part of the Archon Studio integration
([coleam00/Archon#1863](https://github.com/coleam00/Archon/issues/1863)).

This is **PR-1: data only**. It makes the four node variants the production
builder can't yet represent — `loop`, `approval`, `cancel`, `script` — plus the
three existing kinds (`prompt`, `bash`, `command`) representable and
round-trippable in the console's data layer, with pure-function validation and
typed fixtures.

**Out of scope here (later PRs):**

- **PR-2** — the canvas: components, node editor, palette, preview.
- **PR-3** — skill verbs, `ConsoleApp.tsx` route mount, server-tier validation.

There is **no canvas, no skill wiring, no route mount, and no logging** in PR-1.

## What's here

```text
builder/
├── types/        # BuilderNode / BuilderWorkflow / VariantData / Issue / When AST
│                 #   + wire.ts: the ONLY type-only touch point for @/lib/api.generated
├── variants/     # field partitioning, variant detection, capabilities,
│                 #   per-variant fromDag/toDag/defaults, and the registry
├── validation/   # pure-function rules: when-grammar, graph, structural, content
│                 #   + validate.ts orchestrator (client tiers only)
├── model/        # fromWorkflowDefinition / toWorkflowDefinition (round-trip)
├── fixtures/     # typed wire-definition fixtures, authored already-sparse
└── *.test.ts     # bun:test units for detection, round-trip, and every rule
```

## House rules (inherited from the console spike)

- **Isolation guard.** No imports from `@/components`, `@/contexts`, `@/hooks`,
  `@/routes`, `@/stores`, no named `@/lib/api`, no `@tanstack/react-query`. The
  one allowed coupling to generated wire shapes is **type-only**
  `@/lib/api.generated`, funneled through `types/wire.ts`.
- **No logging.** No `console.*`, no logger module. Errors surface via return
  values (`ParseResult`, `Issue[]`) — never thrown to the console, never
  swallowed.
- **Pure TypeScript, no new deps.** No `zod`, no `yaml`. Wire shapes come
  type-only from the generated spec; validation is hand-rolled pure functions;
  fixtures are typed TS object literals. Parity with the engine schema is
  guaranteed by the round-trip tests, not by a duplicated runtime schema.

## Layered dependency direction

```text
types/        ← variants/ , validation/when-grammar
              ← validation/* , model/
              ← fixtures/ , *.test.ts
```

Lower layers never import upper layers, and nothing here imports anything that
will live in PR-2/PR-3. Each module compiles in isolation — reviewable by
construction.

## Round-trip contract

`toWorkflowDefinition(fromWorkflowDefinition(fixture))` deep-equals `fixture` for
every fixture. The engine's Zod transform emits **sparse** nodes (undefined
optionals omitted, empty `depends_on` dropped); the exporter matches this, and
fixtures are authored already-sparse so the round-trip is exact. Note
`loop.fresh_context` is always present (engine default `false`, generated type
required) and is preserved verbatim.

## Known limitations (deferred)

`timeout` is variant-specific (bash/script), not a base field, even though the
flattened generated `DagNode` carries it top-level: the engine's transform emits
`timeout` only on bash and script nodes, so a `timeout` on any other variant is
not engine-producible wire input and is dropped (with an import warning) rather
than carried. The earlier generated-type drift (`persist_session`, `output_type`,
workflow-level `persist_sessions`/`requires` missing from the spec) was resolved
by regenerating `api.generated.d.ts`; those fields now round-trip verbatim.
