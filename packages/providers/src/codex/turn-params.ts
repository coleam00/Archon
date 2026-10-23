/**
 * What a Codex turn sends: the thread config (sandbox, web search, MCP servers, skill
 * scoping), the reasoning effort, the output schema and the prompt with its folded-in
 * system prompt.
 */
import { clampEffort } from '@archon/provider-contract';
import { createLogger } from '@archon/paths';
import type {
  CodexProviderDefaults,
  NodeConfig,
  ProviderWarning,
  SendQueryOptions,
} from '../types';
import { loadMcpConfig } from '../mcp/config';
import { ClassifiedProviderError } from '../shared/failure';
import {
  hasOpenAdditionalProperties,
  normalizeJsonSchemaForOpenAiStrict,
} from '../shared/structured-output';
import { CODEX_EFFORTS } from './config';
import type { JsonValue } from './protocol/serde_json/JsonValue';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.codex');
  return cachedLog;
}

export type CodexConfig = Record<string, JsonValue>;

/**
 * Resolve Codex's reasoning effort from Archon's inputs.
 *
 * Precedence: `nodeConfig.effort` > `assistants.codex.modelReasoningEffort`
 * from config.yaml — mirroring Copilot's `resolveCopilotReasoning`, so a workflow's
 * declared depth beats the install default on both providers alike.
 *
 * Codex accepts every rung on Archon's ladder. A value that is not on the
 * ladder at all falls back to the config default rather than being invented;
 * the workflow loader rejects such values at parse time, so this only guards
 * programmatic callers.
 */
export function resolveModelReasoningEffort(
  nodeConfig: NodeConfig | undefined,
  configured: CodexProviderDefaults['modelReasoningEffort']
): CodexProviderDefaults['modelReasoningEffort'] {
  const declared = nodeConfig?.effort;
  if (declared === undefined) return configured;

  const clamped = clampEffort(declared, CODEX_EFFORTS);
  if (clamped === undefined) {
    getLog().warn({ effort: declared }, 'codex.effort_unrecognized');
    return configured;
  }
  if (clamped !== declared) {
    getLog().debug({ declared, applied: clamped }, 'codex.effort_clamped');
  }
  return clamped;
}

const CODEX_MCP_PASSTHROUGH_KEYS = [
  'command',
  'args',
  'env',
  'url',
  'enabled',
  'required',
  'startup_timeout_sec',
  'startup_timeout_ms',
  'tool_timeout_sec',
  'enabled_tools',
  'disabled_tools',
  'supports_parallel_tool_calls',
  'cwd',
  'env_vars',
  'experimental_environment',
  'http_headers',
  'env_http_headers',
  'oauth_resource',
  'scopes',
  'bearer_token_env_var',
  'default_tools_approval_mode',
  'tools',
] as const;

function toJsonValue(value: unknown): JsonValue | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValue).filter((item): item is JsonValue => item !== undefined);
  }
  if (typeof value === 'object' && value !== null) {
    const result: CodexConfig = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      const converted = toJsonValue(nestedValue);
      if (converted !== undefined) result[key] = converted;
    }
    return result;
  }
  return undefined;
}

function convertMcpServerConfigForCodex(serverConfig: Record<string, unknown>): CodexConfig {
  const result: CodexConfig = {};
  for (const key of CODEX_MCP_PASSTHROUGH_KEYS) {
    const converted = key in serverConfig ? toJsonValue(serverConfig[key]) : undefined;
    if (converted !== undefined) result[key] = converted;
  }
  // Archon's MCP JSON format uses `headers`; Codex config uses `http_headers`.
  if ('headers' in serverConfig && !('http_headers' in result)) {
    const converted = toJsonValue(serverConfig.headers);
    if (converted !== undefined) result.http_headers = converted;
  }
  return result;
}

function buildCodexMcpServers(servers: Record<string, unknown>): CodexConfig | undefined {
  const mcpServers: CodexConfig = {};
  for (const [serverName, serverConfig] of Object.entries(servers)) {
    if (typeof serverConfig !== 'object' || serverConfig === null || Array.isArray(serverConfig)) {
      getLog().warn(
        { serverName, valueType: typeof serverConfig },
        'codex.mcp_server_config_not_object'
      );
      continue;
    }
    const converted = convertMcpServerConfigForCodex(serverConfig as Record<string, unknown>);
    if (Object.keys(converted).length > 0) mcpServers[serverName] = converted;
  }
  return Object.keys(mcpServers).length > 0 ? mcpServers : undefined;
}

export function isWorkflowNode(requestOptions?: SendQueryOptions): boolean {
  const nodeId = requestOptions?.nodeConfig?.nodeId;
  return typeof nodeId === 'string' && nodeId.trim().length > 0;
}

/**
 * The config overrides a thread starts with. Codex merges them over the user's own
 * config.toml; it never replaces it.
 */
export function buildThreadConfig(
  codexConfig: CodexProviderDefaults,
  mcpServers: CodexConfig | undefined,
  scoped: boolean
): CodexConfig {
  const config: CodexConfig = {
    sandbox_workspace_write: {
      network_access: true,
      ...(codexConfig.additionalDirectories?.length
        ? { writable_roots: codexConfig.additionalDirectories }
        : {}),
    },
  };
  if (codexConfig.webSearchMode) config.web_search = codexConfig.webSearchMode;
  if (mcpServers) config.mcp_servers = mcpServers;
  // Scoped requests must not advertise ambient skills. Direct chat keeps the user's setting.
  // An older Codex ignores the key with a config warning rather than failing.
  if (scoped) config.skills = { include_instructions: false };
  return config;
}

/**
 * The thread config that turns off every tool Codex adds from its own config. Codex has no
 * single "no tools" switch, so this turns each one off; an unknown `features` key is accepted
 * silently. A model catalog entry's tools win over it; see `toolFreeModelCatalog`. The
 * real-binary test in `scope.boundary.test.ts` pins it on the bundled Codex.
 */
export const TOOL_FREE_THREAD_CONFIG: CodexConfig = {
  web_search: 'disabled',
  tools: { experimental_request_user_input: { enabled: false } },
  features: {
    goals: false,
    multi_agent: false,
    shell_tool: false,
    unified_exec: false,
    view_image: false,
    image_generation: false,
    sleep_tool: false,
    tool_suggest: false,
    apps: false,
    plugins: false,
    browser_use: false,
    computer_use: false,
  },
};

/**
 * The model catalog the tool-free turn's process loads in place of the user's: one entry for
 * `model` with no tools, so the catalog's own tools (`tool_mode`, `experimental_supported_tools`,
 * `apply_patch_tool_type`) leave the request; thread config cannot do this, because Codex
 * loads the catalog per process. Codex rejects an empty catalog and an entry missing any
 * field below.
 *
 * `contextWindow` is the window Codex reported for the tool turn, already net of its reserve,
 * so the entry keeps all of it. It decides whether Codex compacts the thread before the turn:
 * at 90% of it, slightly before the tool turn's own threshold. Without it the entry has no
 * window and Codex does not compact, as on a tool turn that reported none.
 *
 * A catalog entry's `multi_agent_version: v2` is persisted with the thread, so its
 * collaboration tools stay on the final request. The real-binary test in
 * `scope.boundary.test.ts` pins both on the bundled Codex.
 */
export function toolFreeModelCatalog(model: string, contextWindow: number | undefined): JsonValue {
  return {
    models: [
      {
        slug: model,
        display_name: model,
        supported_reasoning_levels: [],
        shell_type: 'disabled',
        visibility: 'hide',
        supported_in_api: false,
        priority: 0,
        support_verbosity: false,
        truncation_policy: { mode: 'tokens', limit: 10000 },
        experimental_supported_tools: [],
        base_instructions: '',
        ...(contextWindow !== undefined
          ? { context_window: contextWindow, effective_context_window_percent: 100 }
          : {}),
      },
    ],
  };
}

/**
 * Whether a structured-output turn on `model` runs its tools first and gets a separate
 * tool-free structured turn. Only a model Archon resolved can be matched.
 */
export function splitsStructuredOutput(
  config: CodexProviderDefaults,
  model: string | undefined
): boolean {
  return model !== undefined && (config.toolFreeStructuredOutputModels ?? []).includes(model);
}

/** The output schema a turn sends, and whether its final message is parsed as JSON. */
export function buildOutputSchema(requestOptions?: SendQueryOptions): {
  outputSchema: JsonValue | undefined;
  hasOutputFormat: boolean;
} {
  // Preserve the original precedence: an explicit `outputFormat` wins over
  // `nodeConfig.output_format` even when its `.schema` is undefined. Note the
  // resulting asymmetry: if `outputFormat` is set but `.schema` is undefined,
  // no schema is sent yet `hasOutputFormat` is still true — the final message
  // is still JSON.parsed.
  const rawSchema =
    requestOptions?.outputFormat !== undefined
      ? requestOptions.outputFormat.schema
      : requestOptions?.nodeConfig?.output_format;
  const hasOutputFormat = !!(
    requestOptions?.outputFormat ?? requestOptions?.nodeConfig?.output_format
  );
  if (rawSchema === undefined) return { outputSchema: undefined, hasOutputFormat };
  // OpenAI Structured Outputs strict-mode requires additionalProperties:false
  // on every object schema (HTTP 400 invalid_json_schema otherwise). Workflow
  // authors write portable output_format schemas, so normalize here before
  // handing the schema to Codex. See issue #1843.
  if (hasOpenAdditionalProperties(rawSchema)) {
    // The normalizer is about to rewrite an open-record `additionalProperties`
    // (e.g. `{ type: 'string' }` or `true`) to `false`. OpenAI would 400 the
    // open form anyway, but the author never declared a closed object — warn
    // so the silent narrowing is visible rather than a surprise at runtime.
    getLog().warn({ schema: rawSchema }, 'codex.output_format_open_record_closed');
  }
  return {
    outputSchema: toJsonValue(normalizeJsonSchemaForOpenAiStrict(rawSchema)),
    hasOutputFormat,
  };
}

/**
 * Fold the request/node-level systemPrompt into the user prompt, separated by the
 * same `---` delimiter augmentPromptForJsonSchema uses. See issue #1837.
 *
 * Precedence mirrors the Pi provider: request-level systemPrompt wins over
 * node-level, which wins over `appendSystemPrompt`. Codex cannot extend its
 * own system prompt, so appended instructions are folded in the same way.
 *
 * The prepend intentionally repeats on EVERY turn, including resumed
 * threads: the provider cannot know whether a resumed session's earlier
 * turns carried the instructions. This matches Claude, which receives the
 * systemPrompt on every query.
 */
export function buildEffectivePrompt(prompt: string, requestOptions?: SendQueryOptions): string {
  const raw =
    requestOptions?.systemPrompt ??
    requestOptions?.nodeConfig?.systemPrompt ??
    requestOptions?.appendSystemPrompt;
  if (raw === undefined) {
    return prompt;
  }
  const systemText = Array.isArray(raw) ? raw.join('\n\n') : raw;
  if (systemText.trim() === '') {
    return prompt;
  }
  return `${systemText}\n\n---\n\n${prompt}`;
}

/** The node's MCP file as Codex `mcp_servers`, with env expanded from the process and the request. */
export async function loadNodeMcpServers(
  mcpPath: string,
  cwd: string,
  requestEnv: Record<string, string> | undefined
): Promise<{ mcpServers: CodexConfig | undefined; warnings: ProviderWarning[] }> {
  const { servers, serverNames, missingVars } = await loadMcpConfig(mcpPath, cwd, {
    ...process.env,
    ...requestEnv,
  });
  const mcpServers = buildCodexMcpServers(servers);
  const missing = serverNames.find(name => !Object.hasOwn(mcpServers ?? {}, name));
  if (missing !== undefined) {
    throw new ClassifiedProviderError(
      'misconfigured',
      `Required MCP server "${missing}" has no supported Codex configuration fields`
    );
  }
  getLog().info({ serverNames, mcpPath }, 'codex.mcp_config_loaded');
  if (missingVars.length === 0) return { mcpServers, warnings: [] };
  const uniqueVars = [...new Set(missingVars)];
  getLog().warn({ missingVars: uniqueVars }, 'codex.mcp_env_vars_missing');
  return {
    mcpServers,
    warnings: [
      {
        code: 'codex.mcp_env_vars_missing',
        message: `MCP config references undefined env vars: ${uniqueVars.join(', ')}. These will be empty strings - MCP servers may fail to authenticate.`,
      },
    ],
  };
}
