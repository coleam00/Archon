import { createLogger } from '@archon/paths';

import type { NodeConfig } from '../../types';

import { parseModelRef } from './config';

export type AgentConfig = NonNullable<NonNullable<NodeConfig['agents']>[string]>;

export interface NamedAgentConfig {
  key: string;
  opencodeAgentName: string;
  config: AgentConfig;
}

let cachedLog: ReturnType<typeof createLogger> | undefined;

function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.opencode');
  return cachedLog;
}

let warnedMultipleAgents = false;

export function listNamedAgents(
  agents: Record<string, AgentConfig> | undefined
): NamedAgentConfig[] {
  if (!agents) return [];
  return Object.entries(agents).map(([key, config]) => ({
    key,
    opencodeAgentName: `archon-${toKebabCase(key)}`,
    config,
  }));
}

export function hasMultipleAgents(agents: Record<string, AgentConfig> | undefined): boolean {
  return listNamedAgents(agents).length > 1;
}

export function getOrderedAgents(nodeConfig?: NodeConfig): NamedAgentConfig[] {
  return listNamedAgents(nodeConfig?.agents);
}

export function selectSingleAgent(
  agents: Record<string, AgentConfig> | undefined
): NamedAgentConfig | undefined {
  const namedAgents = listNamedAgents(agents);
  if (namedAgents.length === 0) return undefined;
  if (namedAgents.length > 1 && !warnedMultipleAgents) {
    warnedMultipleAgents = true;
    getLog().warn(
      { agents: namedAgents.map(a => a.key), selected: namedAgents[0]?.key },
      'opencode.multiple_agents_configured_using_first'
    );
  }
  return namedAgents[0];
}

export function adaptNamedAgentForOpencode(agent: NamedAgentConfig): {
  agent: string;
  model?: { providerID: string; modelID: string };
  tools?: Record<string, boolean>;
} {
  const adaptedConfig: {
    agent: string;
    model?: { providerID: string; modelID: string };
    tools?: Record<string, boolean>;
  } = {
    agent: agent.opencodeAgentName,
  };

  if (agent.config.model) {
    const parsedModel = parseModelRef(agent.config.model);
    if (!parsedModel) {
      throw new Error(
        `Invalid OpenCode agent model ref for '${agent.key}': '${agent.config.model}'. Expected format '<provider>/<model>' (for example 'anthropic/claude-3-5-sonnet').`
      );
    }
    adaptedConfig.model = parsedModel;
  }

  const tools = buildToolsPermissionsMap(agent.config.tools, agent.config.disallowedTools);
  if (tools) {
    adaptedConfig.tools = tools;
  }

  return adaptedConfig;
}

export function resolvePromptForAgent(
  _agent: NamedAgentConfig | undefined,
  nodePrompt: string
): string {
  // The agent's prompt is materialized into .opencode/agents/*.md as its
  // system context. OpenCode automatically loads it when the agent is referenced
  // by name. The node prompt is the user's task — sending the agent prompt here
  // would duplicate it (once in the agent file, once in the prompt body).
  return nodePrompt;
}

/**
 * @deprecated Use selectSingleAgent instead. Kept for backward compatibility.
 */
export function selectPrimaryAgent(agents: Record<string, AgentConfig>): string | undefined {
  const selected = selectSingleAgent(agents);
  return selected?.key;
}

/**
 * @deprecated Use adaptNamedAgentForOpencode instead. Kept for backward compatibility.
 */
export function adaptAgentConfigForOpencode(nodeConfig?: NodeConfig):
  | {
      agent?: string;
      model?: { providerID: string; modelID: string };
      tools?: Record<string, boolean>;
    }
  | undefined {
  const agents = nodeConfig?.agents;
  if (!agents) return undefined;

  const selected = selectSingleAgent(agents);
  if (!selected) return undefined;

  return adaptNamedAgentForOpencode(selected);
}

export function toKebabCase(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function buildToolsPermissionsMap(
  allowed?: string[],
  denied?: string[]
): Record<string, boolean> | undefined {
  const toolsPermissions: Record<string, boolean> = {};

  for (const tool of allowed ?? []) {
    toolsPermissions[tool] = true;
  }

  for (const tool of denied ?? []) {
    toolsPermissions[tool] = false;
  }

  return Object.keys(toolsPermissions).length > 0 ? toolsPermissions : undefined;
}
