import { userRoleSchema } from '@archon/core/schemas/user';
import type { HelpGroup } from './types';

export const operatorHelp: HelpGroup = {
  entries: [
    {
      command: 'user',
      spec: 'user <list|role|link>',
      description: 'List users, link identities and manage roles as the operator',
    },
    {
      command: 'project',
      subcommand: 'list',
      spec: 'project list',
      description: 'List registered projects (id, kind, name, key, path)',
    },
    {
      command: 'trigger',
      spec: 'trigger <fire|drain|list|inspect|withdraw|recover-preparation|schedule>',
      description: 'Start configured workflows and inspect durable resource admission',
    },
    { command: 'chat', spec: 'chat <message>', description: 'Send a message to the orchestrator' },
    {
      command: 'setup',
      spec: 'setup [--scope <home|project>]',
      description: 'Interactive setup wizard for credentials and config',
      scopedFlags: [
        {
          spec: '--scope <home|project>',
          description:
            'Write ~/.archon/.env (default) or <repo-root>/.archon/.env (requires a git repository)',
        },
      ],
    },
  ],
  scopedOnly: [
    {
      command: 'user',
      subcommand: 'list',
      spec: 'user list',
      description: 'List user ids, roles, display names and identities',
    },
    {
      command: 'user',
      subcommand: 'link',
      spec: 'user link <user-id> <platform>:<platform-user-id> [--move]',
      description: 'Link an identity to an existing user; --move reassigns a conflicting identity',
    },
    {
      command: 'user',
      subcommand: 'role',
      spec: `user role <id> <${userRoleSchema.options.join('|')}>`,
      description: 'Set a user role using the full user id',
    },
    {
      command: 'trigger',
      subcommand: 'list',
      spec: 'trigger list [--limit <1-1000>]',
      description: 'List recent safe receipt summaries (default 50)',
    },
    {
      command: 'trigger',
      subcommand: 'fire',
      spec: 'trigger fire --config <file> [--delivery-id <key>] [--inputs <file>]',
      description: 'Record a configured start and drain its execution host',
      scopedFlags: [
        {
          spec: '--delivery-id <key>',
          description: 'Deduplicate this delivery within the configured source',
        },
        { spec: '--inputs <file>', description: 'Read event input values from a JSON object' },
      ],
    },
    {
      command: 'trigger',
      subcommand: 'drain',
      spec: 'trigger drain --host <host-id>',
      description: 'Prepare persisted bindings and admit eligible queued work',
    },
    {
      command: 'trigger',
      subcommand: 'inspect',
      spec: 'trigger inspect <receipt-or-request-id>',
      description: 'Show causal receipt, disposition, blockers, and recovery guidance',
    },
    {
      command: 'trigger',
      subcommand: 'execute',
      spec: 'trigger execute <request-id> --host <host-id>',
      description: 'Explicitly claim and execute an admitted pending request',
    },
    {
      command: 'trigger',
      subcommand: 'withdraw',
      spec: 'trigger withdraw <queued-request-id>',
      description: 'Withdraw untouched queued work and release its captured source',
    },
    {
      command: 'trigger',
      subcommand: 'recover-preparation',
      spec: 'trigger recover-preparation <receipt> <binding> --owner <owner-id> --yes',
      description: 'Reset preparation after confirming its exact recorded owner has stopped',
    },
    {
      command: 'trigger',
      subcommand: 'schedule',
      spec: 'trigger schedule <install|remove> --config <file>',
      description: 'Manage the configured native macOS LaunchAgent',
    },
    {
      command: 'trigger',
      subcommand: 'whoami',
      spec: 'trigger whoami',
      description: 'Print the Archon user ID to use as a binding runAsUserId',
    },
  ],
};
