# Development Guidelines

> Reference detail extracted from `CLAUDE.md`. Canonical source for UI/design rules, SDK
> type patterns, testing, logging, the command system, error handling, and the API endpoint
> surface. `CLAUDE.md` keeps the high-level rules and links here.

## UI and Visual Design

All UI changes — production web (`packages/web/`), experiments (`packages/web/src/experiments/`), the docs site, marketing surfaces, and any future visual surface — must align with the Archon brand foundation.

- **Canonical brand guide:** https://archon.diy/brand/ (source: `packages/docs-web/src/content/docs/brand/index.md` + `packages/docs-web/public/brand/foundation.html`).
- **Use brand tokens, not ad-hoc values.** Colors, gradients, surfaces, and typography must come from the established design tokens (`packages/web/src/index.css`) or the brand guide. Don't hard-code hex values that aren't in the system.
- **Introducing a new visual token** (color, font, radius, spacing) means updating both the token source and the brand guide. Don't fork the palette per package.
- **When in doubt, consult the brand guide first** before inventing new visual treatments. Open a discussion if the guide doesn't cover your case.

## When Creating New Features

**Quick reference:**
- **Platform Adapters**: Implement `IPlatformAdapter`, handle auth, polling/webhooks
- **AI Providers**: Implement `IAgentProvider`, session management, streaming
- **Slash Commands**: Add to command-handler.ts, update database, no AI
- **Database Operations**: Use `IDatabase` interface (supports PostgreSQL and SQLite via adapters)
- **Plan insertion points**: Use stable text anchors (e.g., "after the `it('throws on ...')` test block"), never raw line numbers — line numbers drift on every preceding edit.

## SDK Type Patterns

When working with external SDKs (Claude Agent SDK, Codex SDK), prefer importing and using SDK types directly:

```typescript
// ✅ CORRECT - Import SDK types directly
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';

const options: Options = {
  cwd,
  permissionMode: 'bypassPermissions',
  // ...
};

// Use type assertions for SDK response structures
const message = msg as { message: { content: ContentBlock[] } };
```

```typescript
// ❌ AVOID - Defining duplicate types
interface MyQueryOptions {  // Don't duplicate SDK types
  cwd: string;
  // ...
}
const options: MyQueryOptions = { ... };
query({ prompt, options: options as any });  // Avoid 'as any'
```

This ensures type compatibility with SDK updates and eliminates `as any` casts.

## Testing

**Unit Tests:**
- Test pure functions (variable substitution, command parsing)
- Mock external dependencies (database, AI SDKs, platform APIs)

**Integration Tests:**
- Test database operations with test database
- Test end-to-end flows (mock platforms/AI but use real orchestrator)
- Clean up test data after each test

**Mock isolation rules (IMPORTANT):**
- Bun's `mock.module()` is process-global and irreversible — `mock.restore()` does NOT undo it
- Do NOT add `afterAll(() => mock.restore())` for `mock.module()` cleanup — it has no effect
- Use `spyOn()` for internal modules that other test files import directly (e.g., `spyOn(git, 'checkout')`) — `spy.mockRestore()` DOES work for spies
- Never `mock.module()` a module path that another test file also `mock.module()`s with a different implementation
- When adding a new test file with `mock.module()`, ensure its package.json test script runs it in a separate `bun test` invocation from any conflicting files

**Manual Validation:** Use the web API (`curl`) or CLI commands directly for end-to-end testing of new features.

## Logging

**Structured logging with Pino** (`packages/paths/src/logger.ts`):

```typescript
import { createLogger } from '@archon/paths';

const log = createLogger('orchestrator');

// Event naming: {domain}.{action}_{state}
// Standard states: _started, _completed, _failed, _validated, _rejected
async function createSession(conversationId: string, codebaseId: string) {
  log.info({ conversationId, codebaseId }, 'session.create_started');

  try {
    const session = await doCreate();
    log.info({ conversationId, codebaseId, sessionId: session.id }, 'session.create_completed');
    return session;
  } catch (e) {
    const err = e as Error;
    log.error(
      { conversationId, error: err.message, errorType: err.constructor.name, err },
      'session.create_failed',
    );
    throw err;
  }
}
```

**Event naming rules:**
- Format: `{domain}.{action}_{state}` — e.g. `workflow.step_started`, `isolation.create_failed`
- Avoid generic events like `processing` or `handling`
- Always pair `_started` with `_completed` or `_failed`
- Include context: IDs, durations, error details

**Log Levels:** `fatal` > `error` > `warn` > `info` (default) > `debug` > `trace`

**Verbosity:**
- CLI: `archon --quiet` (errors only) — suppresses Pino logs and workflow progress output
- CLI: `archon --verbose` (debug) — enables debug Pino logs and tool-level workflow progress events
- Server: `LOG_LEVEL=debug bun run start`

**Never log:** API keys or tokens (mask: `token.slice(0, 8) + '...'`), user message content, PII.

## Command System

**Variable Substitution:**
- `$1`, `$2`, `$3` - Positional arguments
- `$ARGUMENTS` - All arguments as single string
- `$ARTIFACTS_DIR` - External artifacts directory for the current workflow run (pre-created by executor)
- `$WORKFLOW_ID` - The workflow run ID
- `$BASE_BRANCH` - Base branch; auto-detected from git when `worktree.baseBranch` is not set; fails only if referenced in a prompt and auto-detection also fails
- `$DOCS_DIR` - Documentation directory path; configured via `docs.path` in `.archon/config.yaml`. Defaults to `docs/`. Never throws.
- `$LOOP_USER_INPUT` - User feedback provided via `/workflow approve <id> <text>` at an interactive loop gate. Only populated on the first iteration of a resumed interactive loop; empty string on all other iterations.
- `$REJECTION_REASON` - Reviewer feedback provided via `/workflow reject <id> <reason>` at an approval gate. Only populated in `on_reject` prompts; empty string elsewhere.
- `$LOOP_PREV_OUTPUT` - Cleaned output of the previous loop iteration (loop nodes only). Empty string on the first iteration (no prior output exists). Useful for `fresh_context: true` loops that need to reference what the previous pass produced or why it failed without carrying full session history.

**Command Types:**

1. **Codebase Commands** (per-repo):
   - Stored in `.archon/commands/` (plain text/markdown)
   - Discovered from the repository `.archon/commands/` directory
   - Surfaced via `GET /api/commands` for the workflow builder and invoked by workflow `command:` nodes

2. **Workflows** (YAML-based):
   - Stored in `.archon/workflows/` (searched recursively)
   - Multi-step AI execution chains, discovered at runtime
   - **`nodes:` (DAG format)**: Nodes with explicit `depends_on` edges; independent nodes in the same topological layer run concurrently. Node types: `command:` (named command file), `prompt:` (inline prompt), `bash:` (shell script, stdout captured as `$nodeId.output`, no AI, receives managed per-project env vars in its subprocess environment when configured), `loop:` (iterative AI prompt until completion signal), `approval:` (human gate; pauses until user approves or rejects; `capture_response: true` stores the user's comment as `$<node-id>.output` for downstream nodes, default false), `script:` (inline TypeScript/Python or named script from `.archon/scripts/`, runs via `bun` or `uv`, stdout captured as `$nodeId.output`, no AI, receives managed per-project env vars in its subprocess environment when configured, supports `deps:` for dependency installation and `timeout:` in ms, requires `runtime: bun` or `runtime: uv`) . Supports `when:` conditions, `trigger_rule` join semantics, `$nodeId.output` substitution, `output_format` for structured JSON output (SDK-enforced on Claude/Codex/OpenCode; best-effort prompt-augmentation + repair on Pi/Copilot — the parsed output is **validated against the declared schema for every provider**, best-effort providers (Pi/Copilot) re-ask up to 3× on a validation miss, and a node that declares `output_format` but returns no schema-valid output **fails** rather than degrading silently; `$nodeId.output.field` access is strict — a field not in the producer's schema, or a schemaless node whose output isn't JSON / lacks the key, fails the consuming node, while an author-declared-optional field resolves to `''`), `allowed_tools`/`denied_tools` for per-node tool restrictions (Claude only), `hooks` for per-node SDK hook callbacks (Claude only), `mcp` for per-node MCP server config files (Claude only, env vars expanded at execution time), and `skills` for per-node skill preloading via AgentDefinition wrapping (Claude only for per-node injection; Codex supports skills via filesystem auto-discovery from `.agents/skills/` — the `skills:` list is informational for Codex nodes), `agents` for inline sub-agent definitions invokable via the Task tool (Claude only), and `effort`/`thinking`/`maxBudgetUsd`/`systemPrompt`/`fallbackModel`/`betas`/`sandbox` for Claude SDK advanced options (Claude only, also settable at workflow level), and `persist_session` for cross-run provider session continuity (node-level opt-in; workflow-level default via `persist_sessions: true`; requires a provider with the `sessionResume` capability), and `output_type` (any node type) for engine-written typed output sidecars — when set, the executor writes `$ARTIFACTS_DIR/nodes/<id>.md` + `<id>.meta.json` after the node completes (best-effort) so downstream nodes and later runs can locate output by type instead of guessing filenames
   - Workflow-level `requires: [github]` hard-blocks invocation (before any worktree/clone/AI cost) when the originating user hasn't connected their GitHub identity — enforced only when per-user GitHub is enabled (GitHub App + `TOKEN_ENCRYPTION_KEY`); a no-op for solo PAT installs
   - Provider inherited from `.archon/config.yaml` unless explicitly set; per-node `provider` and `model` overrides supported
   - Model and options can be set per workflow or inherited from config defaults
   - `interactive: true` at the workflow level forces foreground execution on web (required for approval-gate workflows in the web UI)
   - Model validation ensures provider/model compatibility at load time
   - Commands: `/workflow list`, `/workflow reload`, `/workflow status`, `/workflow cancel`, `/workflow resume <id>` (re-runs failed workflow, skipping completed nodes), `/workflow abandon <id>`, `/workflow cleanup [days]` (CLI only — deletes old run records), `/workflow reset-sessions <name> [<node-id>]` (clears persisted `persist_session` memory; chat auto-scopes to the current conversation, CLI adds `--scope`/`--yes` for cross-scope control)
   - Resilient loading: One broken YAML doesn't abort discovery; errors shown in `/workflow list`
   - `resolveWorkflowName()` (in `router.ts`) resolves workflow names via a 4-tier fallback — exact, case-insensitive, suffix (`-name`), substring — with ambiguity detection; used by both the CLI and all chat platforms
   - Router fallback: if no `/invoke-workflow` is produced, falls back to `archon-assist` (with "Routing unclear" notice); raw AI response returned only when `archon-assist` is unavailable
   - Claude routing calls use `tools: []` to prevent tool use at the API level; Codex tool bypass is detected and triggers the same fallback

**Defaults:**
- Bundled in `.archon/commands/defaults/` and `.archon/workflows/defaults/`
- Binary builds: Embedded at compile time (no filesystem access needed) via `packages/workflows/src/defaults/bundled-defaults.generated.ts`
- Source builds: Loaded from filesystem at runtime
- Merged with repo-specific commands/workflows (repo overrides defaults by name)
- Opt-out: Set `defaults.loadDefaultCommands: false` or `defaults.loadDefaultWorkflows: false` in `.archon/config.yaml`
- **After adding, removing, or editing a default file, run `bun run generate:bundled`** to refresh the embedded bundle. After editing `migrations/000_combined.sql`, run `bun run generate:bundled-schema` to keep the embedded schema in sync. `bun run validate` (and CI) run `check:bundled`, `check:bundled-skill`, and `check:bundled-schema` and will fail loudly if any generated file is stale.

**Home-scoped ("global") workflows, commands, and scripts** (user-level, applies to every project):
- Workflows: `~/.archon/workflows/` (or `$ARCHON_HOME/workflows/`)
- Commands: `~/.archon/commands/` (or `$ARCHON_HOME/commands/`)
- Scripts: `~/.archon/scripts/` (or `$ARCHON_HOME/scripts/`)
- Source label: `source: 'global'` on workflows and commands (scripts don't have a source label)
- Load priority: bundled < global < project (repo overrides global by filename or script name)
- Subfolders: supported 1 level deep (e.g. `~/.archon/workflows/triage/foo.yaml`). Deeper nesting is ignored silently.
- Discovery is automatic — `discoverWorkflowsWithConfig(cwd, loadConfig)` and `discoverScriptsForCwd(cwd)` both read home-scoped paths unconditionally; no caller option needed
- **Migration from pre-0.x `~/.archon/.archon/workflows/`**: if Archon detects files at the old location it emits a one-time WARN with the exact `mv` command and does NOT load from there. Move with: `mv ~/.archon/.archon/workflows ~/.archon/workflows && rmdir ~/.archon/.archon`
- See the docs site at `packages/docs-web/` for details

## Error Handling

**Database Errors:**
```typescript
// INSERT operations
try {
  await db.query('INSERT INTO conversations ...', params);
} catch (error) {
  log.error({ err: error, params }, 'db_insert_failed');
  throw new Error('Failed to create conversation');
}

// UPDATE operations - verify rowCount to catch missing records
try {
  await db.updateConversation(conversationId, { codebase_id: codebaseId });
} catch (error) {
  // updateConversation throws if no rows matched (conversation not found)
  log.error({ err: error, conversationId }, 'db_update_failed');
  throw error; // Re-throw to surface the issue
}
```

**Git Operation Errors (don't fail silently):**
```typescript
// When isolation environment creation fails:
try {
  // ... isolation creation logic ...
} catch (error) {
  const err = error as Error;
  const userMessage = classifyIsolationError(err);
  log.error({ err, codebaseId, codebaseName }, 'isolation_creation_failed');
  await platform.sendMessage(conversationId, userMessage);
}
```

Pattern: Use `classifyIsolationError()` (from `@archon/isolation`) to map git errors (permission denied, timeout, no space, not a git repo) to user-friendly messages. Always log the raw error for debugging and send a classified message to the user.

## API Endpoints

**Web UI REST API** (`packages/server/src/routes/api.ts`):

**Workflow Management:**
- `GET /api/workflows` - List available workflows; optional `?cwd=`; returns `{ workflows: [...], errors?: [...] }`
- `POST /api/workflows/validate` - Validate a workflow definition in-memory (no save); body: `{ definition: object }`; returns `{ valid: boolean, errors?: string[] }`
- `GET /api/workflows/:name` - Fetch a single workflow by name; optional `?cwd=` query param; returns `{ workflow, filename, source: 'project' | 'bundled' }`
- `PUT /api/workflows/:name` - Save (create or update) a workflow YAML; body: `{ definition: object }`; validates before writing; requires `?cwd=` or registered codebase
- `DELETE /api/workflows/:name` - Delete a user-defined workflow; bundled defaults cannot be deleted
- `DELETE /api/workflows/:name/node-sessions` - Reset persisted per-node provider sessions; optional `?scope=` and `?node=` narrow the deletion; omitting `?scope=` is a cross-scope wipe and requires `?confirm=all-scopes`; returns `{ success, deleted }`

**Workflow Run Lifecycle:**
- `POST /api/workflows/runs/{runId}/resume` - Resume a failed run from where it left off (skips already-completed DAG nodes; AI session context is not restored).
- `POST /api/workflows/runs/{runId}/abandon` - Abandon a non-terminal run (marks as cancelled)
- `DELETE /api/workflows/runs/{runId}` - Delete a terminal workflow run and its events

**Codebases:**
- `GET /api/codebases` / `GET /api/codebases/:id` - List / fetch codebases
- `POST /api/codebases` - Register a codebase (clone or local path)
- `DELETE /api/codebases/:id` - Delete a codebase and clean up resources
- `GET /api/codebases/:id/env` - List env var keys for a codebase (never returns values)
- `PUT /api/codebases/:id/env` / `DELETE /api/codebases/:id/env/:key` - Upsert / delete a single codebase env var
- `GET /api/codebases/:id/environments` - List tracked isolation environments for a codebase

**Artifact Files:**
- `GET /api/runs/:runId/artifacts` - List artifact files for a run; walks the on-disk artifact directory (dotfiles skipped) and returns `{ files: [{ path, size, modifiedAt }] }`; 400 on invalid run id or path-escape attempt, 404 if the run does not exist
- `GET /api/artifacts/:runId/*` - Serve a workflow artifact file by run ID and relative path; returns `text/markdown` for `.md` files, `text/plain` otherwise; 400 on path traversal (`..`), 404 if run or file not found

**Command Listing:**
- `GET /api/commands` - List available command names (bundled + project-defined); optional `?cwd=`; returns `{ commands: [{ name, source: 'bundled' | 'project' }] }`

**Providers:**
- `GET /api/providers` - List registered AI providers; returns `{ providers: [{ id, displayName, capabilities, builtIn }] }`. `capabilities.nativeTools` is `true` for providers that accept in-process native tools (Claude, Pi) — Archon's `manage_run` tool is auto-injected into project-scoped chat for those providers only. `capabilities.structuredOutput` is a tiered union `'enforced' | 'best-effort' | false` (not a boolean): `'enforced'` = SDK/backend grammar-constrained (Claude/Codex/OpenCode), `'best-effort'` = prompt-augmentation + validate (Pi/Copilot), `false` = unsupported.

**Web Auth (opt-in Better Auth; Postgres + `BETTER_AUTH_SECRET`):**
- Better Auth mounts email/password login at `/api/auth/*` (sign-up/sign-in/sign-out/get-session). Mounted only when enabled; the catch-all explicitly falls through for Archon-owned `/api/auth/status` + `/api/auth/github*` paths so they aren't shadowed.
- `GET /api/auth/status` - Web auth availability + signup posture (no auth required); returns `{ enabled: boolean, signup: 'allowlist' | 'open' | 'disabled' }`. Drives the Web UI login gate.
- The per-request identity seam is `resolveAuthContext(c): { userId, role } | undefined` (in `routes/api.ts`): Better Auth session first, then the `X-Archon-User` header, then undefined. `resolveWebUserId` delegates to it; `requireWebUser` is the session-aware strict variant (401 missing / 503 backend). `role` rides the canonical user row (default `admin`).
- **Server-side API gate** (`isApiGateEnabled`): when web auth is enabled, every `/api/*` request must resolve to an identity or gets **401** — except `/api/auth/*` (login surface) and `/api/health*` (healthcheck must stay reachable). `/webhooks/*` and `/internal/*` are outside `/api/*` and untouched. On by default; `ARCHON_WEB_AUTH_REQUIRED=false` keeps login-UI-only. This is what lets Better Auth replace the Caddy `forward_auth` sidecar as the real access boundary.
- **Signup safety** (`getSignupMode`): with web auth on and no `ARCHON_AUTH_ALLOWED_EMAILS`, signup defaults to **disabled** (login only) + a boot WARN — never silently open. `ARCHON_AUTH_OPEN_SIGNUP=true` opts into open public signup.
- `GET /api/workflows/runs?mine=true` and `GET /api/conversations?mine=true` - Non-enforcing "my" filter (narrows to `ctx.userId` only when an identity resolves; default lists everything). Not a security boundary.

**GitHub Identity (per-user device flow; App mode + `TOKEN_ENCRYPTION_KEY`):**
- `POST /api/auth/github/device/start` - Begin the device flow for the current web user (from `X-Archon-User`); returns `{ device_code, user_code, verification_uri, interval, expires_in }`; 401 if no web-auth header
- `POST /api/auth/github/device/poll` - Single non-blocking poll; body `{ device_code }`; returns `{ status: 'pending' | 'connected' | 'expired' | 'denied' | 'error', githubLogin?, detail? }`
- `GET /api/auth/github` - Connection status for the current web user; returns `{ connected, githubLogin }`
- `DELETE /api/auth/github` - Disconnect the current web user's GitHub identity

**System:**
- `GET /api/health` - Health check with adapter/system status
- `GET /api/update-check` - Check for available updates; returns `{ updateAvailable, currentVersion, latestVersion, releaseUrl }`; skips GitHub API call for non-binary builds

**OpenAPI Spec:**
- `GET /api/openapi.json` - Generated OpenAPI 3.0 spec for all Zod-validated routes

**Webhooks:**
- `POST /webhooks/github` - GitHub webhook events
- Signature verification required (HMAC SHA-256)
- Return 200 immediately, process async

**Internal (App mode only; bind 127.0.0.1):**
- `POST /internal/git-credential` - Git credential helper endpoint. Returns `{token}` for the installation matching the requested host/path. Used by the `git-credential-archon` script in worktree `.git/config` to refresh installation tokens for long-running workflow `git` operations. Hands out installation tokens — MUST NOT be exposed beyond loopback. Server **refuses to start** (not just WARN) if App mode is active and `hostname != 127.0.0.1/localhost`, unless `ARCHON_ALLOW_INTERNAL_ON_PUBLIC_BIND=1` is set as an opt-in escape hatch for deployments where the reverse proxy already drops `/internal/*`.

**Security:**
- Verify webhook signatures (GitHub: `X-Hub-Signature-256`)
- Use `c.req.text()` for raw webhook body (signature verification)
- Never log or expose tokens in responses
- `/internal/*` paths hand out live credentials — the reverse proxy in production MUST drop them, or the server MUST bind to `127.0.0.1` only.

**@Mention Detection:**
- Parse `@archon` in issue/PR **comments only** (not descriptions)
- Events: `issue_comment` only
- Note: Descriptions often contain example commands or documentation - these are NOT command invocations (see #96)
