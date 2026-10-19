/**
 * Workflow nodeConfig → Claude SDK options. A non-empty nodeId marks the workflow
 * path, which is a declared-only capability boundary; partial non-workflow configs
 * keep ambient SDK behavior.
 */
import type { HookCallbackMatcher, Options } from '@anthropic-ai/claude-agent-sdk';
import { clampEffort, declaredSkillRoots, type AssertNever } from '@archon/provider-contract';
import { createLogger } from '@archon/paths';
import {
  findInstalledSkillNames,
  resolveSkillDirectoriesFromRoots,
  skillSearchRoots,
} from '@archon/paths/skills';
import type { NodeConfig, ProviderWarning } from '../types';
import { loadMcpConfig } from '../mcp/config';
import { ClassifiedProviderError } from '../shared/failure';
import { CLAUDE_SKILL_DISCOVERY } from './capabilities';
import { buildClaudePluginSettings } from './plugins';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.claude');
  return cachedLog;
}

/** The reasoning-depth rungs `Options['effort']` accepts. Typed against the SDK
 *  so a vocabulary change upstream fails type-check here. */
const CLAUDE_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly NonNullable<Options['effort']>[];

/** Coverage, which `satisfies` above cannot express — a rung the SDK gains must
 *  be added here rather than silently clamped away. See `AssertNever`. */
export type ClaudeEffortsAreComplete = AssertNever<
  Exclude<NonNullable<Options['effort']>, (typeof CLAUDE_EFFORTS)[number]>
>;

// ─── SDK Hooks Building (absorbed from dag-executor) ───────────────────────

/** YAML hook matcher shape (matches @archon/workflows/schemas/dag-node WorkflowNodeHooks) */
interface YAMLHookMatcher {
  matcher?: string;
  response: unknown;
  timeout?: number;
}

type SDKHooksMap = Partial<
  Record<
    string,
    {
      matcher?: string;
      hooks: ((
        input: unknown,
        toolUseID: string | undefined,
        options: { signal: AbortSignal }
      ) => Promise<unknown>)[];
      timeout?: number;
    }[]
  >
>;

/**
 * Convert declarative YAML hook definitions to SDK HookCallbackMatcher arrays.
 */
export function buildSDKHooksFromYAML(
  nodeHooks: Record<string, YAMLHookMatcher[] | undefined>
): SDKHooksMap {
  const sdkHooks: SDKHooksMap = {};

  for (const [event, matchers] of Object.entries(nodeHooks)) {
    if (!matchers) continue;
    sdkHooks[event] = matchers.map(m => ({
      ...(m.matcher ? { matcher: m.matcher } : {}),
      hooks: [async (): Promise<unknown> => m.response],
      ...(m.timeout ? { timeout: m.timeout } : {}),
    }));
  }

  if (Object.keys(sdkHooks).length === 0) {
    getLog().warn(
      { nodeHooksKeys: Object.keys(nodeHooks) },
      'claude.hooks_build_produced_empty_map'
    );
  }

  return sdkHooks;
}

// ─── NodeConfig → SDK Options Translation ──────────────────────────────────

/** A non-empty nodeId marks a workflow node, the declared-only capability path. */
export function isWorkflowNode(nodeConfig: NodeConfig | undefined): nodeConfig is NodeConfig {
  return typeof nodeConfig?.nodeId === 'string' && nodeConfig.nodeId.trim().length > 0;
}

/** Where declared skills are searched, derived from the node's effective setting sources. */
export interface SkillSearch {
  env: Record<string, string | undefined>;
  includeProject: boolean;
  includeUser: boolean;
  isContainer: boolean;
}

/**
 * Translate nodeConfig into Claude SDK-specific options.
 * Called inside sendQuery when nodeConfig is present. A non-empty nodeId marks
 * the workflow path; partial non-workflow configs keep ambient SDK behavior.
 * Returns structured warnings that the caller yields as `warning` events.
 */
export async function applyNodeConfig(
  options: Options,
  nodeConfig: NodeConfig,
  cwd: string,
  skillSearch: SkillSearch,
  listInstalledPluginIds: () => Promise<string[]>
): Promise<ProviderWarning[]> {
  const warnings: ProviderWarning[] = [];
  const workflowNode = isWorkflowNode(nodeConfig);
  if (workflowNode) {
    warnings.push(
      ...(await applyWorkflowCapabilityScope(
        options,
        nodeConfig,
        cwd,
        skillSearch,
        listInstalledPluginIds
      ))
    );
  }

  // `Skill` is re-added only on the workflow path, which is the only one that
  // narrows `options.skills`; adding it for a non-workflow caller would expose
  // the ambient catalog instead of a declared subset.
  const selectsSkills = workflowNode && (nodeConfig.skills?.length ?? 0) > 0;
  applyToolLists(options, nodeConfig, selectsSkills);
  if (nodeConfig.hooks) mergeNodeHooks(options, nodeConfig.hooks);
  if (nodeConfig.mcp) warnings.push(...(await applyMcpConfig(options, nodeConfig.mcp, cwd)));

  // Native skill selection. The SDK requires Skill to remain allowed when an
  // explicit tool list is present; without a list, its normal tool set applies.
  if (selectsSkills) {
    if (!options.allowedTools?.includes('Skill')) {
      options.allowedTools = [...(options.allowedTools ?? []), 'Skill'];
    }
    getLog().info({ skills: nodeConfig.skills }, 'claude.skills_selected');
  }

  // Inline agents remain sub-agents invokable through the Agent tool; native
  // skill selection does not replace the query's primary agent.
  if (nodeConfig.agents) {
    options.agents = {
      ...(options.agents ?? {}),
      ...(nodeConfig.agents as NonNullable<Options['agents']>),
    };
    getLog().info({ agentIds: Object.keys(nodeConfig.agents) }, 'claude.inline_agents_registered');
  }

  if (nodeConfig.effort !== undefined) applyEffort(options, nodeConfig.effort);
  applyPassThroughOptions(options, nodeConfig);
  return warnings;
}

/**
 * Workflow nodes are declared-only capability boundaries. Keep normal
 * project/user settings (CLAUDE.md, hooks, permissions), but exclude ambient
 * skills, MCP and plugins unless the workflow names them explicitly.
 */
async function applyWorkflowCapabilityScope(
  options: Options,
  nodeConfig: NodeConfig,
  cwd: string,
  skillSearch: SkillSearch,
  listInstalledPluginIds: () => Promise<string[]>
): Promise<ProviderWarning[]> {
  options.skills = nodeConfig.skills ?? [];
  options.strictMcpConfig = true;
  const namedPlugins = nodeConfig.plugins ?? [];
  const installedPluginIds = await listInstalledPluginIds();
  options.settings = buildClaudePluginSettings(installedPluginIds, namedPlugins);
  getLog().info(
    { nodeId: nodeConfig.nodeId, installed: installedPluginIds.length, named: namedPlugins },
    'claude.plugin_scope_applied'
  );

  if (!nodeConfig.skills || nodeConfig.skills.length === 0) return [];
  const roots = declaredSkillRoots(CLAUDE_SKILL_DISCOVERY, cwd, skillSearch);
  const { missing } = resolveSkillDirectoriesFromRoots(roots, nodeConfig.skills);
  if (missing.length === 0) return [];

  // Split by whether the name exists on disk at all. A skill that resolves
  // under some other root — `.agents/skills/`, or a scope this node's
  // settingSources disables — is installed but unreachable, so fail before
  // spend with the exact remediation. A name that resolves nowhere may be
  // one of Claude's built-in or `plugin:skill` entries, which live outside
  // every filesystem root: the SDK is the authority on those, so warn
  // rather than block a capability Claude genuinely provides.
  const unreachable = findInstalledSkillNames(
    [
      ...skillSearchRoots(cwd),
      ...declaredSkillRoots(CLAUDE_SKILL_DISCOVERY, cwd, { env: skillSearch.env }),
    ],
    missing
  );
  if (unreachable.length > 0) {
    getLog().error(
      { nodeId: nodeConfig.nodeId, unreachable, roots },
      'claude.declared_skills_unreachable'
    );
    throw unreachableSkillsError(unreachable, skillSearch);
  }

  getLog().warn({ nodeId: nodeConfig.nodeId, missing, roots }, 'claude.declared_skills_unresolved');
  return [
    {
      code: 'claude.skills_unresolved',
      message: `Claude skill${missing.length === 1 ? '' : 's'} not found on disk: ${missing.join(', ')}. This is expected for Claude's built-in skills and for plugin-qualified names (plugin:skill), which the SDK resolves itself; a plugin's skill loads only when the node also names that plugin under plugins:. If you meant an installed skill, check the name — an unknown name is ignored rather than loaded.`,
    },
  ];
}

function unreachableSkillsError(
  unreachable: string[],
  skillSearch: SkillSearch
): ClassifiedProviderError {
  const enabledRoots = [
    ...(skillSearch.includeProject ? ['project-local .claude/skills/'] : []),
    ...(skillSearch.includeUser ? ['the effective Claude config directory skills/'] : []),
  ];
  const installLocation =
    enabledRoots.length > 0
      ? enabledRoots.join(' or ')
      : 'an enabled Claude setting source (effective settingSources currently enables none)';
  const containerNote = skillSearch.isContainer
    ? ' Container workflows cannot use host user-global skills.'
    : '';
  return new ClassifiedProviderError(
    'misconfigured',
    `Claude skill${unreachable.length === 1 ? '' : 's'} not found in an enabled Claude-native skill directory: ${unreachable.join(', ')}. Install ${unreachable.length === 1 ? 'it' : 'them'} under ${installLocation}.${containerNote}`
  );
}

/** allowed_tools → tools, denied_tools → disallowedTools. */
function applyToolLists(options: Options, nodeConfig: NodeConfig, selectsSkills: boolean): void {
  if (nodeConfig.allowed_tools !== undefined) {
    options.tools = selectsSkills
      ? [...new Set([...nodeConfig.allowed_tools, 'Skill'])]
      : nodeConfig.allowed_tools;
  }
  if (nodeConfig.denied_tools !== undefined) {
    options.disallowedTools = nodeConfig.denied_tools;
  }
}

/** Node hooks run before the existing hooks (the PostToolUse capture hook) of the same event. */
function mergeNodeHooks(options: Options, nodeHooks: NonNullable<NodeConfig['hooks']>): void {
  const builtHooks = buildSDKHooksFromYAML(
    nodeHooks as Record<string, YAMLHookMatcher[] | undefined>
  );
  if (Object.keys(builtHooks).length === 0) return;
  const existingHooks = options.hooks as SDKHooksMap | undefined;
  if (!options.hooks) {
    (options as Record<string, unknown>).hooks = {};
  }
  const hooks = options.hooks as Record<string, HookCallbackMatcher[]>;
  for (const [event, matchers] of Object.entries(builtHooks)) {
    if (!matchers) continue;
    const existing = existingHooks?.[event] as HookCallbackMatcher[] | undefined;
    hooks[event] = existing
      ? [...(matchers as HookCallbackMatcher[]), ...existing]
      : (matchers as HookCallbackMatcher[]);
  }
}

/** mcp → load config and set mcpServers + allowedTools wildcards. */
async function applyMcpConfig(
  options: Options,
  mcpPath: string,
  cwd: string
): Promise<ProviderWarning[]> {
  const warnings: ProviderWarning[] = [];
  const { servers, serverNames, missingVars } = await loadMcpConfig(mcpPath, cwd);
  options.mcpServers = servers as Options['mcpServers'];
  const mcpWildcards = serverNames.map(name => `mcp__${name}__*`);
  options.allowedTools = [...(options.allowedTools ?? []), ...mcpWildcards];
  getLog().info({ serverNames, mcpPath }, 'claude.mcp_config_loaded');
  if (missingVars.length > 0) {
    const uniqueVars = [...new Set(missingVars)];
    getLog().warn({ missingVars: uniqueVars }, 'claude.mcp_env_vars_missing');
    warnings.push({
      code: 'claude.mcp_env_vars_missing',
      message: `MCP config references undefined env vars: ${uniqueVars.join(', ')}. These will be empty strings — MCP servers may fail to authenticate.`,
    });
  }
  // Haiku models don't support tool search (lazy loading for many tools)
  if (options.model?.toLowerCase().includes('haiku')) {
    getLog().warn({ model: options.model }, 'claude.mcp_haiku_tool_search_unsupported');
    warnings.push({
      code: 'claude.mcp_haiku_tool_search',
      message:
        'Using Haiku model with MCP servers — tool search (lazy loading for many tools) is not supported on Haiku. Consider using Sonnet or Opus.',
    });
  }
  return warnings;
}

/**
 * Effort is clamped into the SDK's own vocabulary. Claude has no `minimal`,
 * `ultra`, or `persistent` rung, so they become its shallowest (`low`) and
 * deepest (`max`) values respectively.
 */
function applyEffort(options: Options, declared: NonNullable<NodeConfig['effort']>): void {
  const effort = clampEffort(declared, CLAUDE_EFFORTS);
  if (effort === undefined) {
    getLog().warn({ effort: declared }, 'claude.effort_unrecognized');
    return;
  }
  if (effort !== declared) {
    getLog().debug({ declared, applied: effort }, 'claude.effort_clamped');
  }
  options.effort = effort;
}

/** Fields that map onto an SDK option of the same meaning; a node value overrides the base option. */
function applyPassThroughOptions(options: Options, nodeConfig: NodeConfig): void {
  if (nodeConfig.sandbox !== undefined) {
    options.sandbox = nodeConfig.sandbox as Options['sandbox'];
  }
  if (nodeConfig.betas !== undefined) {
    options.betas = nodeConfig.betas as Options['betas'];
  }
  if (nodeConfig.output_format) {
    options.outputFormat = {
      type: 'json_schema',
      schema: nodeConfig.output_format,
    } as Options['outputFormat'];
  }
  if (nodeConfig.maxBudgetUsd !== undefined) {
    options.maxBudgetUsd = nodeConfig.maxBudgetUsd;
  }
  if (nodeConfig.systemPrompt !== undefined) {
    options.systemPrompt = nodeConfig.systemPrompt;
  }
  if (nodeConfig.fallbackModel !== undefined) {
    options.fallbackModel = nodeConfig.fallbackModel;
  }

  // Phase 4 of #975 — enable AI-generated progress summaries for subagents
  // spawned by workflow nodes. Without this, `task_progress` events arrive
  // every ~30s with just `description` + `last_tool_name`; with it, the SDK
  // forks the subagent's session every ~30s to produce a short present-tense
  // `summary` (e.g. "Analyzing auth module"). The fork reuses the subagent's
  // model + prompt cache, so cost stays minimal. Only workflow nodes opt in —
  // direct chat calls (no nodeConfig) skip this to keep the chat surface
  // unchanged. Authors can still override per-node by setting
  // `agentProgressSummaries: false` in nodeConfig.
  options.agentProgressSummaries =
    nodeConfig.agentProgressSummaries !== undefined ? nodeConfig.agentProgressSummaries : true;
}
