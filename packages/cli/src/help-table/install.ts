import { attachmentCommands } from '../attachment-commands';
import type { HelpEntry, HelpGroup } from './types';

function attachmentHelp(command: keyof typeof attachmentCommands, scopedOnly = false): HelpEntry[] {
  return Object.entries(attachmentCommands[command])
    .filter(([, entry]) => Object.hasOwn(entry, 'scopedOnly') === scopedOnly)
    .map(([subcommand, entry]) => ({
      command,
      subcommand,
      spec: `${command} ${subcommand} ${entry.args}`.trimEnd(),
      description: entry.description,
    }));
}

export const installHelp: HelpGroup = {
  entries: [
    {
      command: 'serve',
      spec: 'serve',
      description: 'Start the web UI server (binary installs download server and UI on first run)',
    },
    ...attachmentHelp('skill'),
    ...attachmentHelp('provider'),
    ...attachmentHelp('plugin'),
    {
      command: 'doctor',
      spec: 'doctor',
      description: 'Verify installed provider diagnostics, DB, and adapters',
    },
    {
      command: 'auth',
      subcommand: 'github',
      spec: 'auth github',
      description: 'Connect your GitHub identity via device flow (multi-user installs)',
    },
    {
      command: 'ai',
      subcommand: 'key',
      spec: 'ai key set <provider>',
      description:
        'Connect an AI provider API key (multi-user installs; key read from prompt/stdin)',
    },
    {
      command: 'ai',
      subcommand: 'login',
      spec: 'ai login <provider>',
      description: 'Connect a Claude, ChatGPT/Codex, or Copilot subscription',
    },
    {
      command: 'ai',
      subcommand: 'list',
      spec: 'ai list',
      description: 'List your connected AI provider keys',
    },
    {
      command: 'ai',
      subcommand: 'logout',
      spec: 'ai logout <provider>',
      description: 'Disconnect an AI provider key',
    },
    {
      command: 'ai',
      subcommand: 'tier',
      spec: 'ai tier set <t> <p> <m>',
      description:
        'Set a model tier (small/medium/large) → provider/model [--effort <e>] [--scope user|install]',
    },
    {
      command: 'ai',
      subcommand: 'tier',
      spec: 'ai tier list [--json]',
      description: 'Show configured tiers (install + yours) vs built-in defaults',
    },
    {
      command: 'ai',
      subcommand: 'tier',
      spec: 'ai tier unset <tier>',
      description: 'Unset a tier override (built-ins: claude/codex only) [--scope user|install]',
    },
    {
      command: 'ai',
      subcommand: 'alias',
      spec: 'ai alias set <@n> <p> <m>',
      description: 'Set a @custom model alias [--effort <e>] [--scope user|install]',
    },
    {
      command: 'ai',
      subcommand: 'alias',
      spec: 'ai alias list [--json]',
      description: 'Show configured @custom aliases (install + yours)',
    },
    {
      command: 'ai',
      subcommand: 'alias',
      spec: 'ai alias unset <@name>',
      description: 'Remove a @custom alias [--scope user|install]',
    },
    {
      command: 'ai',
      subcommand: 'capacity',
      spec: 'ai capacity [--json]',
      description: 'Show provider attempts holding concurrency.providers capacity',
    },
    {
      command: 'ai',
      subcommand: 'capacity',
      spec: 'ai capacity release <id>',
      description: 'Release a held attempt whose owner process you verified is gone',
    },
    {
      command: 'ai',
      subcommand: 'default',
      spec: 'ai default <p> [<model>]',
      description: 'Set the default assistant (+ chat model) [--scope user|install]',
    },
    {
      command: 'telemetry',
      subcommand: 'status',
      spec: 'telemetry status',
      description: 'Show anonymous telemetry state (enabled, reason, ID, host)',
    },
    {
      command: 'telemetry',
      subcommand: 'reset',
      spec: 'telemetry reset',
      description: 'Rotate the anonymous install UUID',
    },
    {
      command: 'telemetry',
      subcommand: 'no-match',
      spec: 'telemetry no-match',
      description: 'Record an agent decision that no workflow fits',
    },
  ],
  scopedOnly: [...attachmentHelp('plugin', true), ...attachmentHelp('skill', true)],
};
