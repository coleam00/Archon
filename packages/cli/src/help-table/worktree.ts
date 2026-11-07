import type { HelpGroup } from './types';

export const worktreeHelp: HelpGroup = {
  entries: [
    {
      command: 'isolation',
      subcommand: 'list',
      spec: 'isolation list',
      description: 'List all active worktrees/environments',
    },
    {
      command: 'isolation',
      subcommand: 'cleanup',
      spec: 'isolation cleanup [days]',
      description:
        'Remove eligible worktrees by inactivity, containers by creation age (default: 7 days)',
    },
    {
      command: 'isolation',
      subcommand: 'cleanup',
      spec: 'isolation cleanup --merged',
      description: 'Remove worktrees covered by Git integration or a merged PR',
      scopedFlags: [
        {
          spec: '--merged',
          description: 'Remove worktrees covered by Git integration or a merged PR',
        },
        {
          spec: '--include-closed',
          description: 'Also remove worktrees covered by closed PRs',
        },
      ],
    },
    {
      command: 'complete',
      spec: 'complete <branch> [...]',
      description: 'Remove worktree and local branch; retain remote branch',
    },
  ],
};
