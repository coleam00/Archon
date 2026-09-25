import { z } from 'zod';

/**
 * Provider capability flags. The dag-executor uses these for capability warnings
 * when a node specifies features the target provider doesn't support.
 */
export const providerCapabilitiesSchema = z.object({
  sessionResume: z.boolean(),
  /**
   * Given a session ID, create a new session containing the source history
   * while leaving the source unchanged. Omission means unsupported.
   */
  sessionFork: z.boolean().optional(),
  mcp: z.boolean(),
  hooks: z.boolean(),
  skills: z.boolean(),
  /** Whether the provider supports inline sub-agent definitions (Claude SDK's options.agents). */
  agents: z.boolean(),
  toolRestrictions: z.boolean(),
  /**
   * Built-in tool-name vocabulary for advisory validation of
   * `allowed_tools`/`denied_tools` entries. When present, workflow validation
   * warns (never errors) on entries not in this list — after stripping a
   * `Tool(specifier)` suffix and skipping `mcp__*` names, which are dynamic
   * per-install. When absent, the check is skipped entirely: providers without
   * a stable audited vocabulary opt out simply by not declaring one, keeping
   * their tool names out of the shared schema.
   */
  knownToolNames: z.array(z.string()).readonly().optional(),
  /**
   * Old tool name → current tool name, for tools the provider's SDK has
   * renamed (e.g. Claude's `Task` → `Agent`). Lets validation give a precise
   * "renamed" hint instead of a generic unknown-name warning, since a stale
   * name is a silent no-op at runtime.
   */
  renamedTools: z.record(z.string(), z.string()).readonly().optional(),
  /**
   * Structured-output guarantee tier for `output_format`:
   *  - `'enforced'`    — SDK/backend grammar-constrains decoding (Claude, Codex,
   *    OpenCode). The request path is native; Archon still validates post-parse
   *    as a net for the refusal / `max_tokens`-truncation edges.
   *  - `'best-effort'` — prompt-augmentation + repair + post-parse validate (Pi,
   *    Copilot). No backend grammar; on a validation miss the executor re-asks up
   *    to 3× (prompt + schema errors), then fails the node.
   *  - `false`         — the provider cannot produce structured output at all.
   */
  structuredOutput: z.union([z.literal('enforced'), z.literal('best-effort'), z.literal(false)]),
  /**
   * Whether the provider enforces OpenAI Structured Outputs strict-mode's
   * required-coverage rule: every key declared in `properties` MUST also
   * appear in `required`. A schema that violates this rule is rejected by the
   * provider's API with HTTP 400 `invalid_json_schema` before any work starts.
   *
   * Only relevant when `structuredOutput` is `'enforced'`. Among enforced
   * providers, only Codex (OpenAI) enforces this rule; Claude accepts
   * optional-by-omission. Best-effort providers never reject schemas at the
   * API level and declare `false`.
   */
  requiresAllPropertiesRequired: z.boolean(),
  envInjection: z.boolean(),
  /**
   * Whether the provider enforces the per-run spend limit (`maxBudgetUsd`) — it
   * can stop a run once the limit is exceeded. Says nothing about whether a turn
   * reports what it cost; see `costReporting`.
   */
  costControl: z.boolean(),
  /**
   * Whether the provider emits a monetary `cost` on a turn's usage, which the
   * engine surfaces as `costUsd` on node results and rolls up into run totals.
   * True means the translation from the SDK's cost field exists; a turn may still
   * omit the figure when the SDK reports none. The other reporting flags follow
   * the same rule: they describe an available translation, not a guarantee that
   * every result contains the field or that usage covers every nested agent.
   * Omitted reporting flags on older providers mean unknown, not unsupported.
   *
   * Independent of `costControl`: an uncappable provider still prices every
   * turn, and a cappable one is not made cheaper by reporting.
   */
  costReporting: z.boolean(),
  /** Whether the provider translates SDK token usage into result tokens. */
  tokenReporting: z.boolean().optional(),
  /** Whether the provider translates an SDK stop reason into the terminal result. */
  stopReasonReporting: z.boolean().optional(),
  /** Whether the provider reports the SDK's turn count, without counting events. */
  turnCountReporting: z.boolean().optional(),
  /** Whether the provider translates a reported model identity, not the requested alias. */
  resolvedModelReporting: z.boolean().optional(),
  effortControl: z.boolean(),
  fallbackModel: z.boolean(),
  sandbox: z.boolean(),
  /**
   * Whether the provider honors the per-node `settingSources` override (which
   * filesystem setting sources the agent loads: CLAUDE.md, skills, commands,
   * agents). `true` for Claude only — the Claude Agent SDK's `settingSources`
   * option; other providers have no equivalent knob.
   */
  settingSources: z.boolean(),
  /** Whether the provider can register in-process `NativeTool`s for a turn. */
  nativeTools: z.boolean(),
  /**
   * Whether the provider can execute inside the folder-project container backend
   * (`execContext.kind === 'container'`) — i.e. it knows how to spawn its CLI via
   * `docker exec` rather than a local process. `true` for Claude
   * (`spawnClaudeCodeProcess` hook). The engine's pre-dispatch fail-fast rejects
   * a container run whose resolved provider has this `false`, so an unsupported
   * provider can never silently downgrade to running on the host. Codex/Pi/
   * community providers set `false` until they implement their in-container path.
   */
  containerExec: z.boolean(),
});
export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>;
