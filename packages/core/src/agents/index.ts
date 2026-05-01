/**
 * @archon/core/agents — Claude Agent SDK agent registry.
 *
 * Pure filesystem CRUD over `~/.claude/agents/<name>.md` (global) and
 * `<cwd>/.claude/agents/<name>.md` (project). Used by the server's REST API
 * to power the Web UI agent registry.
 */

export type {
  AgentSource,
  AgentStatus,
  AgentSummary,
  AgentDetail,
  AgentLoadError,
  AgentDiscoveryResult,
} from './types';
export { AgentFrontmatterError, AgentNameError } from './types';

export {
  parseAgentMd,
  serializeAgentMd,
  validateAgentName,
  coerceStatus,
  coerceModel,
  coerceStringArray,
} from './frontmatter';

export { discoverAgents, getAgentPath, getAgentsSearchPaths } from './discovery';

export { readAgent, writeAgent, createAgent, deleteAgent } from './read-write';

export {
  readScaffoldTemplate,
  writeScaffoldTemplate,
  renderScaffold,
  getProjectTemplatePath,
  getGlobalTemplatePath,
  type TemplateLocation,
} from './template';
