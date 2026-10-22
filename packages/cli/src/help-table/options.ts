import { CHAT_PROJECT_ID_ARG } from '@archon/paths/workflow-scope';
import { RUN_PROJECT_CONFLICT_FLAGS } from '../dispatch-guards';
import type { FlagHelp } from './types';

/** Every flag in global --help order; owners select a scoped help's slice. */
export const orderedFlags: FlagHelp[] = [
  {
    spec: `--${CHAT_PROJECT_ID_ARG} <id>`,
    description: 'Confine chat workflow commands to a registered project ID',
    owners: [{ command: 'workflow' }],
  },
  {
    spec: '--cwd <path>',
    description: 'Override working directory (default: current directory)',
    owners: [],
  },
  {
    spec: '--project <id|name>',
    description: `Bind to a registered repository (see project list). Source/config come from --cwd;\nisolated execution uses the registered checkout. Use --no-worktree to execute in --cwd.\nCannot combine with ${RUN_PROJECT_CONFLICT_FLAGS.map(flag => `--${flag}`).join(', ')}.`,
    owners: [{ command: 'workflow', subcommand: 'run' }],
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
