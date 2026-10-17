import type { BUILTIN_TOOL_NAMES } from '@anthropic-ai/claude-agent-sdk';
import type { SkillDiscovery } from '@archon/provider-contract';
import type { ProviderCapabilities } from '../types';

/**
 * The SDK's `BUILTIN_TOOL_NAMES`, spelled out because the descriptor is read by
 * hosts that never load the SDK runtime. The type annotation makes type-check
 * fail when the SDK's list changes. Used for advisory (warning-level)
 * validation only, so a missing name can never break a workflow.
 */
const CLAUDE_KNOWN_TOOL_NAMES: typeof BUILTIN_TOOL_NAMES = [
  'Agent',
  'Artifact',
  'AskUserQuestion',
  'Bash',
  'ClaudeDesign',
  'CronCreate',
  'CronDelete',
  'CronList',
  'Edit',
  'EndConversation',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitPlanMode',
  'ExitWorktree',
  'Glob',
  'Grep',
  'ListAgents',
  'ListMcpResourcesTool',
  'LSP',
  'Monitor',
  'NotebookEdit',
  'OfferChromeSetup',
  'PowerShell',
  'Projects',
  'propose_skills',
  'ProposeGoal',
  'PushNotification',
  'Read',
  'ReadMcpResourceDirTool',
  'ReadMcpResourceTool',
  'ReadNotifications',
  'RemoteTrigger',
  'ReportFindings',
  'ScheduleWakeup',
  'SendFeedback',
  'SendMessage',
  'SendUserFile',
  'SendUserMessage',
  'ShareOnboardingGuide',
  'ShowOnboardingRolePicker',
  'Skill',
  'SubagentHandback',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskStop',
  'TaskUpdate',
  'TodoWrite',
  'ToolSearch',
  'WaitForMcpServers',
  'WebFetch',
  'WebSearch',
  'Workflow',
  'Write',
];

/**
 * The SDK's `LEGACY_TOOL_NAME_ALIASES` (old name → current name), spelled out
 * for the same reason; `capabilities.test.ts` fails when they differ. A stale
 * old name in allowed_tools/denied_tools is a silent no-op at runtime (#2084:
 * `denied_tools: [Task]` denied nothing after the Task → Agent rename).
 */
const CLAUDE_RENAMED_TOOLS: Readonly<Record<string, string>> = {
  Task: 'Agent',
  KillShell: 'TaskStop',
  KillBash: 'TaskStop',
  ListPeers: 'ListAgents',
  Brief: 'SendUserMessage',
  ListMcpResources: 'ListMcpResourcesTool',
  ReadMcpResource: 'ReadMcpResourceTool',
  ReadMcpResourceDir: 'ReadMcpResourceDirTool',
};

export const CLAUDE_CAPABILITIES: ProviderCapabilities = {
  backgroundWork: 'reported',
  sessionResume: true,
  sessionFork: true,
  mcp: true,
  hooks: true,
  skills: true,
  plugins: true, // workflow nodes load only the plugins they name (claude/plugins.ts)
  agents: true,
  toolRestrictions: true,
  knownToolNames: CLAUDE_KNOWN_TOOL_NAMES,
  renamedTools: CLAUDE_RENAMED_TOOLS,
  structuredOutput: 'enforced', // SDK output_config.format grammar-constrains decoding
  requiresAllPropertiesRequired: false, // Claude accepts optional-by-omission (no strict-mode required-coverage rule)
  envInjection: true,
  costControl: true,
  costReporting: true, // SDK resultMsg.total_cost_usd reaches the result chunk
  tokenReporting: true,
  stopReasonReporting: true,
  turnCountReporting: true,
  resolvedModelReporting: true,
  effortControl: true,
  fallbackModel: true,
  sandbox: true,
  settingSources: true, // per-node override of the SDK's settingSources option
  nativeTools: true,
  containerExec: true, // spawns the CLI in-container via spawnClaudeCodeProcess
};

/** Claude Code's native skill roots: it never discovers `.agents/skills`. */
export const CLAUDE_SKILL_DISCOVERY = {
  project: ['.claude/skills'],
  user: ['skills'],
  userDirectory: { env: 'CLAUDE_CONFIG_DIR', home: '.claude' },
} satisfies SkillDiscovery;
