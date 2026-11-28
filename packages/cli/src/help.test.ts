import { describe, it, expect } from 'bun:test';
import { RUN_PROJECT_CONFLICT_FLAGS } from './dispatch-guards';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { cliForgeJsonSchemas } from '@archon/forge';
import { forgeRequestSchema } from '@archon/forge/operations';
import { convertOutputSchema } from '@archon/workflows/output-types/schema-to-ts';
import { formatSpecLine, helpEntries, renderHelp, renderHelpFor } from './help';
import { forgeRequestHelp } from './help-table/forge-request';
import { cliArgOptions } from './args';
import { orderedFlags } from './help-table/options';
import { attachmentCommands } from './attachment-commands';

const CLI_ENTRY = join(import.meta.dir, 'cli.ts');

function indentType(type: string): string {
  return type.replace(/^/gm, '  ');
}

/** The `--data` template of the request example in a forge operation's scoped help. */
function exampleTemplate(help: string, subcommand: string): string {
  const prefix = `  archon forge ${subcommand} --data '`;
  const line = help.split('\n').find(l => l.startsWith(prefix));
  expect(line, `no request example in forge ${subcommand} --help`).toBeDefined();
  return (line ?? '').slice(prefix.length, -1);
}

/** The template as a tree, each bare `<...>` placeholder read as the string it shows. */
function exampleData(help: string, subcommand: string): unknown {
  return JSON.parse(
    exampleTemplate(help, subcommand).replace(/<[^<>"]+>/g, token => JSON.stringify(token))
  );
}

/**
 * The `Options:` block that `archon <argv...> --help` prints.
 *
 * Scoped-flag assertions target this slice rather than the whole render. A flag
 * name or wording that also appears in the entry's `spec` or Commands-block
 * description would otherwise keep the test green with the entry's
 * `scopedFlags` deleted, which is the fake guard #3153 recorded for
 * `workflow reset-sessions` and `isolation cleanup --merged`. Deleting a
 * `scopedFlags` entry drops its line from this slice; deleting the whole block
 * suppresses the section and fails the marker assertion below.
 */
function scopedHelpOptions(argv: string[]): string {
  const output = renderHelpFor(argv);
  const marker = '\nOptions:\n';
  const start = output.indexOf(marker);
  expect(start, `no Options block in 'archon ${argv.join(' ')} --help'`).toBeGreaterThanOrEqual(0);
  const body = output.slice(start + marker.length);
  const end = body.indexOf('\n\n');
  return end === -1 ? body : body.slice(0, end);
}

it('renders every scopedFlags entry in its own scoped --help Options block', () => {
  const owners = helpEntries.filter(entry => entry.scopedFlags);
  expect(owners.length).toBeGreaterThan(0);
  for (const { command, subcommand, scopedFlags = [] } of owners) {
    const argv = [command, ...(subcommand?.split(' ') ?? [])];
    const options = scopedHelpOptions(argv);
    for (const flag of scopedFlags) {
      expect(options, `archon ${argv.join(' ')} --help`).toContain(
        formatSpecLine(flag.spec, flag.description)
      );
    }
  }
});

it('advertises only flags the strict parser accepts', () => {
  for (const { spec } of orderedFlags) {
    const name = spec.slice(2).split(/[ ,<]/)[0];
    expect(cliArgOptions[name], `${spec} is missing from cliArgOptions`).toBeDefined();
  }
});

it('keeps run source and isolation flags consistent with the parser', () => {
  const options = scopedHelpOptions(['workflow', 'run']).split('\n');
  for (const name of ['project', 'workflow-source', 'no-worktree', 'folder', 'container']) {
    const parserOption = cliArgOptions[name];
    expect(parserOption).toBeDefined();
    const lines = options.filter(line => line.trimStart().startsWith(`--${name} `));
    expect(lines).toHaveLength(1);
    const spec = lines[0]?.trimStart().split(/ {2,}/)[0];
    if (parserOption?.type === 'string') {
      expect(spec).toMatch(new RegExp(`^--${name} <[^>]+>$`));
    } else {
      expect(spec).toBe(`--${name}`);
    }
  }
});

describe('help spec spacing', () => {
  it.each([
    [26, 29],
    [27, 30],
    [28, 31],
    [35, 38],
  ])('separates a %i-character spec from its description', (length, descriptionColumn) => {
    const spec = 'x'.repeat(length);
    const rendered = formatSpecLine(spec, 'Description');
    expect(rendered).toBe(`  ${spec} Description`);
    expect(rendered.indexOf('Description')).toBe(descriptionColumn);
  });

  it('wraps the description after a 36-character spec', () => {
    const spec = 'x'.repeat(36);
    expect(formatSpecLine(spec, 'Description')).toBe(
      `  ${spec}\n                             Description`
    );
  });

  it('separates the real forge workitem.label.remove row from its description', () => {
    expect(renderHelp('forge')).toContain(
      '  forge workitem.label.remove Remove one label from an issue or pull request, keeping the rest'
    );
  });
});

describe('CLI help output', () => {
  const help = renderHelp();

  it('lists session reset and event emission globally and in workflow help', () => {
    for (const output of [help, renderHelp('workflow')]) {
      expect(output).toContain('workflow reset-sessions <workflow-name>');
      expect(output).toContain('workflow event emit');
    }
  });

  // The global anchor must disappear from a scoped slice, rather than
  // merely appending the same content under a different heading.
  it('produces scoped workflow run --help that differs from archon --help and scopes to run-only flags', () => {
    const global = renderHelp();
    const scoped = renderHelp('workflow', 'run');
    expect(global).not.toBe(scoped);
    expect(global).toContain('--cwd <path>');
    expect(scoped).not.toContain('--cwd <path>');
    expect(scoped).toContain('--workflow-source');
    expect(scoped).toContain('--dry-run');
  });

  it('documents --container in workflow run options', () => {
    expect(scopedHelpOptions(['workflow', 'run'])).toContain('--container');
    expect(scopedHelpOptions(['workflow', 'answer'])).not.toContain('--container');
  });

  it('scopes workflow logs --help to its own flags and excludes run-only flags', () => {
    // Proves the partition is not a one-off for workflow run: another
    // subcommand gets only its own flags, while a run-only flag drops out.
    const scoped = renderHelp('workflow', 'logs');
    expect(scoped).toContain('--follow');
    expect(scoped).toContain('--format <jsonl|text>');
    expect(scoped).not.toContain('--dry-run');
  });

  for (const sub of ['approve', 'reject', 'cleanup', 'reset-sessions', 'event']) {
    it(`renders a non-empty Commands block for workflow ${sub} --help`, () => {
      const scoped = renderHelp('workflow', sub);
      expect(scoped).toContain(`workflow ${sub}`);
      // Include the final newline that console.log adds to the rendered text.
      expect(`${scoped}\n`.split('\n').length).toBeGreaterThan(9);
    });
  }

  it('renders --detach in workflow approve --help without leaking other subcommands', () => {
    const scoped = renderHelp('workflow', 'approve');
    expect(scoped).toContain('--detach');
    // --reason belongs to reject, not approve.
    expect(scoped).not.toContain('--reason');
    // --follow belongs to logs, not approve.
    expect(scoped).not.toContain('--follow');
  });

  type Schema = Record<string, unknown>;

  /** The alternative whose `const` properties the example names, such as a subject's `kind`. */
  function chosenAlternative(alternatives: Schema[], value: unknown): Schema {
    const chosen = alternatives.find(alternative => {
      const properties = alternative.properties as Record<string, Schema> | undefined;
      if (typeof value !== 'object' || value === null) return properties === undefined;
      return Object.entries(properties ?? {}).every(
        ([key, child]) => !('const' in child) || (value as Schema)[key] === child.const
      );
    });
    expect(chosen, `no alternative matches ${JSON.stringify(value)}`).toBeDefined();
    return chosen ?? {};
  }

  /** Every value of an example but a `const` is a placeholder; none can be copied as real. */
  function expectPlaceholders(schema: Schema, value: unknown): void {
    if ('const' in schema) return void expect(value).toBe(schema.const);
    const alternatives = (schema.anyOf ?? schema.oneOf) as Schema[] | undefined;
    if (alternatives) return expectPlaceholders(chosenAlternative(alternatives, value), value);
    if (schema.type === 'object') {
      const properties = schema.properties as Record<string, Schema>;
      for (const [key, child] of Object.entries(value as Schema))
        expectPlaceholders(properties[key] ?? {}, child);
      return;
    }
    if (schema.type === 'array') {
      for (const item of value as unknown[]) expectPlaceholders(schema.items as Schema, item);
      return;
    }
    expect(String(value), 'example value is not a placeholder').toMatch(/^<[^<>]+>$/);
  }

  // Every operation's request type and template come from its schema, and every value the
  // caller supplies is a bare placeholder, so an unfilled template is not JSON at all.
  for (const { op, request } of cliForgeJsonSchemas().operations) {
    for (const subcommand of op === 'checks.state' ? [op, 'checks'] : [op]) {
      it(`renders the request and a template example in forge ${subcommand} --help`, () => {
        const scoped = renderHelpFor(['forge', subcommand]);
        expect(scopedHelpOptions(['forge', subcommand])).toContain('--data <json>');
        expect(scoped).toContain(
          `Request (--data):\n${indentType(convertOutputSchema(request).type)}`
        );
        expectPlaceholders(request as Schema, exampleData(scoped, subcommand));
        expect(() => JSON.parse(exampleTemplate(scoped, subcommand))).toThrow();
      });
    }
  }

  // Filling a template with deliberate values, keyed by field path, gives a request the
  // host accepts.
  const repo = { 'repo.host': '"forge.example"', 'repo.path': '"a/b"' };
  const ref = { 'ref.repo.host': '"forge.example"', 'ref.repo.path': '"a/b"', 'ref.number': '4' };
  const filled: Record<string, Record<string, string>> = {
    'pr.merge': { ...ref, method: '"squash"', 'conditions.head': '"abc123"' },
    'pr.close': ref,
    'workitem.create': {
      ...repo,
      title: '"Title"',
      marker: '"<!-- item-31 -->"',
      body: '"<!-- item-31 -->\\nBody"',
    },
    'workitem.edit-body': { ...ref, body: '"New body"' },
    'workitem.label.add': {
      'subject.ref.repo.host': '"forge.example"',
      'subject.ref.repo.path': '"a/b"',
      'subject.ref.number': '4',
      name: '"queued"',
    },
  };
  for (const [op, values] of Object.entries(filled)) {
    it(`fills the forge ${op} template into a request the host accepts`, () => {
      const template = exampleTemplate(renderHelpFor(['forge', op]), op);
      const tree = exampleData(renderHelpFor(['forge', op]), op);
      // Walk the tree for each placeholder's path, then write that path's value in its place.
      const paths: string[] = [];
      const walk = (value: unknown, path: string): void => {
        if (typeof value === 'object' && value !== null)
          for (const [key, child] of Object.entries(value))
            walk(child, path ? `${path}.${key}` : key);
        else if (typeof value === 'string' && value.startsWith('<')) paths.push(path);
      };
      walk(tree, '');
      let index = 0;
      const request = template.replace(/<[^<>"]+>/g, () => {
        const value = values[paths[index++] ?? ''];
        expect(value, `no deliberate value for ${paths[index - 1]}`).toBeDefined();
        return value ?? '';
      });
      const parsed = { ...JSON.parse(request), op, operationId: 'help' };
      expect(forgeRequestSchema.safeParse(parsed).success).toBe(true);
    });
  }

  it('shows the pull request and the head pr.merge is pinned to, and only what it needs', () => {
    const scoped = renderHelp('forge', 'pr.merge');
    expect(scoped).toMatch(/readonly ref: \{\n\s+readonly repo: \{/);
    expect(scoped).toContain('readonly number: number;');
    expect(scoped).toContain('readonly head: string;');
    expect(exampleData(renderHelpFor(['forge', 'pr.merge']), 'pr.merge')).toEqual({
      ref: { repo: { host: '<host>', path: '<path>' }, number: '<number: integer>' },
      method: '<method: merge|squash>',
      conditions: { head: '<head>' },
    });
  });

  it('states a field added to a request schema in both the type and the example', () => {
    const base = {
      type: 'object',
      properties: { ref: { type: 'integer' }, note: { type: 'string' } },
      required: ['ref'],
      additionalProperties: false,
    };
    const added = {
      ...base,
      properties: { ...base.properties, pinned: { type: 'string' } },
      required: ['ref', 'pinned'],
    };
    expect(forgeRequestHelp('op', base)).toEqual({
      type: '{\n  readonly ref: number;\n  readonly note?: string;\n}',
      notes: [],
      example: `archon forge op --data '{"ref":<ref: integer>}'`,
    });
    const help = forgeRequestHelp('op', {
      ...added,
      properties: { ...added.properties, pinned: { type: 'string', description: 'Pinned value' } },
    });
    expect(help.type).toContain('readonly pinned: string;');
    expect(help.notes).toEqual(['pinned: Pinned value']);
    expect(help.example).toBe(`archon forge op --data '{"ref":<ref: integer>,"pinned":<pinned>}'`);
  });

  it('says in forge workitem.create --help that the marker is chosen per item', () => {
    expect(renderHelpFor(['forge', 'workitem.create'])).toContain(
      'marker: Chosen for this one item and used by no other'
    );
  });

  it('points forge --help to each operation without printing every request', () => {
    const forge = renderHelp('forge');
    expect(forge).toContain('archon forge <operation> --help');
    expect(forge).not.toContain('Request (--data):');
    for (const forgeName of ['github', 'gitlab', 'gitea', 'forgejo', 'bitbucket'])
      expect(forge.toLowerCase()).not.toContain(forgeName);
  });

  const EXPECTED_GLOBAL_HELP = `
Archon CLI - Run AI workflows from the command line

Usage:
  archon <command> [subcommand] [options] [arguments]

Commands:
  state <get|put|patch|log|delete|list|claim>
                             Read and audit durable project or install JSON documents
  metrics [name]             Aggregate metric records by name, window and instrument
  tracker sync               Bring every tracked project's item tracker up to date in one pass (no server needed)
  tracker release <project>  Let go of a project's tracker pass held by a process this host cannot prove gone
  forge resolve              Resolve an explicit remote through optional forge plugins
  forge checks               Observe checks for an explicit qualified pull request
  user <list|role|link>      List users, link identities and manage roles as the operator
  project list               List registered projects (id, kind, name, key, path)
  project add [path]         Register a project (this checkout, or path) before its first run; --folder for a non-git directory
  project config <id|name>   Show a project's merged config with secrets removed (env key names only)
  trigger <fire|drain|list|inspect|withdraw|recover-preparation|schedule>
                             Start configured workflows and inspect durable resource admission
  hold <set|lift>            Hold all new runs on this install, or lift the hold and start what it kept;
                             running runs continue
  pack graph <pack>          Show a pack's stages, their outcomes and the run-ended arrows between them,
                             each active in this install or declared and inactive (--json for the read)
  pack bindings <pack>       Write a pack's recommended trigger bindings as files for one repository;
                             registers and schedules nothing. Needs --repo, --host, --run-as and --out
  chat <message>             Send a message to the orchestrator
  setup [--scope <home|project>] Interactive setup wizard for credentials and config
  workflow list [name] [--full] [--json]
                             List compact workflow descriptions
                             Use <name> --full for one exact description
  workflow run <name> [msg]  Run a workflow with optional message
                             With no name, --supersedes <run-id> starts that run again from its record
  workflow status            Show running/paused workflows for this project
  workflow runs              List recent runs (all statuses) for this project
  workflow get <run-id>      Show detail for a single run (any status)
  workflow artifacts <run-id> [path] List a run's artifact files, or print one
  workflow logs <run-id>     Print or follow a run's JSONL transcript
  workflow wait <run-id> | --item <key>
                             Block until the run ends or needs attention
                             With --item: until any live run on the item does; names the run
  workflow attention [<run-id>|ask:<id>]
                             List, count or stream the attention queue, or read the item one run or ask stands for
                             (defaults to the current project)
  workflow attention label <run-id> --occurrence <id>
                             Set or remove labels on the attention wait a run is paused at
  workflow pause <run-id>    Request a pause before a running run's next node; a run with no node left completes
                             Once paused it keeps its slot and item; resume it with 'workflow resume'
  workflow resume <run-id>   Resume a failed, paused or killed run from completed nodes
  workflow wake [--watch] [--json] Wake due continuations across this install
  workflow signal <full-run-id> Signal and wake an event wait; use --occurrence for an exact match
  workflow cancel <run-id> | --item <key>
                             Stop a running workflow (stops an owning process first), or a queued one before it starts
                             With --item: the item's pending or running run; refuses when several are
  workflow abandon <run-id> | --item <key>
                             Mark a run cancelled, stopping a live owner first
                             With --item: the item's pending, running or paused run; refuses when several are
  workflow end-turn <run-id> Record a request to end stalled tools or reported work
  workflow respond <run-id> <decision> [text]
                             Resolve a paused gate with any of its declared decisions
                             ('approve'/'reject' are sugar for the dedicated commands)
  workflow answer <run-id> --occurrence <id>
                             Answer a paused attention wait in its declared form
  workflow reset-sessions <workflow-name>
                             Delete persisted sessions for a workflow (omits --scope only with --yes; [--node <id>] [--json])
  workflow rule --item <key> -- <text>
                             Record a ruling on an item of this project: a decision made without a question.
                             Every later read of the item shows it with the answers; prints the ruling's id
  workflow end --item <key> -- <reason>
                             End an item of this project: nothing more will happen on it. Its stop leaves attention and
                             reads show who ended it and why; a newer run or start opens it again. Refused while anything
                             on the item is active or waiting, naming it
  workflow link --item <key> --kind <kind> --to <key>
                             Record a link from one item of this project to another: depends_on, part_of or
                             duplicate_of, read from --item to --to. Recording it again leaves one link; prints the link's id
  workflow items             This project's items with a run started in a window (default the last 30 days),
                             each with all its runs, questions, answers and merge, ordered by item id
  workflow merged --item <key> --change <ref> --at <ISO>
                             Record that an item's change merged, as the forge reported it. Recorded once:
                             a second report keeps the first
  workflow title --item <key> --text <title>
                             Set what an item is called. Every read of the item returns it beside the key.
                             Setting it again replaces it
  workflow landing --item <key> --branch <name> [--from <start-point>]
                             Record the branch an item's change lands on. Every fresh run on the item, and on
                             an item part_of it that records none, is cut from it and proposes against it.
                             Recording again replaces it. With --from, first create the branch on the remote
  workflow priority --item <key> [--clear]
                             Give an item priority. Its queued starts, and those of items part_of it, go ahead of
                             ordinary queued starts on each resource at the next drain; a held slot is never taken
  workflow notice <text>     Inside a workflow node: say what the run did, for whoever watches attention
                             with --notices. Never pauses the run and cannot be answered
  workflow event emit        Emit a workflow event into a run
  workflow test [<name>|<folder>|<path>]
                             Run declared dry-run fixtures (fixtures/*.stubs.yaml) for a
                             workflow, a workflow folder or pack (by name or directory
                             path); relative paths resolve from the invoking directory before the
                             repository root. With no target, runs every fixture. Never creates a
                             run or contacts a provider; exec-code fixtures execute in a
                             scratch worktree of HEAD
  workflow types <name|folder|path> Generate TypeScript for each node's output_format: the node
                             output types and every enum's values. A pack (by name or
                             directory path) writes <pack>/.shared/outputs.generated.ts; a single
                             workflow needs --out. --check exits 1 when the file is stale
  script types               Print the TypeScript declaration of the archon:script module a workflow
                             script imports, for an editor or tsc over a pack's scripts
  script preload             Write the preload file that provides the archon:script module, to run or
                             test a workflow script outside a run: bun --preload <file> script.ts
  isolation list             List all active worktrees/environments
  isolation cleanup [days]   Remove eligible worktrees by inactivity, containers by creation age (default: 7 days)
  isolation cleanup --merged [--json] Remove worktrees covered by Git integration or a merged PR
  isolation cleanup schedule install|remove|status
                             Manage the OS timer that runs the merged cleanup
  complete <branch> [...]    Remove worktree and local branch; retain remote branch
  serve                      Start the web UI server (binary installs download server and UI on first run)
  skill add [path]           Add archon-cli into .claude/skills and .agents/skills
  provider add <id...>       Add maintained providers matching this Archon release (connects your agent CLI or SDK)
  plugin add <owner/repo[/path][@tag]>
                             Add a plugin from GitHub (default: binary plugins the latest release, workflow packs the default branch)
  plugin update <id>[@tag]   Reinstall an installed plugin at a tag, or its latest release or default branch
  plugin remove <id>         Delete the files an installed plugin wrote
  plugin copy <id>           Copy an installed workflow pack into this project's .archon/workflows/
  plugin list                Show installed plugins with tag and commit
  doctor                     Verify installed provider diagnostics, DB, and adapters
  auth github                Connect your GitHub identity via device flow (multi-user installs)
  ai key set <provider>      Connect an AI provider API key (multi-user installs; key read from prompt/stdin)
  ai login <provider>        Connect a Claude, ChatGPT/Codex, or Copilot subscription
  ai list                    List your connected AI provider keys
  ai logout <provider>       Disconnect an AI provider key
  ai tier set <t> <p> <m>    Set a model tier (small/medium/large) → provider/model [--effort <e>] [--scope user|install]
  ai tier list [--json]      Show configured tiers (install + yours) vs built-in defaults
  ai tier unset <tier>       Unset a tier override (built-ins: claude/codex only) [--scope user|install]
  ai alias set <@n> <p> <m>  Set a @custom model alias [--effort <e>] [--scope user|install]
  ai alias list [--json]     Show configured @custom aliases (install + yours)
  ai alias unset <@name>     Remove a @custom alias [--scope user|install]
  ai capacity [--json]       Show provider attempts holding concurrency.providers capacity
  ai capacity release <id>   Release a held attempt whose owner process you verified is gone
  ai default <p> [<model>]   Set the default assistant (+ chat model) [--scope user|install]
  telemetry status           Show anonymous telemetry state (enabled, reason, ID, host)
  telemetry reset            Rotate the anonymous install UUID
  telemetry no-match         Record an agent decision that no workflow fits
  validate workflows [name]  Validate workflow definitions and their references
  validate commands [name]   Validate command files
  version, --version, -V     Show version info (also -v when used alone)
  help                       Show this help message

Options:
  --chat-project-id <id>     Confine chat workflow commands to a registered project ID
  --cwd <path>               Override working directory (default: current directory)
  --project <id|name>        Bind to a registered repository (see project list). Definitions come from the base branch
                             with --cwd's uncommitted changes on top; isolated execution uses the registered checkout.
                             Use --no-worktree to execute in --cwd.
                             Cannot combine with ${RUN_PROJECT_CONFLICT_FLAGS.map(flag => `--${flag}`).join(', ')}.
  --branch, -b <name>        Create worktree for branch (or reuse existing)
  --from, --from-branch <name> Create new branch from specific start point
  --base-branch <name>       Initial repository registration only; omit to follow the remote default. Use --base for a run override.
  --base <branch>            Per-dispatch base override for epic slices (worktree cut-from + PR target)
  --workflow-source <path>   Read the workflow, its commands and scripts from this checkout root as it is
                             (<path>/.archon/workflows), instead of the base branch with --cwd's uncommitted changes on top
                             (--cwd stays the workspace the run acts on)
  --no-worktree              Run on branch directly without worktree isolation
  --folder                   Register the target directory (the project add path, else the current directory), with or without git, as a folder project; workflow run runs in place
  --container                Run a folder project in container isolation
  --input <name>=<value>     Supply a declared workflow input; for 'trigger fire': set one event input as text; repeat per input
  --input-file <name>=<path> Supply a declared workflow input from a file's contents; repeat per input
  --model <name>=<spec>      Rebind small/medium/large or @alias for one run; repeat per binding
  --config <path>            Load a sparse YAML config layer for one fresh workflow run
  --config-from-run <run-id> Start a fresh run with the run config another run was started with
  --adopt <run-id>           Start a new run adopting a terminal run's worktree/branch + artifacts ($ADOPTED_RUN_DIR)
  --supersedes <run-id>      Record this fresh run as replacing the prior run's open item; with a workflow name, no lane inheritance.
                             With no name, start that run again from its record: project, workflow, source, base, inputs and
                             checkout hand-off; an explicit --base wins over the recorded base
  --dry-run                  Simulate workflow DAG control flow without creating a run or contacting a provider
  --stubs <path>             YAML node-output map for --dry-run
  --stubs-init <path>        Write a dry-run stub scaffold and exit; omits child workflows.
                             Reached child workflows need authored stubs unless fan-out items resolve to [].
  --default-stubs            Fill missing reached AI, bash, and script nodes with validated placeholders during --dry-run.
                             With --exec-code, unstubbed bash/script nodes execute locally instead. Explicit stubs win.
                             Reached child workflows need authored stubs unless fan-out items resolve to [].
  --exec-code                Execute trusted unstubbed bash/script nodes locally during --dry-run, even with --default-stubs.
                             Explicit stubs win; default is no code execution.
  --pause-at-gates           Stop a dry-run at approval gates instead of auto-approving
  --providers <ids>          Add comma-separated maintained providers, skipping the setup provider question
  --spawn                    Open setup wizard in a new terminal window (for setup command)
  --quiet, -q                Log warnings and errors only (the default except for serve)
  --verbose, -v              Show debug-level logs (on stderr; on stdout for serve)
  --json                     Output machine-readable JSON (list/status/get/artifacts/wait/attention/runs/approve/reject/respond/answer/cancel/pause/abandon/resume, project list/add/config)
  --events                   For verbose JSON status/get: output raw event rows instead of node summaries
  --occurrence <id>          For 'workflow approve/reject/respond/answer/attention label': refuse the write unless the run is still
                             paused at this occurrence (the 'occurrence' that 'workflow wait --json' reports; required by answer
                             and attention label)
  --as <name>                For 'workflow approve/reject/respond/answer/rule/end/link/pause': the name the answerer declares for itself,
                             recorded with an attention wait's answer, a ruling, an end, a link or a pause as a claim (never checked; refused at a gate)
  --detach                   Run 'workflow run'/'approve'/'reject'/'respond'/'resume' in a detached background child (resume returns after acceptance, before completion)
  --no-wait                  For 'workflow run': refuse instead of waiting, naming the resource when the workflow's
                             resource is full, or the holding run when another run of the workflow on the same --item
                             is not terminal (with or without a resource:), or who set the install hold while it is set
  --lost                     For 'workflow status': show only active runs reported unreachable: their recorded owner on this host does not answer
  --all                      For 'workflow status/runs': list across all projects (ignore cwd scope)
  --status <status>          For 'workflow runs': filter to one status (running, completed, failed, ...)
  --item <key>               The item a 'workflow run' or 'trigger fire' start belongs to; for 'workflow runs': read the item's runs, open questions and answers; for 'workflow rule': the item the ruling is on; for 'workflow end': the item to end; for 'workflow merged': the item whose change merged; for 'workflow landing': the item whose landing branch is recorded; for 'workflow title': the item the title is set on; for 'workflow priority': the item to give priority or clear it on; for 'workflow link': the item the link is from; for 'workflow wait/cancel/abandon': the item whose runs to wait on or act on
  --no-item                  For 'trigger fire': start the run on no item instead of inheriting the firing run's item
  --priority                 For 'trigger fire': give the start's item priority once, when the fire is accepted
  --open                     For 'workflow runs': the open-work inbox — failed runs nothing has adopted or superseded
  --limit <n>                For 'workflow runs': max rows (default 20); for 'workflow items': items a page (default 20, at most 100)
  --timeout <seconds>        For 'workflow wait': give up after N seconds (default: wait indefinitely)
  --follow                   For 'workflow logs': stream appended rows until the run ends
  --format <jsonl|text>      For 'workflow logs': jsonl (default) prints the exact transcript;
                             text renders it as progress lines for a human
  --conversation-id <id>     Correlation id for the run's messages. It creates no
                             conversation and no persist_session scope
  --port <port>              Override server port for 'serve' (default: 3090)
  --download-only            Download server and web UI without starting the server
  --force                    For 'setup': overwrite existing values instead of merging
                             For 'complete': remove even when safety checks block it

Examples:
  archon chat "What does the orchestrator do?"
  archon workflow list
  archon workflow run archon-investigate "Why does login fail?"
  archon workflow run archon-plan --cwd /path/to/repo "Add dark mode"
  archon workflow run archon-implement --branch feature-auth "Implement auth"
  archon workflow run archon-implement --no-worktree "Fix the typo in the README"
  archon workflow run archon-investigate --folder "Explain how the repos under this root fit together"
  archon workflow run archon-investigate --detach "Investigate the flaky test"
  archon workflow run archon-investigate --dry-run --stubs ./stubs.yaml --json
  archon workflow runs --json
  archon workflow get <run-id> --json
  archon workflow artifacts <run-id> plan.md
  archon project list --json
  archon project add --json
  archon project config <id|name> --json
  archon workflow logs <run-id> --follow
  archon workflow logs <run-id> --follow --format text
  archon workflow wait <run-id> --json
  archon workflow pause <run-id>
  archon workflow resume <run-id>
  archon workflow cancel <run-id>
  archon workflow cancel --item issue-42
  archon workflow runs --open
  archon workflow run archon-review --adopt <run-id> "Review the changes"
  archon forge <operation> --help    # that operation's request fields and an example
  archon skill add
  archon skill add /path/to/project
  archon skill add --pack owner/repo
  archon plugin add coleam00/Archon/plugins/forge-github

`;

  it('advertises throughput on the two run-history views', () => {
    expect(scopedHelpOptions(['workflow', 'get'])).toContain('--throughput');
    expect(scopedHelpOptions(['workflow', 'get'])).toContain('per recorded agent attempt and run');
    expect(scopedHelpOptions(['workflow', 'runs'])).toContain('--throughput');
    expect(scopedHelpOptions(['workflow', 'runs'])).toContain('across listed runs');
  });

  it('archon --help matches the supported global index byte-for-byte', () => {
    expect(`${renderHelp()}\n`).toBe(EXPECTED_GLOBAL_HELP);
  });

  it.each([
    ['plugin', '<owner/repo[/path][@tag]>'],
    ['skill', '[path]'],
  ])('retains scoped help for the %s alias without advertising it globally', (command, args) => {
    const result = spawnSync(process.execPath, [CLI_ENTRY, command, 'install', '--help'], {
      encoding: 'utf8',
      env: { ...process.env, ARCHON_TELEMETRY_DISABLED: '1' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`${command} install ${args}`);
    expect(result.stdout).toContain(`Deprecated alias for archon ${command} add`);
    expect(renderHelp()).not.toContain(`${command} install`);
  });

  it('archon help <cmd> [<subcmd>] matches archon <cmd> [<subcmd>] --help', () => {
    for (const argv of [
      ['workflow', 'run'],
      ['isolation', 'cleanup'],
      ['workflow', 'logs'],
      ['workflow', 'attention', 'label'],
    ]) {
      const viaHelp = spawnSync(process.execPath, [CLI_ENTRY, 'help', ...argv], {
        encoding: 'utf8',
        env: { ...process.env, ARCHON_TELEMETRY_DISABLED: '1' },
      });
      const viaFlag = spawnSync(process.execPath, [CLI_ENTRY, ...argv, '--help'], {
        encoding: 'utf8',
        env: { ...process.env, ARCHON_TELEMETRY_DISABLED: '1' },
      });
      expect(viaHelp.status).toBe(0);
      expect(viaFlag.status).toBe(0);
      expect(viaHelp.stdout).toBe(viaFlag.stdout);
      expect(viaFlag.stdout).toBe(`${renderHelpFor(argv)}\n`);
    }
  });

  it('does not promise a prompt in workflow reset-sessions --help', () => {
    expect(scopedHelpOptions(['workflow', 'reset-sessions'])).not.toContain('prompt');
  });
});

it('workflow run help distinguishes initial registration from the dispatch override', () => {
  const text = scopedHelpOptions(['workflow', 'run']);
  expect(text).toContain('--base-branch <name>');
  expect(text).toContain('Initial repository registration only');
  expect(text).toContain('--base <branch>');
});

it('provider and plugin add help exposes the supported commands and plugin example', () => {
  expect(renderHelp('provider', 'add')).toContain('provider add <id...>');
  const plugin = renderHelp('plugin', 'add');
  expect(plugin).toContain('plugin add <owner/repo[/path][@tag]>');
  expect(plugin).toContain('archon plugin add coleam00/Archon/plugins/forge-github');
});

it('every supported attachment verb has scoped help, with aliases scoped only', () => {
  const global = renderHelp();
  for (const [command, verbs] of Object.entries(attachmentCommands)) {
    for (const [verb, entry] of Object.entries(verbs)) {
      const spec = `${command} ${verb} ${entry.args}`.trimEnd();
      expect(renderHelp(command, verb)).toContain(spec);
      if ('scopedOnly' in entry) {
        expect(global).not.toContain(spec);
      } else {
        expect(global).toContain(spec);
      }
    }
  }
});

it('documents host metadata separately from plugin operations', () => {
  const scoped = renderHelp('forge', 'metadata');
  expect(scoped).toContain('without credentials or forge operations');
  expect(renderHelp()).not.toContain('forge metadata');
});
