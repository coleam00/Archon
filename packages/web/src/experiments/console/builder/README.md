# Builder (console experiment — data layer + visual editor)

The in-console workflow builder. Ported from the standalone
`archon-workflow-studio` as part of the Archon Studio integration
([coleam00/Archon#1863](https://github.com/coleam00/Archon/issues/1863)).

- **PR-1 (merged): the data layer.** The four node variants the production
  builder can't represent — `loop`, `approval`, `cancel`, `script` — plus the
  three existing kinds (`prompt`, `bash`, `command`), round-trippable with
  pure-function validation and typed fixtures.
- **PR-2 (this layer): the visual editor.** React-Flow canvas, custom node
  rendering, palette, inspector (with `when:` builder), validation panel,
  read-only syntax-highlighted YAML preview (reusing the console's existing
  `react-markdown` + `rehype-highlight` stack — no new highlighting dep), and
  editor polish (undo/redo, multi-select,
  copy/paste, align/distribute, auto-arrange, smart guides, grid snap, keymap
  help). Rendered as a **controlled component** (`BuilderPage`) driven by an
  in-memory `BuilderWorkflow`, plus a **fixture-backed** `/console/builder`
  route (sidebar "Workflow Builder" entry with a Beta pill) and a section on
  `/console/_preview`.
- **PR-3 (next): connected mode.** `loadWorkflow`/`saveWorkflow` skill verbs,
  the `:name` route param, cache wiring, server-tier validation.

**Nothing in PR-2 performs server I/O.** `BuilderPage` takes
`initialWorkflow: BuilderWorkflow` as a prop and reports edits via `onChange`;
the route seeds it from PR-1 fixtures only. That seam is exactly what PR-3
wraps — reviewable and revertable by construction.

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
├── flow/         # PR-2: BuilderWorkflow ↔ xyflow bridge + local dagre layout
│                 #   (positions are UI-only state; never serialized to the wire)
├── yaml/         # PR-2: hand-rolled serializeToYaml (pure, DOM-free, golden-tested)
├── editor/       # PR-2: pure editor kernels — history (undo/redo, ~400ms coalesce),
│                 #   clipboard envelope, align/distribute, smart-guide snap math,
│                 #   reducer (state.ts), keymap bindings (console useKeymap)
├── components/   # PR-2: canvas, node view, palette, inspector (+ per-variant
│                 #   sub-forms), WhenBuilder, IssueList, YamlPreview, Toolbar
├── BuilderPage.tsx   # PR-2: the controlled assembly (the PR-3 seam)
├── BuilderRoute.tsx  # PR-2: fixture-backed /console/builder route
└── **/*.test.ts  # bun:test units (pure logic only — no DOM, no mock.module)
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
PR-1:  types/  variants/  validation/  model/  fixtures/
          ↑        ↑           ↑          ↑        ↑
PR-2:  flow/  yaml/  editor/        (pure: PR-1 + xyflow/dagre only)
          ↑
       components/                  (React: flow/yaml/editor + PR-1)
          ↑
       BuilderPage.tsx              (controlled assembly; initialWorkflow prop)
          ↑
       BuilderRoute.tsx · routes/PreviewPage.tsx   (fixture-backed surfaces)
```

Lower layers never import upper layers, and nothing here imports skill verbs
or `store/cache.ts` — that wiring is PR-3. Each module compiles in isolation —
reviewable by construction.

## PR-2 specifics

- **Test approach: pure logic only.** The web package has no DOM test env and
  that stays true — flow mapping, YAML serialization, history coalescing,
  clipboard remapping, alignment kernels, and smart-guide snap math are all
  pure functions under `bun:test`. The visual surface is verified via
  `/console/_preview` (fixture switcher) plus PR screenshots. No `mock.module`,
  no happy-dom, no `@testing-library/*`, no web-local `bunfig.toml`.
- **Node color tokens.** PR-2 adds two console-scoped tokens in `theme.css` —
  `--node-script` and `--node-cancel` — completing the seven variant stripes
  (the other five inherit from the production `:root` in `index.css`). Per the
  brand foundation rule, any future promotion of these to the production
  palette must update both the token source and the brand guide.
- **Keymap.** Bindings reuse the console `lib/keymap.ts` (modifier-free,
  vim-flavored): `u`/`U` undo/redo, `y`/`x`/`P` copy/cut/paste, `a` select
  all, `A` auto-arrange, `f` fit view, `g`-chords for align/distribute.
  `p`, `?`, and `,` stay owned by the ConsoleApp-level keymap.
- **Positions are UI-only.** The wire `DagNode` has no position field; canvas
  positions live in editor state and are stripped by `flowToBuilder`, keeping
  PR-1's round-trip byte-identical.

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
