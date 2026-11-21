import type { HelpGroup } from './types';

export const trackerHelp: HelpGroup = {
  entries: [
    {
      command: 'tracker',
      subcommand: 'sync',
      spec: 'tracker sync',
      description:
        "Bring every tracked project's item tracker up to date in one pass (no server needed)",
    },
    {
      command: 'tracker',
      subcommand: 'release',
      spec: 'tracker release <project>',
      description:
        "Let go of a project's tracker pass held by a process this host cannot prove gone",
    },
  ],
};
