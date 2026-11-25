import { cliForgeJsonSchemas } from '@archon/forge';
import type { ForgeRequest } from '@archon/forge/operations';
import { forgeRequestHelp } from './forge-request';
import type { HelpEntry, HelpGroup } from './types';

const forgeOperationDescriptions = {
  resolve: 'Resolve an explicit remote through optional forge plugins',
  'checks.state': 'Observe checks for an explicit qualified pull request',
  'checks.commit': 'Observe checks on a commit or on the default branch head',
  'checks.logs': "Read the end of one check unit's log",
  'workitem.view': 'Read a qualified work item',
  'workitem.create': 'Create an issue or recover its canonical marker',
  'workitem.labels.set': 'Set and verify the complete issue label set',
  'workitem.label.add': 'Add one label to an issue or pull request, keeping the rest',
  'workitem.label.remove': 'Remove one label from an issue or pull request, keeping the rest',
  'workitem.list': 'List open issues and pull requests that carry one label',
  'workitem.label.added': 'Read when a label was last added to an issue or pull request',
  'workitem.search': 'Search issues and pull requests in a repository by text',
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
  'pr.close': 'Close a pull request without merging and verify the result',
  'pr.merge': 'Merge a pull request pinned to its approved head',
  'checks.rerun': 'Rerun selected failed checks at a revision',
  'pr.reviews': 'Read submitted reviews and root review comments',
  'pr.threads': 'Read every review thread with its comments, creation times and resolution',
  'pr.merge-state':
    'Read how far a pull request is behind its base branch and whether it merges into it',
  'pr.files': 'Read every file a pull request changes, with its patch',
  'repo.file': "Read one file's text at a commit",
  'pr.thread.reply': 'Reply on one review thread and verify the reply',
  'pr.thread.resolve': 'Resolve one review thread and verify the result',
  'pr.review.submit':
    'Submit a comment review with inline findings at one commit (presentation, not a gate)',
  'attachment.put': 'Store an image in the repository and return a link a comment can embed',
  'comment.upsert': 'Write the one marked comment on a pull request',
} satisfies Record<ForgeRequest['op'], string>;

const requestSchemas = new Map(
  cliForgeJsonSchemas().operations.map(({ op, request }) => [op, request])
);

const dataFlags: HelpEntry['scopedFlags'] = [
  {
    spec: '--data <json>',
    description: 'Structured request without operationId or op',
  },
  {
    spec: '--data-file <path>',
    description: 'Read that request from a file, keeping authored content out of argv',
  },
];

/** A forge entry whose request block comes from the operation's schema. */
function forgeEntry(subcommand: string, description: string, op = subcommand): HelpEntry {
  const schema = requestSchemas.get(op);
  if (schema === undefined) throw new Error(`forge operation ${op} declares no request schema`);
  return {
    command: 'forge',
    subcommand,
    spec: `forge ${subcommand}`,
    description,
    scopedFlags: dataFlags,
    request: forgeRequestHelp(subcommand, schema),
  };
}

export const forgeHelp: HelpGroup = {
  entries: [
    forgeEntry('resolve', forgeOperationDescriptions.resolve),
    forgeEntry('checks', forgeOperationDescriptions['checks.state'], 'checks.state'),
  ],
  scopedOnly: [
    forgeEntry(
      'metadata',
      'Inspect trusted plugin metadata for a host without credentials or forge operations'
    ),
    forgeEntry(
      'check',
      'Check before a run spends that a plugin serves a host, supports the named\noperations and has a credential; for a remote or repo whose plugin serves\npr.view, one pr.view by head proves the forge accepts the credential, so it\nneeds pull-request read on the repository. Exits 1 with the reason'
    ),
    ...Object.entries(forgeOperationDescriptions)
      .filter(([op]) => op !== 'resolve')
      .map(([op, description]) => forgeEntry(op, description)),
  ],
};
