import type { ForgeRequest } from '@archon/forge/operations';
import type { HelpGroup } from './types';

const forgeOperationDescriptions = {
  resolve: 'Resolve an explicit remote through optional forge plugins',
  'checks.state': 'Observe checks for an explicit qualified pull request',
  'checks.commit': 'Observe checks on a commit or on the default branch head',
  'workitem.view': 'Read a qualified work item',
  'workitem.create': 'Create an issue or recover its canonical marker',
  'workitem.labels.set': 'Set and verify the complete issue label set',
  'workitem.label.add': 'Add one label to an issue or pull request, keeping the rest',
  'workitem.label.remove': 'Remove one label from an issue or pull request, keeping the rest',
  'workitem.list': 'List open issues and pull requests that carry one label',
  'workitem.comment.upsert': 'Write the one marked comment on an issue or pull request',
  'workitem.close': 'Close an issue with a reason and verify the result',
  'workitem.edit-body': 'Replace an issue body and verify the result',
  'workitem.comments': 'Read every comment on an issue or pull request with its author',
  'repo.labels.list': 'List repository label names',
  'repo.label.ensure': 'Explicitly ensure one repository label exists',
  'pr.view': 'Read a pull request by number or by qualified head',
  'pr.create': 'Open a pull request and verify it by reading it back',
  'pr.edit-body': 'Replace a pull request body and verify the result',
  'pr.ready': 'Take a pull request out of draft and verify the result',
  'pr.draft': 'Convert a pull request to draft and verify the result',
  'pr.merge': 'Merge a pull request pinned to its approved head',
  'checks.rerun': 'Rerun selected failed checks at a revision',
  'pr.reviews': 'Read submitted reviews and root review comments',
  'pr.threads': 'Read every review thread with its comments and resolution',
  'pr.merge-state':
    'Read how far a pull request is behind the default branch and whether it merges',
  'pr.thread.reply': 'Reply on one review thread and verify the reply',
  'pr.thread.resolve': 'Resolve one review thread and verify the result',
  'comment.upsert': 'Write the one marked comment on a pull request',
} satisfies Record<ForgeRequest['op'], string>;

export const forgeHelp: HelpGroup = {
  entries: [
    {
      command: 'forge',
      subcommand: 'resolve',
      spec: 'forge resolve',
      description: forgeOperationDescriptions.resolve,
      scopedFlags: [
        {
          spec: '--data <json>',
          description: 'JSON object with remote (URL/SSH syntax or null)',
        },
      ],
    },
    {
      command: 'forge',
      subcommand: 'checks',
      spec: 'forge checks',
      description: forgeOperationDescriptions['checks.state'],
      scopedFlags: [
        {
          spec: '--data <json>',
          description: 'JSON object with ref: {repo: {host, path}, number}',
        },
      ],
    },
  ],
  scopedOnly: [
    {
      command: 'forge',
      subcommand: 'metadata',
      spec: 'forge metadata',
      description:
        'Inspect trusted plugin metadata for a host without credentials or forge operations',
      scopedFlags: [
        {
          spec: '--data <json>',
          description: 'JSON object with the forge host, for example {"host":"github.com"}',
        },
      ],
    },
    ...Object.entries(forgeOperationDescriptions)
      .filter(([op]) => op !== 'resolve')
      .map(([subcommand, description]) => ({
        command: 'forge',
        subcommand,
        spec: `forge ${subcommand}`,
        description,
        scopedFlags: [
          {
            spec: '--data <json>',
            description: 'Structured request without operationId or op',
          },
          {
            spec: '--data-file <path>',
            description: 'Read that request from a file, keeping authored content out of argv',
          },
        ],
      })),
  ],
};
