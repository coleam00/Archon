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

interface FlagOwner {
  command: string;
  subcommand?: string;
}

interface FlagHelp {
  spec: string;
  description: string;
  // Each (command, subcommand?) tuple that owns this flag. Empty means
  // "global": appears in `archon --help` only, never in any scoped slice.
  owners: FlagOwner[];
}

interface ExampleHelp {
  text: string;
  // The (command, subcommand?) tuple this example belongs to. An example
  // appears in `archon --help` iff its owner is selected.
  owner: FlagOwner;
}

// A scoped-only flag has no `owners` — the owning entry is implicit (the
// entry it hangs off). It appears only when that entry's slice renders.
interface ScopedFlagHelp {
  spec: string;
  description: string;
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
  scopedFlags?: ScopedFlagHelp[];
}

// One entry per Commands-block line, in global-help order. `renderHelp()`
// returns the global index with no selection; `renderHelp(...)`
// filters this list by the (command, subcommand) tuple for scoped slices.
// Subcommands listed in `scopedOnlyHelp` below never render in the global
// Commands block, so global help stays byte-identical to the pre-refactor
// template literal while scoped slices can still surface every supported
// subcommand (`--detach` is owned by `workflow approve`/`reject`, which
// live here so the global Commands block does not grow).
const commandHelp: HelpEntry[] = [
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
  },
  {
    command: 'workflow',
    subcommand: 'get',
    spec: 'workflow get <run-id>',
    description: 'Show detail for a single run (any status)',
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
    description: 'Block until the run ends or needs a human decision',
  },
  {
    command: 'workflow',
    subcommand: 'resume',
    spec: 'workflow resume <run-id>',
    description: 'Resume a failed or paused run from completed nodes',
  },
  {
    command: 'workflow',
    subcommand: 'cancel',
    spec: 'workflow cancel <run-id>',
    description: 'Stop a running workflow started with --detach',
  },
  {
    command: 'workflow',
    subcommand: 'abandon',
    spec: 'workflow abandon <run-id>',
    description: 'Mark a run cancelled without stopping host work',
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
    subcommand: 'search',
    spec: 'workflow search [query]',
    description: 'Search the workflow marketplace',
  },
  {
    command: 'workflow',
    subcommand: 'install',
    spec: 'workflow install <slug>',
    description: 'Install a workflow from the marketplace',
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
    description: 'Remove environments with branches merged into main',
    // `--merged` and `--include-closed` are documented via the Commands-block
    // alias above in the legacy template literal; they live here so scoped
    // `isolation cleanup --help` can list them without changing the global
    // Options block.
    scopedFlags: [
      { spec: '--merged', description: 'Remove environments with branches merged into main' },
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
    description: 'Start the web UI server (binary installs download it on first run)',
  },
  {
    command: 'skill',
    subcommand: 'install',
    spec: 'skill install [path]',
    description: 'Install archon-cli into .claude/skills and .agents/skills',
  },
  {
    command: 'doctor',
    spec: 'doctor [--full]',
    description:
      'Verify your Archon setup (Claude/Codex binaries, gh auth, DB, adapters; --full also probes the OpenCode runtime SDK)',
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
      { spec: '--run-id <id>', description: 'Target run for the event (required)' },
      { spec: '--type <event-type>', description: 'Event type to emit (required)' },
      { spec: '--data <json>', description: 'JSON payload for the event (optional)' },
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
    description: 'Register the current non-git directory as a folder project and run in place',
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
    spec: '--spawn',
    description: 'Open setup wizard in a new terminal window (for setup command)',
    owners: [{ command: 'setup' }],
  },
  {
    spec: '--quiet, -q',
    description: 'Reduce log verbosity to warnings and errors only',
    owners: [],
  },
  { spec: '--verbose, -v', description: 'Show debug-level output', owners: [] },
  {
    spec: '--json',
    description:
      'Output machine-readable JSON (list/status/get/wait/runs/approve/reject/respond/cancel/abandon/resume)',
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
    spec: '--detach',
    description:
      "Run 'workflow run'/'approve'/'reject'/'respond'/'resume' in a detached background child (returns immediately)",
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
    spec: '--conversation-id <id>',
    description:
      'Reuse a stable conversation scope across runs (enables\npersist_session resume between separate CLI invocations)',
    owners: [{ command: 'workflow', subcommand: 'run' }],
  },
  {
    spec: '--port <port>',
    description: "Override server port for 'serve' (default: 3090)",
    owners: [{ command: 'serve' }],
  },
  {
    spec: '--download-only',
    description: 'Download web UI without starting the server',
    owners: [{ command: 'serve' }],
  },
  {
    spec: '--force',
    description: 'Overwrite existing file (for workflow install)',
    owners: [{ command: 'workflow', subcommand: 'install' }],
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
    text: 'archon workflow run assist --folder "List every repo under this multi-repo root"',
    owner: { command: 'workflow', subcommand: 'run' },
  },
  {
    text: 'archon workflow run archon-assist --detach "Investigate the flaky test"',
    owner: { command: 'workflow', subcommand: 'run' },
  },
  {
    text: 'archon workflow run assist --dry-run --stubs ./stubs.yaml --json',
    owner: { command: 'workflow', subcommand: 'run' },
  },
  { text: 'archon workflow runs --json', owner: { command: 'workflow', subcommand: 'runs' } },
  {
    text: 'archon workflow get <run-id> --json',
    owner: { command: 'workflow', subcommand: 'get' },
  },
  {
    text: 'archon workflow logs <run-id> --follow',
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
    text: 'archon workflow run archon-smart-pr-review --adopt <run-id> "Review the changes"',
    owner: { command: 'workflow', subcommand: 'run' },
  },
  { text: 'archon skill install', owner: { command: 'skill', subcommand: 'install' } },
  {
    text: 'archon skill install /path/to/project',
    owner: { command: 'skill', subcommand: 'install' },
  },
  {
    text: 'archon workflow search "pr review"',
    owner: { command: 'workflow', subcommand: 'search' },
  },
  {
    text: 'archon workflow install archon-piv-loop',
    owner: { command: 'workflow', subcommand: 'install' },
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

function selectFlagsFor(selected: HelpEntry[], scopedOnly: ScopedFlagHelp[] = []): FlagHelp[] {
  const keys = new Set(selected.map(e => ownerKey(e)));
  const seen = new Set<string>();
  const out: FlagHelp[] = [];
  // Scoped-only flags come first so they appear at the top of the scoped
  // Options block; the matching entry's Commands alias already mentions them.
  for (const f of scopedOnly) {
    if (seen.has(f.spec)) continue;
    seen.add(f.spec);
    out.push({ ...f, owners: [] });
  }
  for (const f of orderedFlags) {
    if (!f.owners.some(o => keys.has(ownerKey(o)))) continue;
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
