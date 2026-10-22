import type { HelpGroup } from './types';

export const stateHelp: HelpGroup = {
  entries: [
    {
      command: 'state',
      spec: 'state <get|put|patch|log|delete|list>',
      description: 'Read and audit durable project or install JSON documents',
      scopedFlags: [
        { spec: '--install', description: 'Use install scope instead of a project' },
        {
          spec: '--project <key>',
          description: 'Outside a run: the project key (owner/repo) instead of the cwd project',
        },
      ],
    },
  ],
  scopedOnly: [
    {
      command: 'state',
      subcommand: 'get',
      spec: 'state get <name> [--raw]',
      description: 'Read the latest value and revision as JSON; --raw prints a text value',
    },
    {
      command: 'state',
      subcommand: 'put',
      spec: 'state put <name> --if-revision <n> [--raw]',
      description: 'Replace the value with JSON (or --raw text) from stdin; 0 creates it',
    },
    {
      command: 'state',
      subcommand: 'patch',
      spec: 'state patch <name> [--if-revision <n>]',
      description: 'Apply {ops:[...]} from stdin to the latest value, or only to revision n',
    },
    {
      command: 'state',
      subcommand: 'delete',
      spec: 'state delete <name> [--if-revision <n>]',
      description: 'Append an audited tombstone',
    },
    {
      command: 'state',
      subcommand: 'log',
      spec: 'state log <name> [--limit <n>]',
      description: 'Read revisions newest first, including writers and operations',
    },
    {
      command: 'state',
      subcommand: 'list',
      spec: 'state list [--prefix <p>] [--values]',
      description:
        'List document names with their latest revision and writer; --values returns live documents with values',
    },
  ],
};
