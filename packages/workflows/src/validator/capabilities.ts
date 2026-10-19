import type { DagNode } from '../schemas';
import { findSimilar } from '../utils/fuzzy-match';
import type { NodeValidation, ResourceValidation } from './context';
import type { ValidationIssue } from './types';

type ProviderCapabilities = NonNullable<NodeValidation['capabilities']>;

/**
 * Node fields the provider cannot honor. Plugins are an error like mcp and skills — the
 * engine refuses to run them. Hooks, inline agents and tool restrictions are warnings:
 * the provider ignores them.
 */
export function validateProviderCapabilities(
  validation: ResourceValidation,
  { node, provider, capabilities }: NodeValidation
): void {
  const { issues } = validation;
  if ('plugins' in node && node.plugins?.length && capabilities?.plugins === false) {
    issues.push({
      level: 'error',
      nodeId: node.id,
      field: 'plugins',
      message: `Provider '${provider}' cannot load named plugins — the run would fail before any node starts`,
      hint: 'Remove the plugins field or switch to a provider whose plugins capability is true',
    });
  }
  if (!capabilities) return;

  if ('hooks' in node && node.hooks && !capabilities.hooks) {
    issues.push({
      level: 'warning',
      nodeId: node.id,
      field: 'hooks',
      message: `Hooks are not supported by provider '${provider}' — this will be ignored`,
      hint: 'Remove the hooks field or switch to a provider that supports hooks',
    });
  }

  if ('agents' in node && node.agents && !capabilities.agents) {
    issues.push({
      level: 'warning',
      nodeId: node.id,
      field: 'agents',
      message: `Inline agents are not supported by provider '${provider}' — this will be ignored`,
      hint: 'Remove the agents field or switch to a provider that supports inline agents (e.g. claude)',
    });
  }

  if (!capabilities.toolRestrictions) {
    if (
      ('allowed_tools' in node && node.allowed_tools !== undefined) ||
      ('denied_tools' in node && node.denied_tools !== undefined)
    ) {
      issues.push({
        level: 'warning',
        nodeId: node.id,
        field: 'allowed_tools/denied_tools',
        message: `Tool restrictions are not supported by provider '${provider}' — this will be ignored`,
        hint: 'Remove tool restriction fields or switch to a provider that supports them',
      });
    }
  } else if (capabilities.knownToolNames !== undefined && capabilities.knownToolNames.length > 0) {
    validateToolNames(validation, node, provider, capabilities);
  }
}

/**
 * Warn on tool names outside the provider's audited built-in vocabulary
 * (#2084): the SDK matches names as opaque strings, so a misspelled or
 * stale name (e.g. `Task` after the Claude SDK renamed it to `Agent`)
 * is a silent no-op at runtime. Warning-level only — MCP tool names and
 * tools added by a newer SDK can't be proven invalid, so this must
 * never hard-fail validation. Providers without a declared vocabulary
 * skip the check entirely.
 */
function validateToolNames(
  validation: ResourceValidation,
  node: DagNode,
  provider: string | undefined,
  capabilities: ProviderCapabilities
): void {
  const toolLists = [
    ['allowed_tools', 'allowed_tools' in node ? node.allowed_tools : undefined],
    ['denied_tools', 'denied_tools' in node ? node.denied_tools : undefined],
  ] as const;
  for (const [field, entries] of toolLists) {
    for (const entry of entries ?? []) {
      const issue = toolNameIssue(node.id, entry, field, provider, capabilities);
      if (issue !== undefined) validation.issues.push(issue);
    }
  }
}

function toolNameIssue(
  nodeId: string,
  entry: string,
  field: 'allowed_tools' | 'denied_tools',
  provider: string | undefined,
  capabilities: ProviderCapabilities
): ValidationIssue | undefined {
  const known = capabilities.knownToolNames ?? [];
  // Permission-rule specifiers wrap a base name: `Bash(git:*)` → `Bash`.
  const base = entry.split('(')[0].trim();
  // MCP tool names (mcp__server, mcp__server__tool, mcp__server__*)
  // are dynamic per-install — never flag them.
  if (base === '' || base.startsWith('mcp__') || known.includes(base)) return undefined;

  const renamed = capabilities.renamedTools?.[base];
  if (renamed !== undefined) {
    return {
      level: 'warning',
      nodeId,
      field,
      message: `Tool '${base}' was renamed to '${renamed}' in the ${provider} SDK — the old name is silently ignored at runtime`,
      hint: `Replace '${base}' with '${renamed}' in ${field}`,
      suggestions: [renamed],
    };
  }

  const similar = findSimilar(base, [...known]);
  const issue: ValidationIssue = {
    level: 'warning',
    nodeId,
    field,
    message: `Unknown tool '${base}' for provider '${provider}' — unrecognized names are silently ignored at runtime`,
    hint: 'Use a built-in tool name, or the mcp__<server>__<tool> form for MCP tools',
  };
  if (similar.length > 0) {
    issue.hint = `Did you mean: ${similar.map(s => `'${s}'`).join(', ')}? (MCP tools use the mcp__<server>__<tool> form)`;
    issue.suggestions = similar;
  }
  return issue;
}
