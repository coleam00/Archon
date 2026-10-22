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
      description: 'Remove stale environments (default: 7 days)',
    },
    {
      command: 'isolation',
      subcommand: 'cleanup',
      spec: 'isolation cleanup --merged',
      description: 'Remove environments with branches merged into the base branch',
      scopedFlags: [
        {
          spec: '--merged',
          description: 'Remove environments with branches merged into the base branch',
        },
        {
          spec: '--include-closed',
          description: 'Also remove environments whose PRs were closed without merging',
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
