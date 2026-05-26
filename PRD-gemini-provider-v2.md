# PRD: Gemini Provider v2 — Capability Expansion via Config Staging

> **Companion doc:** [GEMINI_DEMO.md](GEMINI_DEMO.md) (v1 evidence + matrix this PRD extends)

---

## 1. Executive Summary

The Gemini community provider shipped in v1 with a deliberately conservative capability set: 3 of 14 declared capabilities are wired up (`sessionResume`, `toolRestrictions`, `envInjection`). The remaining 11 are documented as `false` and rely on a "warn-and-run" graceful-degradation pattern. Research into the gemini-cli documentation reveals that **most of those gaps are not gemini-cli limitations** — they are integration gaps in Archon's provider layer.

The core architectural insight: **gemini-cli reads `.gemini/settings.json` and `.gemini/agents/*.md` from its working directory at startup, with project-layer config overriding user-layer config**. Since the SDK already forwards `cwd` to the subprocess, Archon can materialize per-invocation config files into the worktree before invoke, and gemini-cli will pick them up natively — without any change to `@lrilai/gemini-cli-sdk`.

**MVP goal:** Resolve 4 high-value capabilities (`mcp`, `agents`, `sandbox`, `fallbackModel`) and add a buffered code path for `structuredOutput`, raising Gemini's wired-up capability count from 3 → 8 while preserving the existing warn-and-run fail-safe for everything else. Worktree-isolated runs (Archon's default, ~90% of usage) ship first; `--no-worktree` collision-safety machinery follows in a second phase.

---

## 2. Mission

Bring the Gemini community provider to functional parity with built-in providers (Claude, Codex) for the workflow-node features that gemini-cli actually supports, without compromising the v1 fail-safe guarantees or requiring upstream SDK changes.

**Core principles:**

1. **No SDK rework.** All capability expansion happens in Archon's provider layer. The SDK remains a thin transport.
2. **Project layer wins.** Use gemini-cli's documented precedence (project `.gemini/settings.json` > user) — never override the user's `~/.gemini/`.
3. **Fail-safe preserved.** Capabilities Archon cannot honor faithfully stay `false` and continue to warn-and-run. We never silently broaden support.
4. **Reversible by default.** Worktree-scoped staging is automatically cleaned up. `--no-worktree` runs use backup-and-restore so a crash never leaves a mangled user file.
5. **Honest capability declarations.** A capability flag flips to `true` only when there is a faithful, tested translation. Partial mappings (e.g. `thinking` → Gemini generation settings) stay declared `false` until a clean design exists.

---

## 3. Target Users

**Primary persona — Archon workflow author using Gemini as the assistant:**

- Authors `.archon/workflows/*.yaml` with `provider: gemini` at workflow or node level
- Wants the same expressive options available for Claude/Codex nodes (MCP servers, sub-agents, sandbox, fallback model, structured output)
- Today: must omit these keys or accept warn-and-run silent ignores
- Pain point: cross-provider workflows lose fidelity when a node switches to Gemini

**Secondary persona — Archon contributor maintaining provider parity:**

- Reads the capability matrix in [GEMINI_DEMO.md](GEMINI_DEMO.md) and the `GEMINI_CAPABILITIES` flags in `packages/providers/src/community/gemini/capabilities.ts`
- Needs the cross-provider story to be coherent so that new workflow features can reason about provider support without per-provider branching
- Pain point: the v1 matrix's 11 `false` flags imply more SDK limitation than actually exists

**Technical comfort:** Both personas are senior developers comfortable with YAML config, git worktrees, and reading provider source code.

---

## 4. MVP Scope

### In Scope (Phase 1 — Worktree-Isolated Runs)

**Capability resolutions:**

- ✅ `mcp: true` — Translate `nodeConfig.mcp` (file path string) → `.gemini/settings.json` `mcpServers` block staged into cwd
- ✅ `agents: true` — Serialize inline `agents:` definitions to `.gemini/agents/<name>.md` with YAML frontmatter; inject `@name` activation hints into prompt
- ✅ `sandbox: true` — Map `nodeConfig.sandbox` → `tools.sandbox` + `security` keys in staged settings.json
- ✅ `fallbackModel: true` — Map `nodeConfig.fallbackModel` → `modelConfigs` alias chain in staged settings.json
- ✅ `structuredOutput: true` — Add buffered code path that calls SDK's existing `queryFull()` for nodes with `output_format` (streaming path unchanged for nodes without it)

**Infrastructure:**

- ✅ `geminiConfigStager` module — Pure functions that build `.gemini/settings.json` and `.gemini/agents/*.md` content from `SendQueryOptions`
- ✅ `withStagedGeminiConfig()` lifecycle helper — Stage before invoke, clean up after, scoped to a single SDK call
- ✅ Worktree-only guard — Phase 1 fails the node loudly with a clear error if any of the new capabilities are requested in a `--no-worktree` run

**Documentation:**

- ✅ Update [GEMINI_DEMO.md](GEMINI_DEMO.md) matrix to reflect new capability set
- ✅ Update `packages/docs-web/src/content/docs/getting-started/ai-assistants.md` capability section
- ✅ Inline comments in `options-translator.ts` explaining the staging vs SDK-arg split

**Testing:**

- ✅ Unit tests for each builder function (pure, no I/O)
- ✅ Integration tests for the lifecycle helper (real `tmp` dirs, real file I/O)
- ✅ One e2e workflow per new capability in `.archon/workflows/test-workflows/`

### In Scope (Phase 2 — `--no-worktree` Collision Safety)

- ✅ Deep-merge logic for existing user `.gemini/settings.json` (additive: union maps, append arrays, never replace whole keys)
- ✅ Backup-and-restore via `try/finally` with `.gemini/settings.json.archon.bak.<runId>` files
- ✅ Crash recovery: on startup, restore the oldest `.archon.bak.*` before proceeding
- ✅ Lockfile `.gemini/.archon.lock` to serialize concurrent Archon runs in the same cwd
- ✅ Sentinel key `_archonGeneratedRunId: <uuid>` in injected blocks for user inspection
- ✅ Remove the Phase 1 worktree-only guard

### Out of Scope (Deferred — v3 or Never)

- ❌ `hooks: true` — gemini-cli hooks are shell commands invoked via stdin/stdout JSON, not in-process JS callbacks like Claude's SDK. Would require a separate `hooks_gemini` schema variant; defer pending design discussion.
- ❌ `skills: true` — gemini-cli has its own Agent Skills system with a different shape from Claude's `SKILL.md` + `AgentDefinition` wrapping. Defer pending schema design.
- ❌ `thinkingControl: true` / `effortControl: true` — Gemini 3 generation settings exist but aren't 1:1 with Claude's `thinking: { type, budget_tokens }` or Codex's `modelReasoningEffort`. Forced mapping would mislead users. Defer.
- ❌ `costControl: true` (`maxBudgetUsd`) — gemini-cli has no per-invocation budget primitive. Account-level `billing` config is a different concept. Will not implement.
- ❌ `denied_tools` support — gemini-cli exposes only `--allowed-tools`, no denylist. Will not implement.
- ❌ SDK feature requests upstream (`mcpServers` arg, `sandbox` arg, `queryFull` re-export) — quality-of-life only; not blocking. Out of scope for this PRD.
- ❌ `GEMINI_CONFIG_DIR` redirect approach — Documented as broken on Windows (Archon's primary dev platform per [GEMINI_DEMO.md](GEMINI_DEMO.md)). Not used.

---

## 5. User Stories

### US-1: MCP Servers on a Gemini Node

**As a** workflow author, **I want to** specify `mcp: ./mcp-config.json` on a `provider: gemini` node, **so that** the Gemini agent can call MCP tools the same way a Claude node can.

**Example:**

```yaml
- id: gemini-research
  provider: gemini
  model: gemini-3-pro
  mcp: ./.archon/mcp/research-servers.json
  prompt: Use the brave-search MCP server to find recent papers on diffusion models.
```

Today this emits a warn-and-run notice and the MCP block is ignored. After MVP: gemini-cli loads the servers from a staged `.gemini/settings.json` and the prompt can invoke them.

### US-2: Inline Sub-Agent on a Gemini Node

**As a** workflow author, **I want to** define an inline sub-agent on a Gemini node, **so that** complex tool-heavy work can be delegated to a scoped helper without polluting the main session.

**Example:**

```yaml
- id: audit
  provider: gemini
  agents:
    - name: security-auditor
      description: Finds SQL injection, XSS, hardcoded credentials.
      tools: [read_file, grep_search]
      prompt: You are a ruthless security auditor...
  prompt: |
    @security-auditor Review packages/server/src/routes/ for vulnerabilities.
```

### US-3: Sandbox-Constrained Gemini Node

**As a** workflow author, **I want to** run a Gemini node in a sandboxed environment, **so that** untrusted tool invocations cannot escape into the host.

**Example:**

```yaml
- id: untrusted-eval
  provider: gemini
  sandbox: docker
  prompt: Run the provided npm package and report what it does on disk.
```

### US-4: Model Fallback for Quota Resilience

**As a** workflow author, **I want to** specify a fallback model on a long-running Gemini node, **so that** the workflow continues to succeed if the primary model hits a quota error.

**Example:**

```yaml
- id: long-analysis
  provider: gemini
  model: gemini-3-pro
  fallbackModel: gemini-3-flash
  prompt: ...
```

### US-5: Structured JSON Output from a Gemini Node

**As a** workflow author, **I want to** request `output_format: { type: json, schema: {...} }` from a Gemini node, **so that** downstream nodes can reliably parse `$nodeId.output` without prompt-engineering for JSON.

**Example:**

```yaml
- id: extract-facts
  provider: gemini
  output_format:
    type: json
    schema:
      type: object
      properties:
        facts: { type: array, items: { type: string } }
  prompt: Extract three facts about graceful degradation as a JSON object.
```

After MVP: the provider routes this node through `queryFull()` and returns a buffered, schema-conformant JSON payload. Streaming nodes (without `output_format`) continue to use `query()` unchanged.

### US-6: Cross-Provider Workflow Without Fidelity Loss

**As a** workflow author, **I want to** mix Claude, Codex, and Gemini nodes in the same workflow with the same expressive option set per node, **so that** the choice of provider doesn't dictate what a node can do.

This is the umbrella story; US-1 through US-5 are concrete instances.

### US-7 (Technical): Provider-Layer Capability Expansion Without SDK Coupling

**As an** Archon contributor, **I want** the capability expansion to live entirely in `packages/providers/src/community/gemini/`, **so that** SDK upstream changes don't block Archon's roadmap and SDK bugs don't regress workflow features.

### US-8 (Technical): Safe Coexistence with User's `.gemini/`

**As an** Archon user running `--no-worktree`, **I want** Archon to never clobber my hand-authored `.gemini/settings.json`, **so that** my personal gemini-cli configuration survives every Archon run, even one that crashes mid-invoke.

---

## 6. Core Architecture & Patterns

### High-Level Approach

Add a **two-layer translation** to the Gemini provider:

1. **Existing layer (unchanged):** `translateOptions()` builds SDK `QueryOptions` for fields the SDK accepts natively (`prompt`, `cwd`, `model`, `systemPrompt`, `allowedTools`, `env`, `session`, etc.).
2. **New layer:** `stageConfigForInvoke()` materializes per-invocation files into the cwd's `.gemini/` directory for fields the SDK doesn't expose but gemini-cli reads from disk.

The new layer is wrapped in a lifecycle helper `withStagedGeminiConfig()` that handles staging-before / cleanup-after with `try/finally` semantics.

### Directory Layout (new + modified)

```
packages/providers/src/community/gemini/
├── capabilities.ts                  # MODIFIED — flip mcp/agents/sandbox/fallbackModel/structuredOutput to true
├── options-translator.ts            # MODIFIED — remove staged-now-supported keys from warnIgnoredOptions()
├── provider.ts                      # MODIFIED — wrap sendQuery body in withStagedGeminiConfig()
├── config-stager/                   # NEW DIRECTORY
│   ├── index.ts                     # Public exports
│   ├── settings-builder.ts          # Pure: SendQueryOptions → SettingsJsonPatch
│   ├── agents-builder.ts            # Pure: nodeConfig.agents → AgentMarkdownFile[]
│   ├── lifecycle.ts                 # withStagedGeminiConfig() — staging/cleanup orchestration
│   ├── merge.ts                     # Phase 2 — deep-merge user's existing settings.json
│   ├── lockfile.ts                  # Phase 2 — .archon.lock acquire/release
│   ├── backup.ts                    # Phase 2 — backup/restore with crash recovery
│   ├── settings-builder.test.ts     # NEW
│   ├── agents-builder.test.ts       # NEW
│   ├── lifecycle.test.ts            # NEW
│   ├── merge.test.ts                # NEW (Phase 2)
│   ├── lockfile.test.ts             # NEW (Phase 2)
│   └── backup.test.ts               # NEW (Phase 2)
└── ... (existing files)

.archon/workflows/test-workflows/    # NEW e2e workflows
├── e2e-gemini-mcp.yaml
├── e2e-gemini-agents.yaml
├── e2e-gemini-sandbox.yaml
├── e2e-gemini-fallback.yaml
└── e2e-gemini-structured-output.yaml
```

### Key Design Patterns

**Single Responsibility:** `settings-builder` and `agents-builder` are pure transforms (no I/O). `lifecycle.ts` orchestrates I/O. Tests for builders can run without temp dirs.

**Fail-Fast (CLAUDE.md):** Phase 1 throws an explicit `GeminiConfigStagingNotSupportedError` when any staged capability is requested in `--no-worktree`. No silent fallback.

**Reversibility:** Phase 1's worktree-scoped staging is implicitly reversible (worktree teardown). Phase 2's backup-and-restore is explicitly reversible (always restore in `finally`).

**Match Existing Patterns:** The Claude provider already reads `mcp:` file paths, parses, expands env vars, and passes to the SDK. The Gemini config-stager is the same pattern with a different output target (filesystem instead of SDK arg).

### Dependency Direction (preserved)

```
@archon/paths ← @archon/git ← @archon/providers (gemini config-stager goes here)
                            ← @archon/workflows (consumes IAgentProvider, unchanged)
```

No new package needed. No changes to interface contracts (`IAgentProvider`, `SendQueryOptions`). The stager is an implementation detail of `GeminiProvider`.

---

## 7. Tools/Features

### Feature 1: Settings.json Stager

**Purpose:** Convert per-invocation Gemini-relevant options into a project-layer `.gemini/settings.json` patch.

**Operations:**

- `buildSettingsPatch(options: SendQueryOptions): SettingsJsonPatch` — pure
- Maps `nodeConfig.mcp` (file path) → reads file → emits `{ mcpServers: {...} }`
- Maps `nodeConfig.sandbox` → `{ tools: { sandbox: ... }, security: {...} }`
- Maps `nodeConfig.fallbackModel` → `{ modelConfigs: { customAliases: {...} } }`
- Stamps every emitted block with `_archonGeneratedRunId: <uuid>` sentinel

### Feature 2: Sub-Agent File Stager

**Purpose:** Convert inline `agents:` array into `.gemini/agents/<name>.md` files with YAML frontmatter.

**Operations:**

- `buildAgentFiles(agents: AgentDefinition[]): AgentMarkdownFile[]` — pure
- Each file: YAML frontmatter (`name`, `description`, `kind: local`, `tools`, `model`, etc.) + markdown body (the system prompt)
- Validates names match `^[a-z][a-z0-9_-]*$` (gemini-cli requirement)

### Feature 3: Lifecycle Helper

**Purpose:** Wrap a single SDK `sendQuery` call with staging-before / cleanup-after.

**Operations:**

- `withStagedGeminiConfig<T>(cwd: string, options: SendQueryOptions, fn: () => Promise<T>): Promise<T>`
- Phase 1: write files into `<cwd>/.gemini/`, run `fn`, delete files we wrote in `finally`
- Phase 2: acquire lockfile → backup existing → merge → write → run `fn` → restore in `finally`
- Tracks written file paths in a per-call manifest so cleanup deletes only what we created (never user-authored files)

### Feature 4: Buffered Structured-Output Path

**Purpose:** Route nodes with `output_format` through the SDK's `queryFull()` for schema-conformant JSON.

**Operations:**

- In `provider.ts` `sendQuery`: if `options.outputFormat` is set → call `queryFull()` → wrap the single response as a one-shot async generator yielding an `assistant` chunk + `result` chunk
- Streaming nodes (no `outputFormat`) continue through `query()` unchanged
- `queryFull` failure → surface as `ModelAccessError` (existing error class)

---

## 8. Technology Stack

**Languages & Runtimes:**

- TypeScript 5.x (strict mode, project standard)
- Bun 1.3+ (test runner, package manager)

**Dependencies (existing, no new top-level deps):**

- `@lrilai/gemini-cli-sdk` — unchanged version pin
- `@archon/paths` — already used for `createLogger`
- `node:fs/promises` — file staging I/O
- `node:path` — path joins
- `node:crypto` — `randomUUID()` for run-id sentinels and lockfile content

**No new dependencies required.** Deep-merge logic in Phase 2 can be implemented in <50 lines for the limited key surface we touch (`mcpServers`, `tools.sandbox`, `modelConfigs`, `security`); pulling in `deepmerge` or `lodash.merge` is not justified for this scope (KISS + YAGNI per CLAUDE.md).

**Test Infrastructure:**

- Bun's built-in test runner with `spyOn()` for internal-module spies (mock isolation rules per CLAUDE.md)
- Real `os.tmpdir()` directories for integration tests, cleaned up in `afterEach`
- The gemini provider's existing test split (`provider.test.ts`, `options-translator.test.ts`, `config.test.ts`) gets a 4th file: `config-stager/*.test.ts`. Verify no `mock.module()` conflicts with existing files before adding.

---

## 9. Security & Configuration

### Authentication

Unchanged from v1. The provider continues to rely on ambient `~/.gemini/` OAuth credentials. The subprocess inherits the parent process env (including `HOME`), so credential resolution is unaffected by config staging. The stager never touches `~/.gemini/` — only the project-layer `.gemini/` inside the cwd.

### Configuration Surface

**New `nodeConfig` keys consumed (already in schema, currently warn-and-ignored for Gemini):**

- `mcp: string` — file path to MCP config JSON
- `agents: AgentDefinition[]` — inline sub-agent definitions
- `sandbox: SandboxConfig` — sandbox mode (`docker`, `seatbelt`, `none`)
- `fallbackModel: string` — fallback model id
- `output_format: { type, schema? }` — structured output request

**No new top-level `.archon/config.yaml` keys.** All config flows through existing per-node and per-workflow keys.

### Security Considerations

**In Scope:**

- ✅ Sentinel keys (`_archonGeneratedRunId`) so users can identify Archon-written config at a glance
- ✅ Cleanup-on-crash via `try/finally` + startup `.bak` recovery (Phase 2)
- ✅ Lockfile prevents concurrent Archon runs in the same cwd from corrupting each other's writes (Phase 2)
- ✅ Sub-agent name validation rejects path-traversal characters (`.`, `/`, `\`) before writing files
- ✅ MCP config file paths are resolved relative to the workflow cwd and rejected if they escape it (existing `@archon/paths` utility)

**Out of Scope:**

- ❌ Sandbox isolation of the gemini-cli subprocess itself — that's gemini-cli's responsibility (delegated via `tools.sandbox`)
- ❌ Sub-agent prompt content sanitization — sub-agent prompts are workflow-author code, treated with the same trust as any other workflow YAML
- ❌ Validating that the user's existing `.gemini/settings.json` is well-formed — if it's already broken, we report and abort the merge rather than try to fix it

### Deployment

No new deployment artifacts. The change is a pure provider-layer enhancement shipped in the standard Archon binary/source build. Bundled defaults (`bundled-defaults.generated.ts`) are unaffected because none of the new e2e test workflows live under `.archon/workflows/defaults/`.

---

## 10. API Specification

No new HTTP endpoints. The provider expansion is transparent to `/api/providers` (the `capabilities` field in the response will simply have more `true` values after MVP).

The `GET /api/providers` response shape is unchanged; the data inside it shifts:

```jsonc
// Before MVP
{ "id": "gemini", "capabilities": { "mcp": false, "agents": false, "sandbox": false, "fallbackModel": false, "structuredOutput": false, ... } }

// After MVP Phase 1
{ "id": "gemini", "capabilities": { "mcp": true, "agents": true, "sandbox": true, "fallbackModel": true, "structuredOutput": true, ... } }
```

---

## 11. Success Criteria

### MVP Success Definition

A workflow author can write a `provider: gemini` node with `mcp:`, `agents:`, `sandbox:`, `fallbackModel:`, or `output_format:` and have it execute correctly — no warning emitted, no silent ignore — provided the run is worktree-isolated (Phase 1) or running in any cwd (Phase 2).

### Functional Requirements

- ✅ Each of the 5 new e2e workflows in `.archon/workflows/test-workflows/` runs end-to-end with exit 0
- ✅ `GEMINI_CAPABILITIES` reports `mcp: true`, `agents: true`, `sandbox: true`, `fallbackModel: true`, `structuredOutput: true`
- ✅ `warnIgnoredOptions()` no longer warns for the 5 newly-supported keys
- ✅ No regression in existing v1 capability behavior (`sessionResume`, `toolRestrictions`, `envInjection` still work as before)
- ✅ No regression in v1's `archon-gemini-showcase` and `e2e-gemini-smoke` workflows
- ✅ `bun run validate` passes (type-check + lint + format + tests + check:bundled)

### Quality Indicators

- ✅ All new code has explicit return types (ESLint zero-warning policy)
- ✅ No `any` types added without an inline justification comment
- ✅ Unit tests for every pure builder function (statements + branches)
- ✅ Integration tests for the lifecycle helper using real temp dirs
- ✅ Inline comments only where the _why_ is non-obvious (CLAUDE.md guideline)

### User Experience Goals

- ✅ A workflow author who writes `mcp: ./foo.json` on a Gemini node gets the same behavior as on a Claude node
- ✅ A user with their own hand-authored `~/.gemini/settings.json` sees no change in behavior after Archon runs (Phase 2)
- ✅ A workflow author moving a node between providers doesn't need to know about provider-specific staging mechanics

---

## 12. Implementation Phases

### Phase 1: Worktree-Only Config Staging (Foundation)

**Goal:** Resolve the 5 high-value capabilities for the 90% case (worktree-isolated runs).

**Deliverables:**

- ✅ `config-stager/settings-builder.ts` + tests
- ✅ `config-stager/agents-builder.ts` + tests
- ✅ `config-stager/lifecycle.ts` (worktree-only mode) + tests
- ✅ `provider.ts` integration: wrap `sendQuery` body in `withStagedGeminiConfig`
- ✅ `provider.ts` integration: buffered `queryFull()` path for `output_format`
- ✅ `capabilities.ts` flag flips (mcp, agents, sandbox, fallbackModel, structuredOutput → `true`)
- ✅ `options-translator.ts` `warnIgnoredOptions()` cleanup
- ✅ Worktree-detection guard: `GeminiConfigStagingNotSupportedError` if a staged capability is requested in `--no-worktree`
- ✅ 5 e2e workflows in `.archon/workflows/test-workflows/`
- ✅ Updated capability matrix in [GEMINI_DEMO.md](GEMINI_DEMO.md)
- ✅ Updated `packages/docs-web/src/content/docs/getting-started/ai-assistants.md`

**Validation:**

- All 5 e2e workflows pass when run inside a worktree
- All 5 e2e workflows fail loudly (clear error) when run with `--no-worktree`
- `archon-gemini-showcase` v1 workflow still passes
- `bun run validate` passes

**Estimated complexity:** Medium

### Phase 2: `--no-worktree` Collision Safety (Hardening)

**Goal:** Lift the Phase 1 worktree-only restriction without risking user `.gemini/settings.json` corruption.

**Deliverables:**

- ✅ `config-stager/merge.ts` — additive deep-merge for our specific key surface
- ✅ `config-stager/backup.ts` — backup-and-restore with crash recovery on startup
- ✅ `config-stager/lockfile.ts` — `.archon.lock` acquire/release/timeout
- ✅ `lifecycle.ts` enhancement: orchestrate merge → backup → write → run → restore → unlock
- ✅ Remove worktree-only guard from Phase 1
- ✅ Crash-recovery test (kill mid-invoke; verify next start restores the .bak)
- ✅ Concurrency test (two simulated parallel runs in same cwd; verify lockfile serializes)

**Validation:**

- All 5 e2e workflows pass when run with `--no-worktree`
- Crash recovery test passes
- Concurrency test passes
- `bun run validate` passes

**Estimated complexity:** Medium-High (the crash-recovery and lockfile machinery is the trickiest part of the whole PRD)

### Phase 3: Documentation + Capability Discoverability

**Goal:** Make the new capabilities discoverable for workflow authors and consistent with cross-provider docs.

**Deliverables:**

- ✅ Update [GEMINI_DEMO.md](GEMINI_DEMO.md) §5 Findings with any new SDK bugs found during MVP build
- ✅ Add a "Provider capability parity" section to the AI assistants doc cross-referencing what works where
- ✅ Add an example to the workflows authoring docs showing a mixed Claude/Gemini workflow with `mcp:` on both nodes
- ✅ CHANGELOG entry

**Validation:**

- Docs build (`bun --filter @archon/docs-web build`) passes
- All doc links resolve

**Estimated complexity:** Low

---

## 13. Future Considerations

**v3 — Hooks and Skills (Schema Design Required):**

- Design a `hooks_gemini` schema variant that accepts shell commands (matching gemini-cli's hook contract) rather than JS callbacks (matching Claude's). Avoid pretending the existing `hooks:` key translates.
- Translate Archon's skill format to gemini-cli's Agent Skills shape, or — equivalently — auto-generate gemini-cli skills from Archon's `SKILL.md` files using a deterministic transformer.

**v3 — Effort/Thinking Mapping:**

- If Google publishes a stable mapping between thinking budgets and Gemini generation settings, add a `thinking`/`effort` translation. Until then, leave `false`.

**Upstream SDK Quality-of-Life:**

- File a feature request on `@lrilai/gemini-cli-sdk` for `mcpServers` / `sandbox` / `modelConfigs` `QueryOptions` args. Would simplify Phase 1 staging logic if accepted.
- File a feature request for a `bufferedQuery()` or `queryFull()` re-export that doesn't require dual entry points.

**Cross-Provider Capability Negotiation:**

- The capability matrix is currently inspected by the engine at node-execution time. A future refactor could expose it at workflow-load time so workflow authors get static-validation errors (e.g. "this workflow uses `effort:` on a Gemini node — that capability is `false`") rather than runtime warnings.

**SDK Bug Tracking:**

- The v1 demo found two real SDK bugs (double-quote prompts hard-fail; session-resume degrades fidelity). v2 build is likely to surface more. Establish a `docs/gemini-sdk-bugs.md` log to track them.

---

## 14. Risks & Mitigations

### Risk 1: `--no-worktree` crash leaves user's `.gemini/settings.json` mangled

**Mitigation:** Phase 1 ships with a hard guard rejecting staged capabilities under `--no-worktree`. Phase 2's backup + startup-recovery design means any crash between backup-write and restore is recovered by the next Archon run that touches the same cwd. Validated by a deliberate-crash integration test.

### Risk 2: Concurrent Archon runs in the same cwd corrupt each other's settings.json

**Mitigation:** Phase 2 lockfile (`.archon.lock`) serializes runs. Stale-lock detection via PID liveness check + max age. Lockfile owner ID lets a second runner distinguish "owned by live process" from "abandoned by dead process."

### Risk 3: gemini-cli changes its settings.json schema in a future release, breaking our writes

**Mitigation:** Keep the `SettingsJsonPatch` shape narrow — write only the specific keys we need (`mcpServers`, `tools.sandbox`, `modelConfigs`, `security`). Pin a tested `gemini-cli` version range in docs. Failure mode is graceful: gemini-cli ignores unknown keys, so a schema drift typically degrades to "feature silently ignored" rather than "crash."

### Risk 4: SDK bugs cascade into the new code paths (e.g., the v1 double-quote bug)

**Mitigation:** Each e2e test workflow uses prompts that avoid the known v1 SDK gotchas (no `"` characters). The provider's existing `ErrorMapper` continues to surface SDK failures as `ModelAccessError`, unchanged. Any new SDK bug found is documented in [GEMINI_DEMO.md](GEMINI_DEMO.md) §5 with isolated reproduction.

### Risk 5: Capability matrix declarations drift from actual wired-up behavior over time

**Mitigation:** Each capability flag is enforced by an e2e test workflow — if `mcp: true` is declared, an `e2e-gemini-mcp.yaml` run is part of the test suite, and its failure blocks CI. The flag and the test are physically co-located in the PR that introduces them.

---

## 15. Appendix

### Related Documents

- [GEMINI_DEMO.md](GEMINI_DEMO.md) — v1 evidence document, capability matrix, SDK bug log
- [CLAUDE.md](CLAUDE.md) — Project engineering principles (KISS, YAGNI, Fail-Fast, Reversibility), test isolation rules, package boundaries
- [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) — Required PR format
- `packages/providers/src/community/gemini/capabilities.ts` — Source of truth for declared capabilities (flags get flipped here)
- `packages/providers/src/community/gemini/options-translator.ts` — Existing translation layer

### Key External Dependencies & References

- [`@lrilai/gemini-cli-sdk`](https://www.npmjs.com/package/@lrilai/gemini-cli-sdk) — SDK (unchanged version pin)
- [Gemini CLI configuration reference](https://geminicli.com/docs/reference/configuration/) — settings.json precedence (defaults < system-defaults < **user** < **project** < system < env vars < CLI args)
- [Gemini CLI subagents](https://geminicli.com/docs/core/subagents/) — `.gemini/agents/*.md` format and `@name` activation
- [Gemini CLI model routing](https://geminicli.com/docs/cli/model-routing/) — `modelConfigs` aliases and fallback chains
- [Gemini CLI headless mode](https://geminicli.com/docs/cli/headless/) — `--output-format json/jsonl` (alternate route if SDK `queryFull()` proves insufficient)
- [GitHub issue #8248](https://github.com/google-gemini/gemini-cli/issues/8248) — `GEMINI_CONFIG_DIR` broken on Windows (justification for rejecting that approach)

### Package Structure Touched

```
packages/providers/src/community/gemini/
├── capabilities.ts                  [MODIFIED]
├── options-translator.ts            [MODIFIED]
├── provider.ts                      [MODIFIED]
├── config-stager/                   [NEW]
│   ├── index.ts
│   ├── settings-builder.ts
│   ├── agents-builder.ts
│   ├── lifecycle.ts
│   ├── merge.ts                     (Phase 2)
│   ├── lockfile.ts                  (Phase 2)
│   ├── backup.ts                    (Phase 2)
│   └── *.test.ts
└── (existing files unchanged)

.archon/workflows/test-workflows/    [NEW e2e workflows]
├── e2e-gemini-mcp.yaml
├── e2e-gemini-agents.yaml
├── e2e-gemini-sandbox.yaml
├── e2e-gemini-fallback.yaml
└── e2e-gemini-structured-output.yaml

GEMINI_DEMO.md                       [MODIFIED — matrix update]
packages/docs-web/src/content/docs/
  getting-started/ai-assistants.md   [MODIFIED — Gemini capabilities section]
CHANGELOG.md                         [MODIFIED — release notes entry]
```

### Assumptions Made (Reviewer Validation Requested)

1. **`@lrilai/gemini-cli-sdk` does not strip or override `.gemini/` files in the cwd it's invoked with.** This needs an empirical confirmation test before Phase 1 begins (write a settings.json into a temp cwd, invoke the SDK, verify gemini-cli picked it up).
2. **gemini-cli's project-settings discovery walks up from cwd to nearest `.git` directory** (per docs). Archon worktrees always have a `.git` file at the worktree root, so the discovery terminates at the worktree root and not at the parent main repo. Worth confirming on Windows specifically.
3. **The SDK's `queryFull()` is exported and stable.** PRD assumes it is, based on capabilities.ts comments and SDK v1.0.0 docs. Verify the export exists in the pinned SDK version before relying on it in Phase 1.
4. **`fs.promises.rename` is atomic enough for backup-restore on Windows.** Phase 2 design assumes Node's rename semantics work for `.bak` restoration. If Windows shows non-atomic behavior, fall back to copy-then-delete with a marker file.
5. **No workflow author currently relies on the warn-and-run behavior of `mcp`/`agents`/`sandbox`/`fallbackModel`/`output_format` on Gemini nodes** (i.e., depends on them being silently ignored). Flipping these to `true` is a behavior change for those users. This is judged acceptable because the prior behavior was explicitly documented as a fail-safe, not a feature.
