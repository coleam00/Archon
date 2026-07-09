# Builder (console experiment — data layer + visual editor)

The in-console workflow builder. Ported from the standalone
`archon-workflow-studio` as part of the Archon Studio integration
([coleam00/Archon#1863](https://github.com/coleam00/Archon/issues/1863)).

- **PR-1 (merged): the data layer.** The four node variants the production
  builder can't represent — `loop`, `approval`, `cancel`, `script` — plus the
  three existing kinds (`prompt`, `bash`, `command`), round-trippable with
  pure-function validation and typed fixtures.
- **PR-2 (merged): the visual editor.** React-Flow canvas, custom node
  rendering, palette, inspector (with `when:` builder), validation panel,
  read-only syntax-highlighted YAML preview (reusing the console's existing
  `react-markdown` + `rehype-highlight` stack — no new highlighting dep), and
  editor polish (undo/redo, multi-select,
  copy/paste, align/distribute, auto-arrange, smart guides, grid snap, keymap
  help). Rendered as a **controlled component** (`BuilderPage`) driven by an
  in-memory `BuilderWorkflow`, plus a **fixture-backed** `/console/builder`
  route (sidebar "Workflow Builder" entry with a Beta pill) and a section on
  `/console/_preview`.
- **PR-3 (shipped): connected mode.** `loadWorkflow`/`saveWorkflow`/
  `deleteWorkflow`/`validateWorkflow` skill verbs, the `:name` route param, a
  project picker (workflows are discovered/saved per-codebase `cwd`), an explicit
  Save flow with a dirty indicator + nav guard, server-tier validation surfaced
  into the issue panel, and full CRUD — with bundled workflows opening read-only
  and saving as a project override. See **PR-3 specifics** below.
- **PR-4 (shipped): Marketplace Submission.** A `Submit` affordance that bundles
  a saved workflow (plus referenced `command:`/`script:` files), commits it to
  the project's own GitHub repo via the Git Data API, runs pre-flight gates
  mirroring marketplace CI, forks `coleam00/Archon`, and opens a PR editing
  `packages/docs-web/src/data/marketplace.ts`. This is a **deliberate,
  ADR-recorded break** from the "pure web / zero backend" rule PR-1–3 held — see
  **PR-4 specifics** below and `docs/adr/0001-marketplace-submission-is-server-assisted.md`.

`BuilderPage` stays a **controlled component**: it takes
`initialWorkflow: BuilderWorkflow` as a prop and reports edits via `onChange`.
PR-3's only additive change to it is an optional `extraIssues?: Issue[]` prop
(import + server issues merged into the panel). All server I/O, dirty/nav logic,
and CRUD live in `BuilderConnected` + `connect/*`.

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
├── BuilderPage.tsx       # PR-2: the controlled assembly (+ PR-3 extraIssues prop)
├── BuilderConnected.tsx  # PR-3: connected /console/builder[/:name] route
│                         #   (+ PR-4: mounts the Submit affordance + modal)
├── connect/              # PR-3: pure save/rename/issue logic + selected-project hook
├── marketplace/          # PR-4: SubmitModal.tsx (self-attestation checklist + result)
├── docs/adr/             # Architecture decisions (ADR-0001: server-assisted Submit)
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
       BuilderConnected.tsx         (PR-3: skills + store/cache + react-router)
       routes/PreviewPage.tsx       (fixture-backed visual surface)
```

PR-1/PR-2 layers never import skill verbs or `store/cache.ts` — only
`BuilderConnected.tsx` + `connect/*` (the PR-3 wiring) do. Each module compiles
in isolation — reviewable by construction.

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

## PR-3 specifics (connected mode)

- **Routes.** `/console/builder` (picker + open-a-workflow) and
  `/console/builder/:name` (load + edit), both mounted to `BuilderConnected`.
  The route `:name` is the filename; on every save the in-YAML `name:` is forced
  equal to it, so filename and `name:` stay in sync (one name drives both).
- **Project picker.** Workflows are discovered/saved per-codebase `cwd`, so a
  project must be selected first. Selection persists in
  `archon.console.builderProject` (localStorage, try/catch-guarded) and is
  reflected as a `?project=<id>` search param, so a deep-link reload restores the
  cwd. This is a deliberate divergence from the console's `/p/:projectId`
  path-scoping (used for Runs/Chat) — the builder uses a global route + picker.
- **Save flow.** Explicit Save = client-validate (`runValidation`, blocking
  errors gate the save) → server-validate (`POST /api/workflows/validate`, which
  returns HTTP 200 even when invalid — branch on `valid`) → `PUT`, then invalidate
  the workflow + list caches. A dirty dot shows unsaved edits.
- **Nav guard.** The app is a non-data `<BrowserRouter>`, so `useBlocker` is
  unavailable. The guard is a `beforeunload` listener (reload/tab-close) plus a
  `confirmIfDirty` wrapper around the header's OWN controls (project change,
  open-another, New). **Known limitation:** the browser Back button and
  `ProjectRail` clicks are NOT intercepted; a data-router migration is out of
  scope.
- **Bundled = read-only → Save-as.** `source === 'bundled'` opens read-only; the
  Save button becomes "Save as" and writes a project override (the server also
  400s a bundled delete, so Delete is hidden for bundled).
- **CRUD.** New (seed a minimal single-prompt workflow, then create-on-save),
  Rename (collision-guarded, new-then-old so a failed delete still leaves the new
  file authoritative — surfaced as a non-fatal warning issue), Delete (confirm →
  remove → navigate away).
- **Issues panel.** Client + import + server/save issues all flow through the
  existing `IssueList` via `BuilderPage`'s `extraIssues` prop, deduped by id.
- **Save normalizes YAML key order.** The round-trip is **lossless but not
  byte-identical** for real files — the model emits a normalized key order, so a
  save can produce a slightly larger-than-expected (but correct) git diff. Dirty
  detection is therefore on `BuilderWorkflow` identity from `onChange`, never on a
  serialized-YAML string compare (which would falsely flag every load as dirty).
- **Subdir limitation (known).** `GET /api/workflows/:name` does not recurse into
  `.archon/workflows/<subdir>/`; subfoldered workflows won't load via the
  single-name route and surface a "not found" empty state (offers New).

## PR-4 specifics (Marketplace Submission)

- **New server surface (breaks the "zero backend" rule on purpose).** A `POST
  /api/marketplace/submit` route drives a new
  `packages/server/src/services/marketplace-publish/` service (origin probe,
  bundle assembly, pre-flight gates, registry-entry edit, Octokit
  fork/commit/PR orchestration). The **client** stays inside the console
  isolation contract below — it only ever calls the one skill verb
  (`submitToMarketplace`, `skills/marketplace.ts`) and never talks to GitHub
  directly. See ADR-0001 for the full rationale and the S5 transport amendment
  (Git Data API, not local `git push`).
- **Submit affordance.** A header button next to Save, disabled while the
  workflow is dirty, unsaved (create mode), or a read-only bundled default —
  the server re-reads the workflow file from disk and never trusts a
  client-sent definition, so it must already be on disk as a project file.
- **The self-attestation checklist** (`SubmitModal.tsx`) is the verbatim
  CONTRIBUTING.md checklist; all four items are required client-side AND
  re-enforced server-side (`z.literal(true)` × 4) — the client gate is never
  trusted alone.
- **Credential requirement.** Submit needs a GitHub credential resolvable by
  the server: the caller's connected per-user GitHub identity, or an
  install-level `GITHUB_TOKEN`/`GH_TOKEN`. No credential → a 422 with
  connect-or-configure guidance surfaced verbatim in the modal.
- **Result surface.** Success shows the opened PR URL; failure shows a status-
  mapped message (`httpErrorToMessage` in `skills/marketplace.ts`) — 409 means
  the workflow's slug is already registered by a different GitHub author, 422
  carries the server's actionable block reason verbatim, and a 500 after the
  bundle commit already landed says so explicitly (the project repo write is a
  real, persistent side effect even if the rest of the flow failed).
- **Visible side effect.** A successful Submit commits `.archon/marketplace/<slug>/`
  to the **project's own repo's default branch** — this happens before the PR
  step and is not undone by a later failure.

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
