import type { ProviderCapabilities } from '../types';

/**
 * Built-in Claude Code tool names. The SDK exposes tool restrictions as plain
 * `string[]` options and exports no tool-name constant or literal union, so this
 * list is maintained by hand. `capabilities.test.ts` fails when the installed
 * SDK's `sdk-tools.d.ts` declares a tool missing here. Used for advisory
 * (warning-level) validation only, so a missing name can never break a workflow.
 */
const CLAUDE_KNOWN_TOOL_NAMES = [
  'Agent',
  'Artifact',
  'AskUserQuestion',
  'Bash',
  'ClaudeDesign',
  'CronCreate',
  'CronDelete',
  'CronList',
  'Edit',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitPlanMode',
  'ExitWorktree',
  'Glob',
  'Grep',
  'ListMcpResourcesTool',
  'Monitor',
  'NotebookEdit',
  'PowerShell',
  'Projects',
  'ProposeGoal',
  'ProposeSkills',
  'PushNotification',
  'Read',
  'ReadMcpResourceDirTool',
  'ReadMcpResourceTool',
  'ReadNotifications',
  'RefreshMcpTools',
  'RemoteTrigger',
  'ReportFindings',
  'ScheduleWakeup',
  'SendFeedback',
  'ShowOnboardingRolePicker',
  'Skill',
  'SlashCommand',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskStop',
  'TaskUpdate',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Workflow',
  'Write',
] as const;

/**
 * Tools the SDK renamed — a stale old name in allowed_tools/denied_tools is a
 * silent no-op at runtime (the trigger for #2084: `denied_tools: [Task]`
 * denied nothing after the 0.3.193 Task → Agent rename).
 */
const CLAUDE_RENAMED_TOOLS = {
  Task: 'Agent',
  KillShell: 'TaskStop',
  MultiEdit: 'Edit',
} as const;

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
