/**
 * Help rendering — structured data plus a renderer. The data is split into
 * three tables so the global help output stays byte-identical to the
 * pre-refactor template literal (the original Commands block, Options block,
 * and Examples block are each hand-curated and do not follow a natural entry
 * iteration order).
 *
 * `commandHelp` lists one entry per Commands-block line in the order they
 * appear. `orderedFlags` lists every flag in the pre-refactor Options block
 * order, with `owners` naming each flag's (command, subcommand) tuples; an
 * empty `owners` array marks the flag as global (only in `archon --help`).
 * `orderedExamples` lists every example in the pre-refactor Examples block
 * order with the same owner model. `renderHelp(...)` selects entries and
 * filters the flag and example lists by owner for scoped slices.
 */

import { userRoleSchema } from '@archon/core/schemas/user';
import type { ForgeRequest } from '@archon/forge/operations';
import { attachmentCommands } from './attachment-commands';

interface FlagOwner {
  command: string;
  subcommand?: string;
}

interface FlagHelp {
  spec: string;
  description: string;
  // Each (command, subcommand?) tuple that owns this flag. Scoped-only flags
  // omit owners because their enclosing entry owns them; empty means "global".
  owners?: FlagOwner[];
}

interface ExampleHelp {
  text: string;
  // The (command, subcommand?) tuple this example belongs to. An example
  // appears in `archon --help` iff its owner is selected.
  owner: FlagOwner;
}

interface HelpEntry {
  command: string;
  subcommand?: string;
  spec: string;
  // Use `\n` to force a continuation line; each continuation aligns to
  // column 29. The renderer wraps to the next line when the spec itself
  // overflows the description column (spec.length > 35).
  description: string;
  // Scoped-only flags: shown in the matching `archon <cmd> [<subcmd>] --help`
  // slice but NOT in the global help. Used for flags the legacy template
  // literal documented via a Commands-block alias (e.g. `isolation cleanup
  // --merged`) rather than as a standalone Options entry, so the global
  // Options block stays byte-identical to the pre-refactor text while
  // scoped help can still surface every flag the entry actually accepts.
  scopedFlags?: FlagHelp[];
}

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

const forgeOperationDescriptions = {
  resolve: 'Resolve an explicit remote through optional forge plugins',
  'checks.state': 'Observe checks for an explicit qualified pull request',
  'workitem.view': 'Read a qualified work item',
  'workitem.create': 'Create an issue or recover its canonical marker',
  'workitem.labels.set': 'Set and verify the complete issue label set',
  'workitem.label.add': 'Add one label to an issue or pull request, keeping the rest',
  'workitem.label.remove': 'Remove one label from an issue or pull request, keeping the rest',
  'workitem.list': 'List open issues and pull requests that carry one label',
  'workitem.comment.upsert': 'Write the one marked comment on an issue or pull request',
  'workitem.close': 'Close an issue with a reason and verify the result',
  'workitem.edit-body': 'Replace an issue body and verify the result',
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
  'pr.thread.reply': 'Reply on one review thread and verify the reply',
  'pr.thread.resolve': 'Resolve one review thread and verify the result',
  'comment.upsert': 'Write the one marked comment on a pull request',
} satisfies Record<ForgeRequest['op'], string>;

// One entry per Commands-block line, in global-help order. `renderHelp()`
// returns the global index with no selection; `renderHelp(...)`
// filters this list by the (command, subcommand) tuple for scoped slices.
// Subcommands listed in `scopedOnlyHelp` below never render in the global
// Commands block, so global help stays byte-identical to the pre-refactor
// template literal while scoped slices can still surface every supported
// subcommand (`--detach` is owned by `workflow approve`/`reject`, which
// live here so the global Commands block does not grow).
const commandHelp: HelpEntry[] = [
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
    spec: 'setup',
    description: 'Interactive setup wizard for credentials and config',
  },
  {
    command: 'workflow',
    subcommand: 'list',
    spec: 'workflow list [name] [--full] [--json]',
    description: 'List compact workflow descriptions\nUse <name> --full for one exact description',
    scopedFlags: [
      {
        spec: '--full',
        description:
          'When given with a name, show the exact description instead of the compact preview',
      },
    ],
  },
  {
    command: 'workflow',
    subcommand: 'run',
    spec: 'workflow run <name> [msg]',
    description: 'Run a workflow with optional message',
  },
  {
    command: 'workflow',
    subcommand: 'status',
    spec: 'workflow status',
    description: 'Show running/paused workflows for this project',
  },
  {
    command: 'workflow',
    subcommand: 'runs',
    spec: 'workflow runs',
    description: 'List recent runs (all statuses) for this project',
    scopedFlags: [
      {
        spec: '--verbose, -v',
        description: "With --json: add each run's per-node state and attention",
      },
    ],
  },
  {
    command: 'workflow',
    subcommand: 'get',
    spec: 'workflow get <run-id>',
    description: 'Show detail for a single run (any status)',
  },
  {
    command: 'workflow',
    subcommand: 'artifacts',
    spec: 'workflow artifacts <run-id> [path]',
    description: "List a run's artifact files, or print one",
  },
  {
    command: 'workflow',
    subcommand: 'logs',
    spec: 'workflow logs <run-id>',
    description: "Print or follow a run's JSONL transcript",
  },
  {
    command: 'workflow',
    subcommand: 'wait',
    spec: 'workflow wait <run-id>',
    description: 'Block until the run ends or needs attention',
  },
  {
    command: 'workflow',
    subcommand: 'attention',
    spec: 'workflow attention [<run-id>]',
    description:
      'List, count or stream the attention queue, or read the item one run stands for\n(defaults to the current project)',
    scopedFlags: [
      { spec: '--project <id|name|key>', description: 'Scope to another project' },
      { spec: '--all', description: 'The whole install' },
      { spec: '--label <k=v>', description: 'Exact label match; repeat to require several' },
      {
        spec: '--sort age|label:<key>',
        description: 'Oldest pause first (default), or by a label',
      },
      {
        spec: '--count-by project|label:<key>',
        description: 'Count items per project or per label value',
      },
      {
        spec: '--watch',
        description:
          'Stream readable changes until stopped; the open set comes first\n' +
          'A degraded warning means coverage may have gaps. Repair and replay:\n' +
          'https://archon.diy/guides/attention-queue/#stream-the-queue',
      },
      {
        spec: '--after <cursor>',
        description: 'With --watch: replay readable events after a cursor; gaps may remain',
      },
    ],
  },
  {
    command: 'workflow',
    subcommand: 'attention label',
    spec: 'workflow attention label <run-id> --occurrence <id>',
    description: 'Set or remove labels on the attention wait a run is paused at',
    scopedFlags: [
      { spec: '--set <k=v>', description: 'Set a label; repeatable' },
      { spec: '--unset <k>', description: 'Remove a label; repeatable' },
    ],
  },
  {
    command: 'workflow',
    subcommand: 'resume',
    spec: 'workflow resume <run-id>',
    description: 'Resume a failed or paused run from completed nodes',
  },
  {
    command: 'workflow',
    subcommand: 'wake',
    spec: 'workflow wake [--watch] [--json]',
    description: 'Wake due continuations across this install',
    scopedFlags: [
      {
        spec: '--watch',
        description: 'Repeat serial passes every 5 seconds; drain execution on shutdown',
      },
      { spec: '--json', description: 'One JSON document per pass' },
      { spec: 'schedule install|remove', description: 'Manage a macOS wake timer' },
      {
        spec: '--interval <seconds>',
        description: 'Timer interval (positive integer, default: 5)',
      },
    ],
  },
  {
    command: 'workflow',
    subcommand: 'signal',
    spec: 'workflow signal <full-run-id>',
    description: 'Signal and wake an event wait; use --occurrence for an exact match',
    scopedFlags: [
      { spec: '--event <name>', description: 'Required event name' },
      { spec: '--occurrence <id>', description: 'Exact occurrence from metadata.wait.pauseId' },
      {
        spec: '--resume-at <ISO timestamp>',
        description: 'Legacy deadline selector; cannot distinguish equal-deadline occurrences',
      },
      { spec: '--data <JSON>', description: 'Optional signal payload' },
      { spec: '--json', description: 'Report signal and execution separately' },
    ],
  },

  {
    command: 'workflow',
    subcommand: 'cancel',
    spec: 'workflow cancel <run-id>',
    description: 'Stop a running workflow (stops an owning process first)',
  },
  {
    command: 'workflow',
    subcommand: 'abandon',
    spec: 'workflow abandon <run-id>',
    description: 'Mark a run cancelled, stopping a live owner first',
  },
  {
    command: 'workflow',
    subcommand: 'respond',
    spec: 'workflow respond <run-id> <decision> [text]',
    description:
      "Resolve a paused gate with any of its declared decisions\n('approve'/'reject' are sugar for the dedicated commands)",
  },
  {
    command: 'workflow',
    subcommand: 'answer',
    spec: 'workflow answer <run-id> --occurrence <id>',
    description: 'Answer a paused attention wait in its declared form',
    scopedFlags: [
      {
        spec: '--choose <id>',
        description:
          'A declared option to choose; repeat for a multi_select (omit for a message form)',
      },
      { spec: '--text <text>', description: 'Free text recorded with the answer' },
    ],
  },
  {
    command: 'workflow',
    subcommand: 'test',
    spec: 'workflow test [<name>|<folder>|<path>]',
    description:
      'Run declared dry-run fixtures (fixtures/*.stubs.yaml) for a\nworkflow, a workflow folder or pack (by name or directory\npath); relative paths resolve from the invoking directory before the\nrepository root. With no target, runs every fixture. Never creates a\nrun or contacts a provider; exec-code fixtures execute in a\nscratch worktree of HEAD',
  },
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
    // `--merged` and `--include-closed` are documented via the Commands-block
    // alias above in the legacy template literal; they live here so scoped
    // `isolation cleanup --help` can list them without changing the global
    // Options block.
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
    description: 'Complete branch lifecycle (remove worktree + branches)',
  },
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
    description: 'Connect an AI provider API key (multi-user installs; key read from prompt/stdin)',
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
];

// Scoped-only entries: subcommands the dispatch handles but whose Commands
// line never appeared in the pre-refactor monolithic help. They render only
// in their matching `archon <command> <subcommand> --help` slice; `archon
// --help` must stay byte-identical, so they are NOT concatenated into the
// global Commands block. Keeping them in a separate table (rather than
// appending to `commandHelp`) makes that boundary explicit and keeps the
// "no flag documentation is lost" invariant honest — nothing here ships in
// global help that was not in the original.
const scopedOnlyHelp: HelpEntry[] = [
  ...attachmentHelp('plugin', true),
  ...attachmentHelp('skill', true),
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
  {
    command: 'workflow',
    subcommand: 'approve',
    spec: 'workflow approve <run-id>',
    description: 'Approve a paused gate (sugar for workflow respond <run-id> approve)',
    scopedFlags: [
      {
        spec: '--comment <text>',
        description:
          'Comment to attach to the approval (also accepted as positional args after <run-id>)',
      },
    ],
  },
  {
    command: 'workflow',
    subcommand: 'reject',
    spec: 'workflow reject <run-id>',
    description: 'Reject a paused gate (sugar for workflow respond <run-id> reject)',
    scopedFlags: [
      {
        spec: '--reason <text>',
        description:
          'Reason to record with the rejection (also accepted as positional args after <run-id>)',
      },
    ],
  },
  {
    command: 'workflow',
    subcommand: 'cleanup',
    spec: 'workflow cleanup [days]',
    description: 'Delete terminal runs older than N days (default: 7)',
  },
  {
    command: 'workflow',
    subcommand: 'reset-sessions',
    spec: 'workflow reset-sessions <workflow-name>',
    description:
      'Delete persisted sessions for a workflow (omits --scope only with --yes; [--node <id>] [--json])',
    scopedFlags: [
      {
        spec: '--scope <key>',
        description: 'Limit the reset to one scope (omit to delete every scope; requires --yes)',
      },
      {
        spec: '--node <id>',
        description: 'Limit the reset to one node within the chosen scope',
      },
      {
        spec: '--yes',
        description: 'Skip the confirmation prompt (required for cross-scope deletion)',
      },
    ],
  },
  {
    command: 'workflow',
    subcommand: 'event',
    spec: 'workflow event emit',
    description: 'Emit a workflow event into a run',
    scopedFlags: [
      {
        spec: '--run-id <id>',
        description: 'Target run for the event (required)',
      },
      {
        spec: '--type <event-type>',
        description: 'Event type to emit (required)',
      },
      {
        spec: '--data <json>',
        description: 'JSON payload for the event (optional)',
      },
    ],
  },
];

// Hand-curated flag order matching the pre-refactor Options block. Each flag
// lists its owning (command, subcommand?) tuples; an empty array means
// "global" — in `archon --help` only, never in a scoped slice. Multi-owner
// flags (e.g. `--detach`, `--events`, `--force`) deduplicate by spec within
// each render.
const orderedFlags: FlagHelp[] = [
  {
    spec: '--cwd <path>',
    description: 'Override working directory (default: current directory)',
    owners: [],
  },
  {
    spec: '--branch, -b <name>',
    description: 'Create worktree for branch (or reuse existing)',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--from, --from-branch <name>',
    description: 'Create new branch from specific start point',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--base-branch <name>',
    description:
      'Initial repository registration only; omit to follow the remote default. Use --base for a run override.',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--base <branch>',
    description: 'Per-dispatch base override for epic slices (worktree cut-from + PR target)',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--workflow-source <path>',
    description:
      'Read the workflow, its commands and scripts from this directory\ninstead of --cwd (which stays the workspace the run acts on)',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--no-worktree',
    description: 'Run on branch directly without worktree isolation',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--folder',
    description:
      'Register the current directory (with or without git) as a folder project and run in place',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--container',
    description: 'Run a folder project in container isolation',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--input <name>=<value>',
    description:
      'Supply a declared workflow input; repeat per input (mutually exclusive with --resume)',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--model <name>=<spec>',
    description: 'Rebind small/medium/large or @alias for one run; repeat per binding',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--config <path>',
    description: 'Load a sparse YAML config layer for one fresh workflow run',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--config-from-run <run-id>',
    description: 'Start a fresh run with the run config another run was started with',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--resume',
    description:
      'Resume the most recent failed or paused run of the workflow (mutually exclusive with --branch)',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--adopt <run-id>',
    description:
      "Start a new run adopting a terminal run's worktree/branch + artifacts ($ADOPTED_RUN_DIR)",
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--supersedes <run-id>',
    description:
      "Record this fresh run as replacing the prior run's open item (no lane inheritance)",
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--dry-run',
    description:
      'Simulate workflow DAG control flow without creating a run or contacting a provider',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--stubs <path>',
    description: 'YAML node-output map for --dry-run',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--stubs-init <path>',
    description: 'Write a complete dry-run stub scaffold and exit',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--default-stubs',
    description: 'Fill missing reached nodes with validated placeholders during --dry-run',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--exec-code',
    description: 'Execute trusted bash/script nodes during --dry-run (default: require stubs)',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--pause-at-gates',
    description: 'Stop a dry-run at approval gates instead of auto-approving',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--providers <ids>',
    description: 'Add comma-separated maintained providers, skipping the setup provider question',
    owners: [{ command: 'setup' }],
  },
  {
    spec: '--spawn',
    description: 'Open setup wizard in a new terminal window (for setup command)',
    owners: [{ command: 'setup' }],
  },
  {
    spec: '--quiet, -q',
    description: 'Log warnings and errors only (the default except for serve)',
    owners: [],
  },
  {
    spec: '--verbose, -v',
    description: 'Show debug-level logs (on stderr; on stdout for serve)',
    owners: [],
  },
  {
    spec: '--json',
    description:
      'Output machine-readable JSON (list/status/get/artifacts/wait/attention/runs/approve/reject/respond/answer/cancel/abandon/resume, project list)',
    owners: [],
  },
  {
    spec: '--events',
    description: 'For verbose JSON status/get: output raw event rows instead of node summaries',
    owners: [
      { command: 'workflow', subcommand: 'status' },
      { command: 'workflow', subcommand: 'get' },
    ],
  },
  {
    spec: '--occurrence <id>',
    description:
      "For 'workflow approve/reject/respond/answer/attention label': refuse the write unless the run is still\npaused at this occurrence (the 'occurrence' that 'workflow wait --json' reports; required by answer\nand attention label)",
    owners: [
      { command: 'workflow', subcommand: 'approve' },
      { command: 'workflow', subcommand: 'reject' },
      { command: 'workflow', subcommand: 'respond' },
      { command: 'workflow', subcommand: 'answer' },
      { command: 'workflow', subcommand: 'attention label' },
    ],
  },
  {
    spec: '--detach',
    description:
      "Run 'workflow run'/'approve'/'reject'/'respond'/'resume' in a detached background child (resume returns after acceptance, before completion)",
    owners: [
      { command: 'workflow', subcommand: 'run' },
      { command: 'workflow', subcommand: 'approve' },
      { command: 'workflow', subcommand: 'reject' },
      { command: 'workflow', subcommand: 'respond' },
      { command: 'workflow', subcommand: 'resume' },
    ],
  },
  {
    spec: '--all',
    description: "For 'workflow status/runs': list across all projects (ignore cwd scope)",
    owners: [
      { command: 'workflow', subcommand: 'status' },
      { command: 'workflow', subcommand: 'runs' },
    ],
  },
  {
    spec: '--status <status>',
    description: "For 'workflow runs': filter to one status (running, completed, failed, ...)",
    owners: [{ command: 'workflow', subcommand: 'runs' }],
  },
  {
    spec: '--open',
    description:
      "For 'workflow runs': the open-work inbox — failed runs nothing has adopted or superseded",
    owners: [{ command: 'workflow', subcommand: 'runs' }],
  },
  {
    spec: '--limit <n>',
    description: "For 'workflow runs': max rows (default 20)",
    owners: [{ command: 'workflow', subcommand: 'runs' }],
  },
  {
    spec: '--timeout <seconds>',
    description: "For 'workflow wait': give up after N seconds (default: wait indefinitely)",
    owners: [{ command: 'workflow', subcommand: 'wait' }],
  },
  {
    spec: '--follow',
    description: "For 'workflow logs': stream appended rows until the run ends",
    owners: [{ command: 'workflow', subcommand: 'logs' }],
  },
  {
    spec: '--format <jsonl|text>',
    description:
      "For 'workflow logs': jsonl (default) prints the exact transcript;\ntext renders it as progress lines for a human",
    owners: [{ command: 'workflow', subcommand: 'logs' }],
  },
  {
    spec: '--conversation-id <id>',
    description:
      "Correlation id for the run's messages. It creates no\nconversation and no persist_session scope",
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--port <port>',
    description: "Override server port for 'serve' (default: 3090)",
    owners: [{ command: 'serve' }],
  },
  {
    spec: '--download-only',
    description: 'Download server and web UI without starting the server',
    owners: [{ command: 'serve' }],
  },
  {
    spec: '--force',
    description:
      "For 'setup': overwrite existing values instead of merging\nFor 'complete': remove even when safety checks block it",
    owners: [{ command: 'setup' }, { command: 'complete' }],
  },
];

// Hand-curated example order matching the pre-refactor Examples block. The
// original order is not a natural entry iteration — e.g. workflow run's
// `--adopt` example appears after workflow runs's `--open` example — so we
// keep the exact order here and filter by owner for scoped rendering.
const orderedExamples: ExampleHelp[] = [
  { text: 'archon chat "What does the orchestrator do?"', owner: { command: 'chat' } },
  { text: 'archon workflow list', owner: { command: 'workflow', subcommand: 'list' } },
  {
    text: 'archon workflow run investigate-issue "Fix the login bug"',
    owner: { command: 'workflow', subcommand: 'run' },
  },
  {
    text: 'archon workflow run plan --cwd /path/to/repo "Add dark mode"',
    owner: { command: 'workflow', subcommand: 'run' },
  },
  {
    text: 'archon workflow run implement --branch feature-auth "Implement auth"',
    owner: { command: 'workflow', subcommand: 'run' },
  },
  {
    text: 'archon workflow run quick-fix --no-worktree "Fix typo"',
    owner: { command: 'workflow', subcommand: 'run' },
  },
  {
    text: 'archon workflow run investigate --folder "Explain how the repos under this root fit together"',
    owner: { command: 'workflow', subcommand: 'run' },
  },
  {
    text: 'archon workflow run archon-investigate --detach "Investigate the flaky test"',
    owner: { command: 'workflow', subcommand: 'run' },
  },
  {
    text: 'archon workflow run investigate --dry-run --stubs ./stubs.yaml --json',
    owner: { command: 'workflow', subcommand: 'run' },
  },
  { text: 'archon workflow runs --json', owner: { command: 'workflow', subcommand: 'runs' } },
  {
    text: 'archon workflow get <run-id> --json',
    owner: { command: 'workflow', subcommand: 'get' },
  },
  {
    text: 'archon workflow artifacts <run-id> plan.md',
    owner: { command: 'workflow', subcommand: 'artifacts' },
  },
  { text: 'archon project list --json', owner: { command: 'project', subcommand: 'list' } },
  {
    text: 'archon workflow logs <run-id> --follow',
    owner: { command: 'workflow', subcommand: 'logs' },
  },
  {
    text: 'archon workflow logs <run-id> --follow --format text',
    owner: { command: 'workflow', subcommand: 'logs' },
  },
  {
    text: 'archon workflow wait <run-id> --json',
    owner: { command: 'workflow', subcommand: 'wait' },
  },
  { text: 'archon workflow resume <run-id>', owner: { command: 'workflow', subcommand: 'resume' } },
  { text: 'archon workflow cancel <run-id>', owner: { command: 'workflow', subcommand: 'cancel' } },
  { text: 'archon workflow runs --open', owner: { command: 'workflow', subcommand: 'runs' } },
  {
    text: 'archon workflow run archon-review --adopt <run-id> "Review the changes"',
    owner: { command: 'workflow', subcommand: 'run' },
  },
  { text: 'archon skill add', owner: { command: 'skill', subcommand: 'add' } },
  {
    text: 'archon skill add /path/to/project',
    owner: { command: 'skill', subcommand: 'add' },
  },
  {
    text: 'archon plugin add coleam00/Archon/plugins/forge-github',
    owner: { command: 'plugin', subcommand: 'add' },
  },
];

// Description column in the Commands/Options block. Each line aligns its
// description to this column. Existing entries sit at spec.length <= 35
// (one space separator when padding has no room) or wrap to the next line
// when the spec itself overflows.
const HELP_DESC_COLUMN = 29;
const HELP_SPEC_WRAP_THRESHOLD = 35;

function formatSpecLine(spec: string, description: string): string {
  const parts = description.split('\n');
  const first = parts[0] ?? '';
  const rest = parts.slice(1);
  let firstLine: string;
  if (spec.length > HELP_SPEC_WRAP_THRESHOLD) {
    // Spec overflows the column: description goes on its own line at col 29.
    firstLine = `  ${spec}\n${' '.repeat(HELP_DESC_COLUMN)}${first}`;
  } else if (spec.length + 2 <= HELP_DESC_COLUMN) {
    // Pad spec so description lands at col 29.
    const pad = ' '.repeat(HELP_DESC_COLUMN - spec.length - 2);
    firstLine = `  ${spec}${pad}${first}`;
  } else {
    // Spec fills 28–35 chars: one space separator.
    firstLine = `  ${spec} ${first}`;
  }
  const continuations = rest.map(part => ' '.repeat(HELP_DESC_COLUMN) + part).join('\n');
  return continuations ? `${firstLine}\n${continuations}` : firstLine;
}

function ownerKey(owner: FlagOwner): string {
  return `${owner.command}|${owner.subcommand ?? ''}`;
}

function selectFlagsFor(selected: HelpEntry[], scopedOnly: FlagHelp[] = []): FlagHelp[] {
  const keys = new Set(selected.map(e => ownerKey(e)));
  const seen = new Set<string>();
  const out: FlagHelp[] = [];
  // Scoped-only flags come first so they appear at the top of the scoped
  // Options block; the matching entry's Commands alias already mentions them.
  for (const f of scopedOnly) {
    if (seen.has(f.spec)) continue;
    seen.add(f.spec);
    out.push(f);
  }
  for (const f of orderedFlags) {
    if (!f.owners?.some(o => keys.has(ownerKey(o)))) continue;
    if (seen.has(f.spec)) continue;
    seen.add(f.spec);
    out.push(f);
  }
  return out;
}

function selectExamplesFor(selected: HelpEntry[]): ExampleHelp[] {
  const keys = new Set(selected.map(e => ownerKey(e)));
  return orderedExamples.filter(ex => keys.has(ownerKey(ex.owner)));
}

function selectEntries(command: string | undefined, subcommand: string | undefined): HelpEntry[] {
  if (command === undefined) return commandHelp;
  // Scoped renders combine `commandHelp` matches with `scopedOnlyHelp`
  // matches. `scopedOnlyHelp` entries never render in the global Commands
  // block (the previous branch), so global help stays byte-identical while
  // every supported subcommand has a Commands line in its scoped slice.
  const sameCommand = commandHelp.filter(e => e.command === command);
  const scopedExtra = scopedOnlyHelp.filter(e => e.command === command);
  const merged = [...sameCommand, ...scopedExtra];
  if (subcommand === undefined) return merged;
  return merged.filter(e => e.subcommand === subcommand);
}

/**
 * Render the help slice for `command`/`subcommand`. With no arguments the
 * output is the global index, byte-identical to the pre-refactor template
 * literal. With a (command, subcommand) tuple, only that slice is shown.
 */
export function renderHelp(command?: string, subcommand?: string): string {
  const entries = selectEntries(command, subcommand);
  const sections: string[] = [];
  sections.push('Archon CLI - Run AI workflows from the command line');
  sections.push('');
  sections.push('Usage:');
  sections.push('  archon <command> [subcommand] [options] [arguments]');
  sections.push('');
  sections.push('Commands:');
  sections.push(entries.map(e => formatSpecLine(e.spec, e.description)).join('\n'));
  const flags =
    command === undefined
      ? orderedFlags
      : selectFlagsFor(
          entries,
          entries.flatMap(e => e.scopedFlags ?? [])
        );
  if (flags.length > 0) {
    sections.push('');
    sections.push('Options:');
    sections.push(flags.map(f => formatSpecLine(f.spec, f.description)).join('\n'));
  }
  const examples = command === undefined ? orderedExamples : selectExamplesFor(entries);
  if (examples.length > 0) {
    sections.push('');
    sections.push('Examples:');
    sections.push(examples.map(ex => `  ${ex.text}`).join('\n'));
  }
  return `\n${sections.join('\n')}\n`;
}
