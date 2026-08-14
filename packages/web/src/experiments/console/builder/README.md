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
- **PR-5 (shipped): Builder Copilot.** An AI chat panel beside the canvas that
  proposes batches of edits (add/connect/set-field/rename/remove) previewed as
  ghost nodes before the author Accepts or Rejects. See **PR-5 specifics** below.

`BuilderPage` stays a **controlled component**: it takes
`initialWorkflow: BuilderWorkflow` as a prop and reports edits via `onChange`.
PR-3's only additive change to it is an optional `extraIssues?: Issue[]` prop
(import + server issues merged into the panel). PR-5 adds two more additive
props in the same spirit: `preview?` (a Builder Copilot Proposal's ghost
overlay) and `applyBatch?` (Accept's one-undo-step batch trigger) — see
**PR-5 specifics** below. All server I/O, dirty/nav logic, and CRUD live in
`BuilderConnected` + `connect/*`.

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
├── BuilderPage.tsx       # PR-2: the controlled assembly (+ PR-3 extraIssues,
│                         #   PR-5 preview/applyBatch props)
├── BuilderConnected.tsx  # PR-3: connected /console/builder[/:name] route
│                         #   (PR-5: also mounts CopilotPanel + owns its state)
├── connect/              # PR-3: pure save/rename/issue logic + selected-project hook
├── copilot/      # PR-5: op-schema, translate-ops, preview-diff (pure + tested),
│                 #   use-copilot hook, CopilotPanel + ProposalPreview (React)
├── docs/adr/     # Architecture decisions that break M1's "pure-web" stance
│                 #   (ADR-0001 marketplace submission, ADR-0002 builder copilot)
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

## PR-5 specifics (Builder Copilot)

- **Reuses the console chat — no dedicated endpoint.** The Copilot is a DB-backed
  conversation (`skill.createConversation`/`sendMessage`/`listMessages`) rendered
  with the same `ChatStream`/`ChatComposer` the project chat uses. See
  `docs/adr/0002-builder-copilot-reuses-chat-via-native-tool.md` for why.
- **Builder-mode signal is a per-message request flag**, not a conversation
  column: `sendMessage`'s optional 4th arg (`{ builderMode: true, canvasState }`)
  rides the existing `POST /api/conversations/:id/message` JSON body. The
  orchestrator (`@archon/core`) gates the `propose_workflow_edits` native tool on
  this flag — ordinary project chats, Slack, Telegram, GitHub, and CLI never see
  it. `canvasState` is the live (possibly unsaved) `BuilderWorkflow`,
  JSON-serialized fresh every turn.
- **Claude/Pi-only.** The tool is a native in-process tool call, which only
  Claude and Pi's harnesses support (`ProviderCapabilities.nativeTools`). On
  Codex/OpenCode/Copilot the panel shows a "needs Claude or Pi" note (from
  `GET /api/providers` + `GET /api/config`'s default assistant) — chat still
  works, canvas-driving doesn't.
- **Tool-call delivery is post-turn, not mid-stream.** The console's SSE
  consumers are deliberately signal-only (`lib/sse.ts`): they invalidate the
  message cache and nothing reads `input` off the raw SSE event. The pending
  Proposal is read off the latest assistant message's `toolCalls` array once it
  lands via the normal `GET /.../messages` refetch — same pattern `ChatPage`
  already uses for tool-call rendering.
- **Ops → `EditorAction`s is a pure, fully-tested pipeline**: `op-schema.ts`
  (parse + validate the agent's `ops` JSON — the same shape `@archon/core`'s
  `propose-workflow-edits-tool.ts` hand-duplicates on the server side, since a
  web package can't be imported there) → `translate-ops.ts` (maps each op onto
  the real `EditorAction` union, surfacing unresolvable ops as `Issue[]`, never
  throwing) → `preview-diff.ts` (folds the batch over a CLONE via `editorReducer`
  itself and diffs against the live workflow for the ghost overlay).
- **`editorReducer` gained two small, additive members** to support this:
  `add-node` now accepts an optional caller-supplied `id` (falls back to the
  usual `variant-N` synthesis when omitted, taken, or invalid — every existing
  caller is unaffected), and a new `batch` action folds a list of sub-actions
  through the reducer but collapses them to ONE history snapshot — Accept
  applies the whole Proposal as a single undo step.
- **Preview overlay is additive on `BuilderPage`**, matching PR-3's
  `extraIssues` discipline: `preview?` carries a union workflow (current +
  proposed, with removed nodes re-included so they render struck through), a
  ghost map (`add`/`changed`/`remove`) threaded through `builderToFlow` →
  `BuilderNodeView` for dashed/translucent/struck styling, and would-be issues.
  `applyBatch?` is a `{ actions, nonce }` pair a `useEffect` dispatches once per
  nonce bump. Neither prop touches `BuilderPage`'s own reducer state directly.
- **Accept is atomic; Reject is a no-op on the canvas.** Accept dispatches the
  batch (one undo step); Reject just clears the panel's pending-Proposal state
  — nothing was ever applied to live editor state, so there's nothing to revert.
- **No persistence of Accept/Reject decisions.** Which tool calls have been
  resolved lives in the panel's own React state, not the DB — reloading mid-turn
  can resurface an already-decided Proposal. Acceptable for v1; a future pass
  could fold this into message metadata if it proves annoying in practice.

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
