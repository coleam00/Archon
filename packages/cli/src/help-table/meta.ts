import type { HelpGroup } from './types';

export const metaHelp: HelpGroup = {
  entries: [
    {
      command: 'validate',
      subcommand: 'workflows',
      spec: 'validate workflows [name]',
      description: 'Validate workflow definitions and their references',
    },
    {
      command: 'validate',
      subcommand: 'commands',
      spec: 'validate commands [name]',
      description: 'Validate command files',
    },
    {
      command: 'version',
      spec: 'version, --version, -V',
      description: 'Show version info (also -v when used alone)',
    },
    { command: 'help', spec: 'help', description: 'Show this help message' },
  ],
};
