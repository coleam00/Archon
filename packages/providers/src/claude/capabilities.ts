import type { ProviderCapabilities } from '../types';

/**
 * Built-in Claude Code tool names, hand-audited against
 * @anthropic-ai/claude-agent-sdk 0.3.209. The SDK exposes tool restrictions as
 * plain `string[]` options and exports NO runtime tool-name constant or
 * literal union, so this list is maintained by hand — refresh it when bumping
 * the SDK. Used for advisory (warning-level) validation only, so a tool added
 * by a newer SDK before this list is refreshed can never break a workflow.
 */
const CLAUDE_KNOWN_TOOL_NAMES = [
  'Agent',
  'AskUserQuestion',
  'Bash',
  'Edit',
  'ExitPlanMode',
  'Glob',
  'Grep',
  'ListMcpResources',
  'NotebookEdit',
  'Read',
  'ReadMcpResource',
  'Skill',
  'SlashCommand',
  'TaskOutput',
  'TaskStop',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Write',
] as const;

/**
 * Tools the SDK renamed — a stale old name in allowed_tools/denied_tools is a
 * silent no-op at runtime (the trigger for #2084: `denied_tools: [Task]`
 * denied nothing after the 0.3.193 Task → Agent rename).
 */
const CLAUDE_RENAMED_TOOLS = {
  Task: 'Agent',
  BashOutput: 'TaskOutput',
  KillShell: 'TaskStop',
  MultiEdit: 'Edit',
} as const;

export const CLAUDE_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
  mcp: true,
  hooks: true,
  skills: true,
  agents: true,
  toolRestrictions: true,
  knownToolNames: CLAUDE_KNOWN_TOOL_NAMES,
  renamedTools: CLAUDE_RENAMED_TOOLS,
  structuredOutput: 'enforced', // SDK output_config.format grammar-constrains decoding
  envInjection: true,
  costControl: true,
  effortControl: true,
  thinkingControl: true,
  fallbackModel: true,
  sandbox: true,
  nativeTools: true,
};
