import type { HelpGroup } from './types';

export const stateHelp: HelpGroup = {
  entries: [
    {
      command: 'state',
      spec: 'state <get|put|patch|log|delete|list|claim>',
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
      spec: 'state put <name> --if-revision <n> [--raw] [--lease|--release-lease] [--held]',
      description:
        "Replace the value with JSON (or --raw text) from stdin; 0 creates it. In a run, --lease takes the document's lease and --release-lease gives it back in the same write; --held refuses the write unless the run holds the live lease",
    },
    {
      command: 'state',
      subcommand: 'patch',
      spec: 'state patch <name> [--if-revision <n>] [--lease|--release-lease] [--held]',
      description:
        'Apply {ops:[...]} from stdin to the latest value, or only to revision n; lease flags and --held as for put',
    },
    {
      command: 'state',
      subcommand: 'delete',
      spec: 'state delete <name> [--if-revision <n>] [--held]',
      description: 'Append an audited tombstone; --held as for put',
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
    {
      command: 'state',
      subcommand: 'claim',
      spec: 'state claim',
      description:
        'In a run: take the lease of the first document in [{name, ifRevision}, ...] from stdin that is still at that revision and not leased by a live run; exits 2 when none is',
    },
  ],
};
