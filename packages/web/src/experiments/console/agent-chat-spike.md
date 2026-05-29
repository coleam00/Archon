# Agent Chat (console) — design & spike map

> Status: **exploration / mapping only — not building yet.** This is the durable
> output of a reuse-and-architecture investigation into adding a project-scoped
> AI "agent chat" to the console, as a tab swap alongside the Run view.
>
> Scope decisions locked during exploration:
>
> - **Map it, don't build.** This doc is the artifact; no chat code is written yet.
> - **Project memory deferred** — chat first, cross-conversation memory later.
> - **Run-management tool** — one general `manage_run` tool (progressive
>   disclosure + subtools), built once behind a provider-neutral spec with two
>   registration backends: MCP (Claude/Codex/OpenCode) + Pi `customTools` (Pi).
>   No single mechanism spans all providers; Pi is the ~June-2026 primary and has
>   no MCP. See §6.
> - **Project-scoped chat**, tab swap with the Run view under each project.

## 1. Hypothesis

A user will lean on an agent to **run, track, and manage workflow runs**. Giving
that agent a view with project context (and, later, project memory — what's been
done before in this project's Archon chats) should cut the time and cognitive
load of operating workflows. The chat is the operator's console; the agent is the
operator's assistant.

## 2. The finding that shapes everything

The plumbing exists; the **agent-to-runs connective tissue does not**.

- Every run-lifecycle REST endpoint exists, and the console `skills/` layer
  already wraps all of them: `listRuns`, `getRun`, `startRun`, `cancelRun`,
  `approveRun`, `rejectRun`, `resumeRun`, `abandonRun`, `listMessages`
  (`skills/runs.ts`, `skills/startRun.ts`, `skills/messages.ts`).
- The skill barrel comment already frames these as _"the same verbs … a future
  LLM driver … call"_ (`skills/index.ts:1-8`).
- **But the LLM has no way to call them.** Today the orchestrator AI has exactly
  two levers:
  1. Emit a `/invoke-workflow …` text protocol on its last line, parsed out of
     its output (`orchestrator-agent.ts:202-270`).
  2. Natural-language approval — if a run is `paused`, any plain message is taken
     as the approval answer (`orchestrator-agent.ts:684-796`).
     There is **no tool / function-calling surface** for start/cancel/approve/
     reject/resume/abandon. Run management is otherwise user-typed slash commands
     (`command-handler.ts:545-888`) or direct REST.

So the gap is not capability — it's wiring native tools between the model and the
core operations that already implement these verbs.

## 3. The old chat is over-engineered for this (confirmed)

`ChatInterface.tsx` is **746 lines**: REST hydration, SSE wiring, a six-rule
client-side text-segmentation state machine (`chat-message-reducer.ts`),
tool-call matching, lock-release recovery, "stuck placeholder" re-fetch,
navigate-and-remount conversation creation, a Zustand workflow store, and a
terminal-transition safety timer. Plus a resizable sidebar, project selector, and
a polling conversation list.

**The console model deletes most of that.** The console treats SSE as
_"invalidate → refetch authoritative state,"_ not _"merge streamed deltas."_
`RunDetailPage` already renders message history this way. A console chat collapses to:

```
useEntity(K.messages(convId), () => listMessages(convId))   // history
useConversationSSE(convId) → invalidate(K.messages(convId)) // liveness
<MessageInput onSend={sendMessage} />                        // input
```

The entire streaming state machine becomes unnecessary. The console's
architecture is a _better_ fit than the thing it replaces — that's the headline
reuse win.

## 4. Reuse map

| Need                              | Verdict                                  | Source                                                                                                                                  |
| --------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Message data model + normalizer   | **Reuse as-is**                          | console `primitives/message.ts`, `toMessage`                                                                                            |
| Fetch history                     | **Reuse as-is**                          | console `skills/messages.ts` `listMessages`                                                                                             |
| Render message / tool call / card | **Reuse as-is**                          | console `MessageItem`, `ToolCallItem`, `StreamCard` + `StreamContextProvider`                                                           |
| Live updates                      | **Reuse + tiny tweak**                   | console `useRunStreamSSE` guards on `runId !== null` (`lib/sse.ts:88-90`); add a `useConversationSSE` sibling that drops the run branch |
| Cache/store                       | **Reuse as-is**                          | console `useEntity`; `K.messages` already exists (`store/keys.ts:17`)                                                                   |
| Message input (attach/paste/drag) | **Copy** (ESLint forbids importing prod) | old `MessageInput.tsx` — non-trivial, correct                                                                                           |
| Auto-scroll                       | **Copy**                                 | old `useAutoScroll.ts` — zero deps                                                                                                      |
| Artifact viewer                   | **Reuse, light decouple**                | console `ArtifactPanel` (deps: `useEntity` + 2 skills) or self-contained old `ArtifactViewerModal`                                      |
| Workflow validate/save (backend)  | **Reuse**                                | `POST /api/workflows/validate`, `PUT /api/workflows/:name` (both run `parseWorkflow` first)                                             |
| **Skip**                          | —                                        | `ChatInterface` monolith, `ChatPage` sidebar, `workflow-store` Zustand, `WorkflowBuilder` (heavy ReactFlow), the 6-rule reducer         |

ESLint isolation (`eslint.config.mjs:114-154`) forbids importing `@/components`,
`@/contexts`, `@/hooks`, `@/routes`, `@/stores`, `@/lib/api` (runtime), and
`@tanstack/react-query` inside the console. "Copy" entries above must be copied,
not imported. Type-only `@/lib/api.generated` is allowed.

## 5. Step 1 — project-scoped chat view

### 5.1 Routing / tab

Add a Runs|Chat tab in `RunsPage`'s header (`RunsPage.tsx:425-465`) and a route
in `ConsoleApp.tsx:92-97`:

```
<Route path="p/:projectId/chat" element={<ChatPage />} />
```

A separate route matches the console's URL-driven navigation (the `r/:runId`
precedent). The tab is a peer view, not a drill-down.

### 5.2 New skills — `skills/conversations.ts`

Three verbs, all backed by endpoints that already exist:

- `createConversation(projectId)` → `POST /api/conversations` `{ codebaseId }`
  (currently inlined in `startRun.ts`).
- `listConversations(projectId)` → `GET /api/conversations?codebaseId=` (`api.ts:1245`).
- `sendMessage(convPlatformId, text, files?)` → `POST /api/conversations/:id/message`
  (`api.ts:1410`; multipart-or-JSON, mirror `startRun.ts:51-74`).

`listMessages` already exists and needs no change. Export the new verbs from
`skills/index.ts`.

### 5.3 The conversation tension

The console deliberately hides "conversation" everywhere except `startRun.ts`
(_"The word 'conversation' appears nowhere in the console outside this file."_).
A chat makes the conversation the **primary** entity, inverting the current
model where it's a run-launch side effect. That encapsulation was right then; a
chat is exactly the surface that makes conversations first-class. Adding
`skills/conversations.ts` is the intended evolution, not a violation — ESLint
only blocks production-UI imports, not new console-internal skills.

### 5.4 SSE

`useRunStreamSSE` (`lib/sse.ts:88`) already invalidates `K.messages` on
`text`/`tool_call`/`tool_result` but guards on `runId !== null`. Add a sibling
`useConversationSSE(convPlatformId)` that handles only message events (no run
branch). `useDashboardSSE` is unaffected.

### 5.5 Data flow

```
ChatPage mounts
  → ensure conversation (create lazily on first send, or pick most-recent)
  → useEntity(K.messages(convId), () => listMessages(convId))
  → useConversationSSE(convId)            // invalidates K.messages on text/tool events
  → user sends → sendMessage(convId, text)
  → SSE text/tool events → invalidate(K.messages(convId)) → refetch → re-render
```

## 6. Run-management tooling (the agent's lever)

This is the new capability that makes "agent manages runs" real. Goal: a
**single general tool** (`manage_run`) with **progressive disclosure** and
**subtools**. Decision (speed-first): **lean on an MCP layer** — it is the widest
common denominator across Archon's providers, and most of the plumbing already
exists. The `mcp__` wire-name is treated as a cosmetic implementation detail.

### 6.1 Cross-provider reality — there is no single mechanism

Reading the installed SDK type declarations shows the four providers split two
ways. **No mechanism covers all four:**

| Provider     | In-process custom tool (TS handler)                                                                                                        | External/served MCP                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| **Claude**   | ✅ `createSdkMcpServer()` + `tool()` — in-process, Zod schema, `mcp__<server>__<tool>` namespacing (`sdk.d.ts:428`, `:5632`)               | ✅ stdio / SSE / HTTP / in-process                                                        |
| **Codex**    | ❌ no custom-tool API exists at all (`@openai/codex-sdk` exposes only `config`, `outputSchema`)                                            | ✅ via `config.mcp_servers` (`buildCodexMcpConfigOverrides`, `codex/provider.ts:183-205`) |
| **Pi**       | ✅ `customTools: ToolDefinition[]` — true in-process handler, **TypeBox** schema (`pi-coding-agent .../sdk.d.ts:46`, `types.d.ts:328-359`) | ❌ `mcp: false` capability                                                                |
| **OpenCode** | ❌ loop runs out-of-process; prompt `tools` is just a `{name: boolean}` permission map (`types.gen.d.ts:2339`)                             | ✅ via `mcp.*` client methods                                                             |

- **MCP** covers Claude + Codex + OpenCode with one implementation. Pi is the
  lone holdout (does in-process tools, not MCP).
- **In-process custom tools** cover Claude + Pi only. Codex and OpenCode have no
  in-process handler path whatsoever (their loops are subprocess/out-of-process).
- A genuinely non-`mcp__`-named path would mean _not_ riding the SDK loop —
  running an Archon-owned tool loop against the raw API. Bigger divergence,
  rejected for speed.

> **Pi context:** Pi is slated to become Archon's **main runner ~June 2026**.
> Pi does **not** support MCP — it uses in-process `customTools`. So an MCP-only
> design would leave the future primary provider unable to call the tool. This
> rules out "MCP everywhere" and forces a provider-neutral tool spec with two
> registration backends.

**Conclusion:** build the handler **once** behind a provider-neutral tool spec
(`{ name, description, paramsSchema, handler }`, handler → core ops). Register it
through **two backends**:

- **MCP** for Claude / Codex / OpenCode (the three that support MCP),
- **Pi `customTools`** for Pi (in-process `ToolDefinition`, TypeBox schema).

The two in-process providers (Claude via `createSdkMcpServer`, Pi via
`customTools`) run the handler in the Archon process directly; Codex/OpenCode
reach the same handler over served MCP. No new capability flag needed — reuse
`mcp` (claude/codex/opencode) and gate Pi on its `toolRestrictions`/customTools
path.

**Schema source of truth.** Claude `tool()` wants a **Zod** raw shape; Pi wants
**TypeBox**; served MCP uses **JSON Schema** on the wire. Pick one canonical form
(JSON Schema is the natural pivot — MCP-native, and both Zod and TypeBox convert
to/from it) and adapt per backend; the handler receives validated params as a
plain object regardless. This conversion is the main net-new plumbing — see
decision #5.

### 6.1a Rollout — in-process providers first (Claude + Pi)

Implement `manage_run`'s handler **once**, calling Archon's existing
run-lifecycle endpoints / `operations/workflow-operations`. Then wire providers,
**leading with the two that matter near-term and share the in-process model:**

1. **Wave 1 — Claude + Pi (in-process handlers).** These are current-primary
   (Claude) and future-primary (Pi, ~June 2026), and both run the handler in the
   Archon process — no transport.
   - Claude: `createSdkMcpServer()` + `tool()` (Zod shape); Archon already
     auto-allows `mcp__<server>__*` (`claude/provider.ts:322-323`). Net-new: the
     first `createSdkMcpServer`/`tool()` call in the codebase.
   - Pi: register as `customTools: [ToolDefinition]` (TypeBox schema), parallel to
     `resolvePiTools` (`community/pi/options-translator.ts:187-245`).
     Building both together proves the provider-neutral spec + the two schema
     adapters up front, so the future-primary runner is never a bolt-on.
2. **Wave 2 — Codex + OpenCode (served MCP).** Point their existing MCP config
   paths at the served endpoint (Codex `mcp_servers` config — likely a stdio
   launcher; OpenCode `mcp.*`). Same handler, reuses existing translation.

**Progressive disclosure:** Claude gets SDK-level tool search for free (use
`alwaysLoad: true` on Haiku, which lacks it — `claude/provider.ts:333-341`); Pi
exposes `setActiveTools()` for runtime activation. The app-level
single-tool-with-`action` shape (§6.2) gives progressive disclosure regardless of
provider, so we don't depend on the platform feature.

### 6.2 Shape: one tool, subtools, progressive disclosure

Expose **one** tool to the model — e.g. `manage_run` — keeping the model's tool
list tiny. It carries an `action` discriminator and reveals deeper parameter
schemas on demand:

- First level: `action` enum + minimal params. A `help`/`describe` action
  returns the parameter schema for a named subtool (disclosed on demand), so the
  model learns `approve`'s args only when it needs them, then calls again with
  full params. Same two-step pattern this harness uses for deferred tools.
- Keeps context/token footprint small and avoids overwhelming the model with one
  flat tool per verb.

### 6.3 Subtool catalog → core operations

Each subtool maps 1:1 to a core operation the REST layer already calls. The
**server-side** tool calls core ops directly (not the browser `skills/`, which
are HTTP wrappers); the verb set is the same, the implementation differs.

| Subtool          | Kind  | Core op (server)                                   |
| ---------------- | ----- | -------------------------------------------------- |
| `list`           | read  | `getWorkflowStatus()` / dashboard runs query       |
| `get` / `status` | read  | run detail + events                                |
| `start`          | write | `dispatchOrchestratorWorkflow` (`orchestrator.ts`) |
| `cancel`         | write | `cancelWorkflowRun`                                |
| `approve`        | write | `approveWorkflow(runId, comment)`                  |
| `reject`         | write | `rejectWorkflow(runId, reason)`                    |
| `resume`         | write | `resumeWorkflow(runId)`                            |
| `abandon`        | write | `abandonWorkflow(runId)`                           |

(`operations/workflow-operations` is the shared home for most of these.)

### 6.4 Read/write split & safety

- **Reads** (`list`/`get`) are safe — natural first slice; lets the agent answer
  "what's running?" / "did the review pass?" with zero mutation risk.
- **Writes** are mutations. Approval/reject already have a deliberate two-step
  human flow in the UI; an agent-initiated approve should be explicit and
  surfaced (and respects the project's "no autonomous lifecycle mutation" rule
  for non-terminal state owned by another party — see CLAUDE.md). Decide whether
  agent writes require user confirmation in-chat.

### 6.5 Provider applicability

**Wave 1: Claude + Pi** (in-process handlers — current and ~June-2026 primary),
**Wave 2: Codex + OpenCode** (served MCP). See §6.1 for the mechanism matrix and
§6.1a for the rollout. The handler is shared; per-provider work is only schema
translation (Zod for Claude, TypeBox for Pi, JSON Schema on the wire for served
MCP) + the registration call.

### 6.6 Project-context awareness (cheap win, not memory)

The orchestrator prompt lists registered projects and workflows but **not the
project's currently running/paused runs** (`prompt-builder.ts`). Injecting a
small "active runs in this project" snapshot into the chat's system append would
let the agent reason about live state without any tool call. This is _context
injection_, distinct from the deferred cross-conversation memory.

## 7. Step 2 — artifact viewer + agent authors YAML

### 7.1 Artifact viewer

- console `ArtifactPanel` (`components/ArtifactPanel.tsx`) is a full file browser;
  its only coupling is `useEntity` + `skill.listRunArtifacts`/`fetchArtifact`.
  Reusable inside chat with light decoupling (accept `files`/`fetchContent` as
  props, or keep the console cache).
- Self-contained alternative: old `ArtifactViewerModal.tsx` fetches its own
  content (`GET /api/artifacts/:runId/*`), zero console-cache dependency — good
  for an inline "open artifact" link in an agent message.
- Backend: `GET /api/runs/:runId/artifacts` (file-system walk) and
  `GET /api/artifacts/:runId/*` (`text/markdown`|`text/plain`). Artifacts live at
  `~/.archon/workspaces/{owner}/{repo}/artifacts/runs/{runId}/`
  (`getRunArtifactsPath`).

### 7.2 Agent writes/saves workflow YAML

Building blocks exist:

- `POST /api/workflows/validate` — `{ definition: object }` → `{ valid, errors? }`,
  no file written, runs `parseWorkflow` (`api.ts:2434-2458`).
- `PUT /api/workflows/:name?cwd=` — validates then writes
  `{cwd}/.archon/workflows/{name}.yaml` (`api.ts:2566-2630`).

This fits the **same MCP tool pattern** — a second tool (or subtools under a
shared authoring tool): `draft` → `validate` → `save`. Gaps to close:

1. **YAML-text vs JS object.** Both endpoints take a parsed JS object and
   internally `Bun.YAML.stringify` → `parseWorkflow`. An agent naturally emits
   YAML _text_; there's no endpoint that accepts a YAML string. Either add one,
   or have the tool parse YAML→object server-side before calling the core
   `parseWorkflow`.
2. **No Level-3 validation in the endpoint.** `validate` runs parse+schema only;
   it does **not** call `validateWorkflowResources` (`validator.ts`), so a
   workflow referencing a missing command/skill validates "ok" and fails at
   runtime. An authoring tool should run L3 too.
3. **`serializeToYaml` is incomplete** — the display serializer
   (`YamlCodeView.tsx:148-177`) omits `loop`/`approval`/`cancel`/`script` node
   specifics. Fine for save (goes through `Bun.YAML.stringify`), but a preview
   built on it would silently drop fields.
4. **`cwd` resolution** — save needs the project's `default_cwd`; wire it from the
   chat's project scope.

## 8. Deferred — project memory

**Does not exist today.** Only the _current_ conversation's last 3
workflow-result messages are injected (`prompt-builder.ts:52-66`). There is no
cross-conversation query and no summarization/embedding. "What's been done before
in this project" would need:

- a new query across the project's conversations
  (`SELECT … WHERE conversation_id IN (SELECT id FROM conversations WHERE codebase_id = $1)`),
- a summarization/context-injection step (and probably retrieval, not raw dump).

Explicitly out of scope for step 1.

## 9. Skip list (do not port)

`ChatInterface` (monolith), `ChatPage` sidebar, `workflow-store` (Zustand) and
its SSE handler wiring, `WorkflowBuilder` (ReactFlow), `WorkflowProgressCard` /
`WorkflowResultCard` (Zustand + RQ coupled), the 6-rule `chat-message-reducer`
(the invalidate-refetch model makes it moot), `ProjectContext` (chat is already
project-scoped), `Header` (console has its own).

## 10. Open decisions (pending, before any build)

1. ~~In-process SDK tool vs. Archon-owned loop~~ → **resolved: provider-neutral
   tool spec, two registration backends — in-process for Claude
   (`createSdkMcpServer`) + Pi (`customTools`) in Wave 1, served MCP for
   Codex/OpenCode in Wave 2** (§6.1/§6.1a). Pi is _not_ deferred — it's the
   ~June-2026 primary runner and has no MCP, so its in-process path is first-class.
   `mcp__` prefix accepted as cosmetic for the MCP backends.
2. ~~Do agent **write** actions require in-chat confirmation?~~ → **resolved:
   TIERED.** Reads + low-risk recoverable writes (`start`, `resume`) execute
   directly; destructive / human-gate writes (`cancel`, `abandon`, `approve`,
   `reject`) emit a confirm card and block until the user clicks. `approve`/
   `reject` always confirm (a human gate stays human). Matches CLAUDE.md's
   "no autonomous lifecycle mutation" rule. Cost: the tool emits a confirm card,
   blocks, resumes on click — extra plumbing on the destructive path only.
3. Conversation lifecycle in the chat tab: one persistent conversation per
   project, or a list of past conversations with a "new chat"? (MVP chat view:
   single most-recent web conversation per project, created lazily on first send
   — see `console-agent-chat.plan.md`. Multi-conversation sidebar deferred.)
4. Where the manage-run tool dispatches — confirm `operations/workflow-operations`
   is the single shared home and the tool handlers call it directly (in-process
   for Claude; the served-MCP variant for Codex/OpenCode runs in the Archon
   server process and calls the same ops / existing REST endpoints).
5. ~~Canonical params-schema form + adapters.~~ → **resolved: JSON Schema is
   canonical + hand-written Zod for Claude.** Pi (TypeBox ≈ JSON Schema) and
   served MCP consume the JSON Schema near-directly; Claude's `tool()` gets a
   small hand-written matching Zod raw shape (the schema is tiny — `action` enum
   - ~5 optional strings — so NO conversion library). The handler re-validates,
     so the Claude hand-mirror carries no safety risk. Add a parity test if desired.
6. ~~Served-MCP transport for Codex/OpenCode.~~ → **deferred to Wave 2 (not a
   Wave-1 blocker).** Wave 1 (Claude + Pi) is in-process — no transport. Decide
   at Wave 2 after verifying whether Codex's CLI supports streamable-HTTP MCP:
   if yes → HTTP/SSE endpoint (in-process handler, cleanest); if no → stdio shim
   over the existing REST endpoints (matches Codex's native `mcp_servers` shape).
7. Add a YAML-string ingestion path + wire L3 validation for the authoring tool.

## 11. Spike plan (when greenlit)

Ordered slices, smallest dogfoodable first:

1. **Read-only chat** — `skills/conversations.ts`, `useConversationSSE`, ChatPage
   - tab, reusing `MessageItem`/`ToolCallItem`/`StreamCard`. Plain AI chat, no
     tools. Proves the assembly + the invalidate-refetch model.
2. **Active-runs context injection** — snapshot the project's running/paused runs
   into the chat system append. Agent can _talk about_ runs. No mutation.
3. **`manage_run` read tool — provider-neutral spec, Wave 1 (Claude + Pi).**
   Single tool, `list`/`get` subtools, progressive disclosure. One shared handler
   → `operations/workflow-operations`; register via `createSdkMcpServer` (Claude)
   and `customTools` (Pi), with the schema adapters from decision #5. Dogfoods the
   whole loop on both the current and future-primary runners at once.
4. **Write subtools** — start, then approve/reject/resume/cancel/abandon, with
   the confirmation policy from decision #2. Same Wave-1 providers.
   4b. **Wave 2 cross-provider wiring** — serve the same tool over MCP for Codex +
   OpenCode (reuse existing MCP config translation). Parallelizable with slice 5.
5. **Artifacts in chat** — inline artifact open via `ArtifactViewerModal` or a
   decoupled `ArtifactPanel`.
6. **Authoring tool** — `draft`/`validate`/`save` subtools, after closing the
   YAML-string + L3 gaps.
7. (later) **Project memory** — cross-conversation retrieval + summarization.

## Key references

- Orchestrator routing / `/invoke-workflow` / NL approval — `packages/core/src/orchestrator/orchestrator-agent.ts:202-270`, `:638-1036`, `:684-796`
- Command handler (slash run mgmt) — `packages/core/src/handlers/command-handler.ts:545-888`
- Provider contract — `packages/providers/src/types.ts` (IAgentProvider `:376`, SendQueryOptions `:311`, NodeConfig `:260`, ProviderCapabilities `:322`)
- Provider tool translation — `packages/providers/src/claude/provider.ts:274-389`; Codex `codex/provider.ts:183-205`; Pi `community/pi/options-translator.ts:187-245`
- SDK custom-tool surfaces — Claude `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:428,:5632`; Codex (none) `@openai/codex-sdk/dist/index.d.ts`; Pi `@earendil-works/pi-coding-agent/dist/core/sdk.d.ts:46` + `types.d.ts:328`; OpenCode (none, permission map) `@opencode-ai/sdk .../types.gen.d.ts:2339`
- Console skills — `packages/web/src/experiments/console/skills/{runs,startRun,messages,index}.ts`
- Console SSE — `packages/web/src/experiments/console/lib/sse.ts`
- Console message primitive + render — `primitives/message.ts`, `components/{MessageItem,ToolCallItem,StreamCard}.tsx`
- Artifacts — `api.ts:2768-2964`, `getRunArtifactsPath` (`packages/paths/src/archon-paths.ts:366-368`), console `ArtifactPanel.tsx`
- Workflow validate/save — `api.ts:2434-2458`, `:2566-2630`; `parseWorkflow` (`packages/workflows/src/loader.ts:188-468`); `validator.ts`
- Isolation rules — `eslint.config.mjs:114-154`
