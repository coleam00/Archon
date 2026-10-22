import type { HelpGroup } from './types';

export const workflowHelp: HelpGroup = {
  entries: [
    {
      command: 'workflow',
      subcommand: 'list',
      spec: 'workflow list [name] [--full] [--json]',
      description:
        'List compact workflow descriptions\nUse <name> --full for one exact description',
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
            'https://archon.diy/getting-started/operate/#stream-the-queue',
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
      subcommand: 'end-turn',
      spec: 'workflow end-turn <run-id>',
      description: 'Record a request to end stalled tools or reported work',
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
          description:
            'Limit the reset to one node in the selected scope, or every scope with --yes when --scope is omitted',
        },
        {
          spec: '--yes',
          description: 'Confirm cross-scope reset; refused without --scope or --yes',
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
    {
      command: 'workflow',
      subcommand: 'test',
      spec: 'workflow test [<name>|<folder>|<path>]',
      description:
        'Run declared dry-run fixtures (fixtures/*.stubs.yaml) for a\nworkflow, a workflow folder or pack (by name or directory\npath); relative paths resolve from the invoking directory before the\nrepository root. With no target, runs every fixture. Never creates a\nrun or contacts a provider; exec-code fixtures execute in a\nscratch worktree of HEAD',
    },
  ],
  scopedOnly: [
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
  ],
};
