// @archon-test-isolated
/**
 * The item commands against a real SQLite store, in-process: `workflow run --item` and
 * `--supersedes`, `workflow runs --item` and `--item-of`, `workflow rule`, `workflow end`,
 * `workflow merged`,
 * the merge record an applied forge `pr.merge` writes,
 * `workflow items` and `workflow link`. The store's conformance tests prove what is
 * recorded; these prove each command's request, refusal codes and JSON and text output.
 * Which item a trigger start lands on needs detached runs and stays in the trigger spec.
 */
import { afterAll, beforeAll, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { landingCreateCommand } from '@archon/core/workflows/item-landing';
import { removeTempTree } from '@archon/paths/test-utils';
import { itemReadSchema } from '@archon/workflows/item-read';
import { itemWindowSchema } from '@archon/workflows/item-window';
import { itemLinkSchema } from '@archon/workflows/schemas/item-link';
import { itemRulingSchema } from '@archon/workflows/schemas/item-ruling';
import { itemEndSchema } from '@archon/workflows/schemas/item-end';
import { itemStoppedMetadata } from '@archon/workflows/schemas/run-metadata';
import { captureWorkflowCommand } from '../test-support/command';
import * as workflowScope from '../workflow-scope';
import { recordRunMerge } from './forge-merge-record';
import { projectAddCommand } from './project';
import { workflowLinkCommand } from './workflow-link';
import { workflowItemsCommand } from './workflow-items';
import { workflowLandingCommand } from './workflow-landing';
import { workflowMergedCommand } from './workflow-merged';
import { workflowRunsCommand } from './workflow-query';
import { workflowRuleCommand } from './workflow-rule';
import { runWorkflowEnd } from '../routes/workflow';
import * as workflowCommands from './workflow';
import { workflowAttentionCommand } from './workflow-attention';
import { workflowRunCommand } from './workflow-run-owned';

mock.module('@archon/core/services/title-generator', () => ({
  generateAndSetTitle: async (): Promise<void> => undefined,
}));

const scopeSpy = spyOn(workflowScope, 'readChatProjectScope').mockReturnValue(undefined);
// A suite run inside a workflow node inherits its run identity; the commands must not act
// as that node's caller. Forge credentials from the operator's shell must not reach the
// host either: a GitHub App id without its key fails host setup.
const callerEnv: NodeJS.ProcessEnv = {
  WORKFLOW_ID: '',
  ARCHON_NODE_EXECUTION: '',
  GITHUB_TOKEN: '',
  GH_TOKEN: '',
  GITHUB_APP_ID: '',
  GITHUB_APP_PRIVATE_KEY: '',
  GITHUB_APP_PRIVATE_KEY_PATH: '',
};
const savedEnv = Object.fromEntries(Object.keys(callerEnv).map(key => [key, process.env[key]]));

let root = '';
let projectRoot = '';
let archonHome = '';
let database = '';

let seeded = '';

// One real `workflow run --item` registers the project as the CLI does and puts a run on
// item-1; the other runs are store rows, because what the store records for an item is
// proved by its conformance tests and a full workflow costs seconds on a slow runner. It
// happens once. Each test then starts from a copy of the seeded state at the same path,
// because the database and the workspace link record absolute paths.
beforeAll(async () => {
  Object.assign(process.env, callerEnv);
  root = realpathSync(mkdtempSync(join(tmpdir(), 'archon-item-commands-')));
  seeded = realpathSync(mkdtempSync(join(tmpdir(), 'archon-item-commands-seed-')));
  projectRoot = join(root, 'project');
  archonHome = join(root, 'home');
  database = join(archonHome, 'archon.db');
  mkdirSync(join(projectRoot, '.archon', 'workflows'), { recursive: true });
  writeFileSync(
    join(projectRoot, '.archon', 'workflows', 'item-proof.yaml'),
    'name: item-proof\ndescription: item proof.\nmutates_checkout: false\nnodes:\n  - id: done\n    bash: echo done\n'
  );
  const init = Bun.spawnSync(['git', 'init', '-q'], { cwd: projectRoot });
  expect(init.exitCode).toBe(0);
  // Every test reads these: two runs on item-1, one on item-2 and one with no item.
  await run({ item: 'item-1' });
  await seedRuns(['item-1', 'item-2', undefined]);
  copyTree(root, seeded);
});

afterAll(async () => {
  await removeTempTree(root);
  await removeTempTree(seeded);
  scopeSpy.mockRestore();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
});

// Each test gets its own copy of the seeded project and database, so no test reads what
// another wrote and the order they run in cannot change a result.
beforeEach(async () => {
  await removeTempTree(root);
  // removeTempTree only warns when removal fails; copying over a leftover tree would keep
  // what the last test wrote.
  if (existsSync(root)) throw new Error(`Could not clear the previous test's state at ${root}`);
  copyTree(seeded, root);
});

/**
 * Copies a fixture tree, links included. Registration links the project source with a
 * junction on Windows, which needs no privilege; `cpSync` recreates a link as a symbolic
 * link, which needs Developer Mode there. So links are skipped by the copy and made again
 * afterwards, a directory link as a junction on Windows, once the tree they point into exists.
 */
function copyTree(from: string, to: string): void {
  const links: [string, string][] = [];
  cpSync(from, to, {
    recursive: true,
    filter: (source, destination) => {
      if (!lstatSync(source).isSymbolicLink()) return true;
      links.push([source, destination]);
      return false;
    },
  });
  for (const [source, destination] of links) {
    const directory = statSync(source).isDirectory();
    symlinkSync(
      readlinkSync(source),
      destination,
      directory ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file'
    );
  }
}

/** One command in-process; its exit code, stdout (console and JSON lines) and stderr. */
async function invoke(
  command: (host: WorkflowHost) => Promise<number | void>
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let written = '';
  let errored = '';
  const capture =
    (into: (text: string) => void) =>
    (chunk: unknown, ...rest: unknown[]): boolean => {
      into(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk as Uint8Array));
      const done = rest.find(arg => typeof arg === 'function') as (() => void) | undefined;
      done?.();
      return true;
    };
  const stdout = spyOn(process.stdout, 'write').mockImplementation(
    capture(text => (written += text)) as typeof process.stdout.write
  );
  const stderr = spyOn(process.stderr, 'write').mockImplementation(
    capture(text => (errored += text)) as typeof process.stderr.write
  );
  let code = 0;
  try {
    const result = await captureWorkflowCommand(archonHome, async host => {
      code = (await command(host)) ?? 0;
    });
    return {
      exitCode: result.status || code,
      stdout: written + result.stdout,
      stderr: errored + result.stderr,
    };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

/** The JSON a command printed, after asserting it exited 0. */
function succeeded(result: { exitCode: number; stdout: string; stderr: string }): unknown {
  expect(result.exitCode, result.stderr || result.stdout).toBe(0);
  return JSON.parse(result.stdout) as unknown;
}

async function readJson(command: (host: WorkflowHost) => Promise<number | void>) {
  return succeeded(await invoke(command));
}

async function run(options: { item?: string; supersedesRunId?: string } = {}): Promise<void> {
  const result = await invoke(host =>
    workflowRunCommand(host, projectRoot, 'item-proof', 'go', { noWorktree: true, ...options })
  );
  expect(result.exitCode, result.stderr).toBe(0);
}

/** Completed runs of `item-proof` in the registered project, written straight to the store. */
async function seedRuns(itemKeys: readonly (string | undefined)[]): Promise<void> {
  const result = await captureWorkflowCommand(archonHome, async host => {
    const codebase = await host.records.codebases.findCodebaseByDefaultCwd(projectRoot);
    if (!codebase) throw new Error('The seed run did not register the project');
    for (const item_key of itemKeys) {
      const seeded = await host.deps.store.createWorkflowRun({
        workflow_name: 'item-proof',
        user_message: 'go',
        codebase_id: codebase.id,
        working_path: projectRoot,
        item_key,
      });
      await host.deps.store.claimPendingWorkflowRun(seeded.id, projectRoot);
      await host.deps.store.completeWorkflowRun(seeded.id, { duration_ms: 1 });
    }
  });
  expect(result.status, result.stderr).toBe(0);
}

const readItemJson = async (key: string) =>
  itemReadSchema.parse(
    await readJson(host => workflowRunsCommand(host, projectRoot, { item: key, json: true }))
  );

function rows<T>(sql: string): T[] {
  const db = new Database(database, { readonly: true });
  try {
    return db.query<T, []>(sql).all();
  } finally {
    db.close();
  }
}

const runsWithItems = () =>
  rows<{ id: string; status: string; item_key: string | null; continues: string | null }>(
    `SELECT r.id, r.status, i.key AS item_key, r.adopted_from_run_id AS continues
       FROM remote_agent_workflow_runs r LEFT JOIN remote_agent_items i ON i.id = r.item_id
      ORDER BY r.rowid`
  );

// The commands write to process-wide stdout, environment and registries, so each test is
// `test.serial`: it must not run beside another, even under `--concurrent`. (In Bun 1.4.5
// `describe.serial` does not hold its tests back under `--concurrent`; `test.serial` does.)
test.serial(
  'workflow run --item puts a run on the item, and the item read lists its runs',
  async () => {
    const all = runsWithItems();
    expect(all.map(row => row.status)).toEqual([
      'completed',
      'completed',
      'completed',
      'completed',
    ]);
    expect(all.map(row => row.item_key)).toEqual(['item-1', 'item-1', 'item-2', null]);
    // One row per item; the run with no item added none.
    expect(rows<{ key: string }>('SELECT key FROM remote_agent_items ORDER BY key')).toEqual([
      { key: 'item-1' },
      { key: 'item-2' },
    ]);

    const read = await readItemJson('item-1');
    expect(read.item.key).toBe('item-1');
    expect(read.runs.map(entry => entry.id).sort()).toEqual(
      all
        .filter(row => row.item_key === 'item-1')
        .map(row => row.id)
        .sort()
    );
    expect(read.runs.every(entry => entry.status === 'completed')).toBe(true);
    const text = await invoke(host => workflowRunsCommand(host, projectRoot, { item: 'item-1' }));
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain('Item item-1');

    // A key nothing named is refused; an item named with no run yet reads as one.
    const unknown = await invoke(host =>
      workflowRunsCommand(host, projectRoot, { item: 'item-9', json: true })
    );
    expect(unknown.exitCode).toBe(1);
    expect(JSON.parse(unknown.stdout)).toEqual({
      ok: false,
      error: 'not_found',
      item: 'item-9',
      refused: [],
    });
    const textUnknown = await invoke(host =>
      workflowRunsCommand(host, projectRoot, { item: 'item-9' })
    );
    expect(textUnknown.exitCode).toBe(1);
    expect(textUnknown.stderr).toContain("No item 'item-9'");

    // A start refused before any start made its item names it all the same.
    await invoke(async host => {
      const receiptId = crypto.randomUUID();
      const { store } = host.deps;
      await store.acceptStartReceipt({
        receipt: {
          id: receiptId,
          sourceInstanceId: 'fire',
          deliveryId: null,
          contentDigest: receiptId,
          receivedAt: new Date().toISOString(),
          occurredAt: null,
          sourceActor: null,
          itemKey: 'item-8',
        },
        outcome: 'matched',
        bindings: [
          {
            bindingId: 'triage',
            bindingRevision: null,
            hostId: 'host',
            runAsUserId: 'operator',
            resource: 'pool',
            overlap: 'queue',
            launch: {
              cwd: projectRoot,
              workflowName: 'triage',
              inputs: {},
              isolation: { kind: 'in-place' },
            },
          },
        ],
      });
      const identity = { receiptId, bindingId: 'triage', ownerId: crypto.randomUUID() };
      await store.claimStartBindingPreparation(identity);
      await store.failStartBindingPreparation({
        ...identity,
        error: 'launch_preparation_failed',
        retryable: false,
        refusal: 'no_default_provider',
      });
    });
    const refusedJson = await invoke(host =>
      workflowRunsCommand(host, projectRoot, { item: 'item-8', json: true })
    );
    expect(refusedJson.exitCode).toBe(1);
    expect(JSON.parse(refusedJson.stdout)).toMatchObject({
      error: 'not_found',
      refused: [
        { kind: 'refused_start', start: { itemKey: 'item-8', reason: 'no_default_provider' } },
      ],
    });
    const refusedText = await invoke(host =>
      workflowRunsCommand(host, projectRoot, { item: 'item-8' })
    );
    expect(refusedText.stderr).toContain('no start has made it yet');
    expect(refusedText.stderr).toContain('archon ai default <provider>');
    const writable = new Database(database);
    try {
      writable.run(
        "INSERT INTO remote_agent_items (project_key, key) SELECT project_key, 'item-3' FROM remote_agent_items WHERE key = 'item-1'"
      );
    } finally {
      writable.close();
    }
    expect(await readItemJson('item-3')).toMatchObject({
      item: { key: 'item-3' },
      runs: [],
      queued: [],
      questions: [],
      answers: [],
    });

    // `--supersedes` and `--item` both reach the run the command creates. Which item a
    // continuation lands on (inherited, named, or none) is the store's rule, proved in its
    // conformance tests; `--adopt` writes the same `adopted_from_run_id` and needs a worktree.
    const bare = all.find(row => row.item_key === null);
    if (!bare) throw new Error('Expected a run with no item');
    await run({ supersedesRunId: bare.id, item: 'item-2' });
    expect(
      runsWithItems()
        .filter(row => row.continues !== null)
        .map(({ continues, item_key }) => ({ continues, item_key }))
    ).toEqual([{ continues: bare.id, item_key: 'item-2' }]);
  }
);

/** A run of `item-proof` on `key`: still running, or ended at once, stopping the item or failed. */
async function seedEnded(key: string, end: 'running' | 'stopped' | 'failed'): Promise<string> {
  let id = '';
  const result = await captureWorkflowCommand(archonHome, async host => {
    const codebase = await host.records.codebases.findCodebaseByDefaultCwd(projectRoot);
    if (!codebase) throw new Error('The seed run did not register the project');
    const seeded = await host.deps.store.createWorkflowRun({
      workflow_name: 'item-proof',
      user_message: 'go',
      codebase_id: codebase.id,
      working_path: projectRoot,
      item_key: key,
    });
    id = seeded.id;
    await host.deps.store.claimPendingWorkflowRun(seeded.id, projectRoot);
    if (end === 'failed') await host.deps.store.failWorkflowRun(seeded.id, 'boom');
    else if (end === 'stopped')
      await host.deps.store.completeWorkflowRun(
        seeded.id,
        { duration_ms: 1 },
        itemStoppedMetadata('Folded into another item.'),
        { outcome: { kind: 'enum', value: 'fold' } }
      );
  });
  expect(result.status, result.stderr).toBe(0);
  return id;
}

test.serial(
  'a run whose outcome finishes its item ends it: the item read says the engine ended it and why',
  async () => {
    writeFileSync(
      join(projectRoot, '.archon', 'workflows', 'finish.yaml'),
      `name: finish
description: Close an item.
mutates_checkout: false
returns: { node: decide, outcome: outcome, ends: [close], summary: why }
nodes:
  - id: decide
    bash: |
      echo '{"outcome": "close", "why": "Fixed upstream."}'
    output_format:
      type: object
      properties:
        outcome: { type: string, enum: [close, again] }
        why: { type: string }
      required: [outcome, why]
`
    );
    const started = await invoke(host =>
      workflowRunCommand(host, projectRoot, 'finish', 'go', {
        noWorktree: true,
        item: 'item-close',
      })
    );
    expect(started.exitCode, started.stderr).toBe(0);

    const reason = "Workflow 'finish' ended the item with outcome 'close': Fixed upstream.";
    expect((await readItemJson('item-close')).ended).toMatchObject({
      reason,
      via: 'engine',
      by: null,
    });
    const text = await invoke(host =>
      workflowRunsCommand(host, projectRoot, { item: 'item-close' })
    );
    expect(text.stdout).toContain(`via engine: ${reason}`);
    const attention = succeeded(
      await invoke(host =>
        workflowAttentionCommand(host, projectRoot, undefined, { json: true, labels: [] })
      )
    ) as { items: { item?: { key: string } }[] };
    expect(attention.items.map(item => item.item?.key)).not.toContain('item-close');
  }
);

test.serial('a run of an observing workflow leaves a stopped item listed as stopped', async () => {
  const decide = (name: string, observes: boolean) =>
    `name: ${name}
description: ${name}
mutates_checkout: false
${observes ? 'observes: true\n' : ''}returns: { node: decide, outcome: outcome }
nodes:
  - id: decide
    bash: |
      echo '{"outcome": "not_ready"}'
    output_format:
      type: object
      properties:
        outcome: { type: string, enum: [not_ready, ready] }
      required: [outcome]
`;
  const workflows = join(projectRoot, '.archon', 'workflows');
  writeFileSync(join(workflows, 'review.yaml'), decide('review', false));
  writeFileSync(join(workflows, 'shadow.yaml'), decide('shadow', true));
  const stopsOnItem = async () => {
    const read = await invoke(host =>
      workflowAttentionCommand(host, projectRoot, undefined, { json: true, labels: [] })
    );
    const items = (JSON.parse(read.stdout) as { items: { kind: string; item?: { key: string } }[] })
      .items;
    return items.filter(item => item.kind === 'stopped' && item.item?.key === 'item-observed');
  };
  const runOn = async (workflow: string) => {
    const result = await invoke(host =>
      workflowRunCommand(host, projectRoot, workflow, 'go', {
        noWorktree: true,
        item: 'item-observed',
      })
    );
    expect(result.exitCode, result.stderr).toBe(0);
  };

  // `not_ready` starts nothing and ends nothing, so the step stops its item.
  await runOn('review');
  expect(await stopsOnItem()).toHaveLength(1);
  // The observing run on the item completes with the same quiet outcome; the stop stays.
  await runOn('shadow');
  expect(await stopsOnItem()).toMatchObject([{ stoppedIn: { workflow: 'review' } }]);
});

test.serial(
  'workflow end takes a stopped item out of attention, and the item read says who ended it and why',
  async () => {
    const attention = async () =>
      (
        await invoke(host =>
          workflowAttentionCommand(host, projectRoot, undefined, { json: true, labels: [] })
        )
      ).stdout;
    // `archon workflow end --item <key> [--as <name>] --json -- <reason>`, as argv routes it.
    const end = (key: string, as: string | undefined, env: NodeJS.ProcessEnv = callerEnv) =>
      invoke(host =>
        runWorkflowEnd({
          commands: workflowCommands,
          host,
          positionals: ['workflow', 'end', 'A duplicate of item-2.'],
          values: { item: key, ...(as === undefined ? {} : { as }), json: true },
          command: 'workflow',
          subcommand: 'end',
          cwd: projectRoot,
          effectiveCwd: projectRoot,
          json: true,
          detachedRunConfig: undefined,
          inheritedEnv: env,
          forgeTrustedEnv: env,
        })
      );
    const stopped = await seedEnded('item-stop', 'stopped');
    expect(await attention()).toContain(`stopped:${stopped}`);
    // The real command, through the CLI's own dispatch and argument parsing.
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, '..', 'cli.ts'),
        ...['workflow', 'end', '--item', 'item-stop', '--as', 'triage-agent', '--json'],
        ...['--', 'A duplicate of item-2.'],
      ],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          ...callerEnv,
          ARCHON_HOME: archonHome,
          DATABASE_URL: '',
          ARCHON_TELEMETRY_DISABLED: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, err || out).toBe(0);
    itemEndSchema.parse(JSON.parse(out));
    expect(await attention()).not.toContain(`stopped:${stopped}`);
    expect((await readItemJson('item-stop')).ended).toMatchObject({
      reason: 'A duplicate of item-2.',
      by: { declared: 'triage-agent' },
      via: 'cli',
    });

    // A failed item is ended by its key alone, and without --as the CLI identity says who.
    await seedEnded('item-fail', 'failed');
    succeeded(await end('item-fail', undefined, { ...callerEnv, ARCHON_USER_ID: 'ops' }));
    expect((await readItemJson('item-fail')).ended).toMatchObject({
      by: { declared: 'ops' },
    });

    // Refusals exit 1 with a code: a live run named, nobody named, an unknown key.
    const running = await seedEnded('item-live', 'running');
    const refusal = async (result: Promise<{ exitCode: number; stdout: string }>) => {
      const { exitCode, stdout } = await result;
      expect(exitCode).toBe(1);
      return JSON.parse(stdout) as unknown;
    };
    expect(await refusal(end('item-live', 'triage-agent'))).toMatchObject({
      error: 'run',
      blocker: { kind: 'run', runId: running, status: 'running' },
    });
    const nobody = { ...callerEnv, ARCHON_USER_ID: '', USER: '', USERNAME: '' };
    expect(await refusal(end('item-stop', undefined, nobody))).toMatchObject({
      error: 'unattributed',
    });
    expect(await refusal(end('item-none', 'triage-agent'))).toEqual({
      ok: false,
      error: 'not_found',
    });
  }
);

test.serial(
  'workflow rule records and withdraws rulings, and an item read and --item-of carry them',
  async () => {
    // A ruling is recorded with no question asked, here on a key nothing has named yet.
    const ruling = itemRulingSchema.parse(
      await readJson(host =>
        workflowRuleCommand(
          host,
          projectRoot,
          { item: 'item-new', text: 'leave the chat readers for a follow-up', as: 'triage-agent' },
          true,
          callerEnv
        )
      )
    );
    expect(ruling).toMatchObject({
      text: 'leave the chat readers for a follow-up',
      by: { declared: 'triage-agent' },
      via: 'cli',
      withdrawn: null,
    });
    const fresh = await readItemJson('item-new');
    expect(fresh.runs).toEqual([]);
    expect(fresh.answers).toEqual([ruling]);

    // Any run of an item reads the item's rulings by its own id, as `archon:script` item() does.
    const onItem = runsWithItems().find(row => row.item_key === 'item-1');
    const bare = runsWithItems().find(row => row.item_key === null);
    if (!onItem || !bare) throw new Error('Expected a run on item-1 and a run with no item');
    const recorded = await invoke(host =>
      workflowRuleCommand(
        host,
        projectRoot,
        { item: 'item-1', text: 'do not accept an empty outcome' },
        undefined,
        callerEnv
      )
    );
    expect(recorded.exitCode, recorded.stderr).toBe(0);
    expect(recorded.stdout).toMatch(/Ruling \S+ recorded\./);
    const ofRun = itemReadSchema.parse(
      await readJson(host =>
        workflowRunsCommand(host, projectRoot, { itemOf: onItem.id, json: true })
      )
    );
    expect(ofRun.item.key).toBe('item-1');
    expect(
      ofRun.answers.flatMap(answer => (answer.kind === 'ruling' ? [answer.text] : []))
    ).toEqual(['do not accept an empty outcome']);
    const noItem = await invoke(host =>
      workflowRunsCommand(host, projectRoot, { itemOf: bare.id, json: true })
    );
    expect(noItem.exitCode).toBe(1);
    expect(JSON.parse(noItem.stdout)).toMatchObject({ ok: false, error: 'not_found' });

    // Withdrawn once; the record stays and says so.
    const withdraw = (id: string, json = true) =>
      invoke(host => workflowRuleCommand(host, projectRoot, { withdraw: id }, json, callerEnv));
    const withdrawn = itemRulingSchema.parse(succeeded(await withdraw(ruling.id)));
    expect(withdrawn.withdrawn).toMatchObject({ via: 'cli', by: null });
    for (const [id, error] of [
      [ruling.id, 'already_withdrawn'],
      ['no-such-ruling', 'not_found'],
    ] as const) {
      const refused = await withdraw(id);
      expect(refused.exitCode).toBe(1);
      expect(JSON.parse(refused.stdout)).toMatchObject({ ok: false, error });
    }
    expect((await readItemJson('item-new')).answers).toEqual([withdrawn]);

    // Under a selected project, a ruling on another project's item is not withdrawn.
    const scratch = new Database(database);
    let codebaseId: string;
    try {
      scratch.run(
        "INSERT INTO remote_agent_items (project_key, key) VALUES ('other/project', 'x')"
      );
      scratch.run(
        `INSERT INTO remote_agent_item_rulings (id, item_id, text, via)
       SELECT 'foreign-ruling', id, 'not yours', 'cli' FROM remote_agent_items WHERE key = 'x'`
      );
      codebaseId =
        scratch.query<{ id: string }, []>('SELECT id FROM remote_agent_codebases').get()?.id ?? '';
    } finally {
      scratch.close();
    }
    scopeSpy.mockReturnValue(codebaseId);
    try {
      const outside = await withdraw('foreign-ruling');
      expect(outside.exitCode).toBe(1);
      expect(JSON.parse(outside.stdout)).toMatchObject({ ok: false, error: 'outside_project' });
      const outsideText = await withdraw('foreign-ruling', false);
      expect(outsideText.exitCode).toBe(1);
      expect(outsideText.stderr).toContain('outside project');
    } finally {
      scopeSpy.mockReturnValue(undefined);
    }
    // Without a selected project, a withdrawal by id is not scoped.
    expect(
      itemRulingSchema.parse(succeeded(await withdraw('foreign-ruling'))).withdrawn
    ).not.toBeNull();
  }
);

test.serial(
  'workflow merged records once and workflow items pages the items it reads',
  async () => {
    // The merged fact is recorded once, never on a key nothing named, and the item read carries it.
    const merged = (item: string, change: string) =>
      invoke(host =>
        workflowMergedCommand(
          host,
          projectRoot,
          { item, change, at: '2026-11-02T10:00:00Z' },
          true,
          callerEnv
        )
      );
    const change = 'https://github.com/acme/web/pull/1';
    expect(succeeded(await merged('item-1', change))).toMatchObject({ recorded: true });
    expect(succeeded(await merged('item-1', 'other'))).toMatchObject({
      recorded: false,
      merge: { change },
    });
    const notNamed = await merged('item-9', change);
    expect(notNamed.exitCode).toBe(1);
    expect(JSON.parse(notNamed.stdout)).toEqual({ ok: false, error: 'not_found' });

    // The window read returns the items with a run in it, each read as --item reads it, and
    // a page past the limit hands a cursor that returns the rest once.
    const items = async (query: Parameters<typeof workflowItemsCommand>[2]) =>
      itemWindowSchema.parse(
        await readJson(host => workflowItemsCommand(host, projectRoot, query, true))
      );
    const page = await items({});
    expect(page.items.map(entry => entry.item.key).sort()).toEqual(['item-1', 'item-2']);
    const one = page.items.find(entry => entry.item.key === 'item-1');
    expect(one).toEqual(await readItemJson('item-1'));
    expect(one?.merged?.change).toBe(change);
    const first = await items({ limit: 1 });
    const rest = await items({ after: first.next ?? '' });
    expect(first.items).toHaveLength(1);
    expect(rest.items).toHaveLength(1);
    expect([...first.items, ...rest.items]).toEqual(page.items);
    expect(rest.next).toBeNull();
    const badCursor = await invoke(host =>
      workflowItemsCommand(host, projectRoot, { after: 'nope' }, true)
    );
    expect(badCursor.exitCode).toBe(1);
    expect(JSON.parse(badCursor.stdout)).toMatchObject({ ok: false });
  }
);

test.serial(
  'a hand start on an item is cut from its landing branch unless --base names another',
  async () => {
    const out = join(root, 'base.out');
    const git = (args: string[]) => {
      const done = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd: projectRoot,
      });
      expect(done.exitCode, done.stderr.toString()).toBe(0);
    };
    // A remote with `main` and `feat/order`, which holds a file `main` does not.
    const remote = join(root, 'remote.git');
    expect(
      Bun.spawnSync(['git', 'init', '-q', '--bare', '--initial-branch=main', remote]).exitCode
    ).toBe(0);
    writeFileSync(
      join(projectRoot, '.archon', 'workflows', 'base-proof.yaml'),
      `name: base-proof\ndescription: base proof.\nmutates_checkout: false\nnodes:\n  - id: base\n    bash: echo "$BASE_BRANCH $([ -f on-feat ] && echo from-feat || echo from-base)" > '${out}'\n`
    );
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'base']);
    git(['branch', '-M', 'main']);
    git(['remote', 'add', 'origin', remote]);
    git(['push', '-q', 'origin', 'main']);
    git(['checkout', '-q', '-b', 'feat/order']);
    writeFileSync(join(projectRoot, 'on-feat'), '');
    git(['add', 'on-feat']);
    git(['commit', '-q', '-m', 'feat']);
    git(['push', '-q', 'origin', 'feat/order']);
    git(['checkout', '-q', 'main']);

    const landing = (item: string, branch: string) =>
      invoke(host => workflowLandingCommand(host, projectRoot, { item, branch }, true, callerEnv));
    expect(succeeded(await landing('WO-1', 'feat/order'))).toMatchObject({ branch: 'feat/order' });
    succeeded(
      await invoke(host =>
        workflowLinkCommand(
          host,
          projectRoot,
          { item: 'member', kind: 'part_of', to: 'WO-1' },
          true,
          callerEnv
        )
      )
    );
    const start = (
      options: Parameters<typeof workflowRunCommand>[4] & { item: string },
      cwd = projectRoot
    ) => invoke(host => workflowRunCommand(host, cwd, 'base-proof', 'go', options));
    const started = await start({ item: 'member' });
    expect(started.exitCode, started.stderr).toBe(0);
    expect(readFileSync(out, 'utf8').trim()).toBe('feat/order from-feat');
    const flagged = await start({ item: 'member', baseBranch: 'main' });
    expect(flagged.exitCode, flagged.stderr).toBe(0);
    expect(readFileSync(out, 'utf8').trim()).toBe('main from-base');

    // A start that supersedes a run on the item names no item and still takes its branch.
    const [memberRun] = rows<{ id: string }>(
      `SELECT r.id FROM remote_agent_workflow_runs r JOIN remote_agent_items i
         ON i.id = r.item_id WHERE i.key = 'member' ORDER BY r.rowid DESC LIMIT 1`
    );
    const superseding = await invoke(host =>
      workflowRunCommand(host, projectRoot, 'base-proof', 'go', {
        supersedesRunId: memberRun?.id,
      })
    );
    expect(superseding.exitCode, superseding.stderr).toBe(0);
    expect(readFileSync(out, 'utf8').trim()).toBe('feat/order from-feat');

    // `--project` selects the project apart from the directory: its item's branch applies.
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: elsewhere }).exitCode).toBe(0);
    const [selected] = rows<{ id: string }>('SELECT id FROM remote_agent_codebases');
    const projected = await start(
      { item: 'member', codebaseId: selected?.id, discoveryCwd: projectRoot },
      elsewhere
    );
    expect(projected.exitCode, projected.stderr).toBe(0);
    expect(readFileSync(out, 'utf8').trim()).toBe('feat/order from-feat');

    // An in-place run cannot be cut from the landing branch, so it is refused before it runs.
    writeFileSync(out, 'untouched');
    const inPlace = await start({ item: 'member', noWorktree: true });
    expect(inPlace.exitCode).not.toBe(0);
    expect(inPlace.stderr).toContain('would work in place');
    expect(readFileSync(out, 'utf8')).toBe('untouched');

    // A branch the remote does not have refuses the start before a worktree is cut.
    writeFileSync(out, 'untouched');
    succeeded(await landing('lonely', 'feat/missing'));
    const worktrees = () =>
      Bun.spawnSync(['git', 'worktree', 'list'], { cwd: projectRoot }).stdout.toString();
    const before = worktrees();
    const refused = await start({ item: 'lonely' });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("'feat/missing' is not on remote 'origin'");
    const [{ default_cwd: checkout } = { default_cwd: '' }] = rows<{ default_cwd: string }>(
      'SELECT default_cwd FROM remote_agent_codebases'
    );
    // Built by the same function, so a checkout path that needs quoting (Windows, a space)
    // matches; the core test proves the quoting survives a shell.
    const createCommand = landingCreateCommand('lonely', 'feat/missing', checkout);
    expect(createCommand).toContain('--item lonely --branch feat/missing --from <start-point>');
    expect(refused.stderr).toContain(createCommand);
    expect(worktrees()).toBe(before);
    expect(readFileSync(out, 'utf8')).toBe('untouched');
    // A member's refusal names the item that records the branch, and a start made from
    // another directory with `--project` still names the selected project's checkout.
    succeeded(
      await invoke(host =>
        workflowLinkCommand(
          host,
          projectRoot,
          { item: 'lonely-member', kind: 'part_of', to: 'lonely' },
          true,
          callerEnv
        )
      )
    );
    const memberRefused = await start(
      { item: 'lonely-member', codebaseId: selected?.id, discoveryCwd: projectRoot },
      elsewhere
    );
    expect(memberRefused.exitCode).not.toBe(0);
    expect(memberRefused.stderr).toContain(createCommand);

    // The command it names creates the branch from the start point; runs are cut from it.
    const remoteSha = (branch: string) =>
      Bun.spawnSync(['git', 'ls-remote', remote, `refs/heads/${branch}`])
        .stdout.toString()
        .split('\t')[0];
    // Run from the directory the printed `--cwd` names, as the command would be.
    const create = (item: string, branch: string, from: string) =>
      invoke(host =>
        workflowLandingCommand(host, checkout, { item, branch, from }, true, callerEnv)
      );
    expect(succeeded(await create('lonely', 'feat/missing', 'feat/order'))).toMatchObject({
      branch: 'feat/missing',
      create: { remote: 'origin', status: 'created', commit: remoteSha('feat/order') },
    });
    expect(remoteSha('feat/missing')).toBe(remoteSha('feat/order'));
    const cut = await start({ item: 'lonely' });
    expect(cut.exitCode, cut.stderr).toBe(0);
    expect(readFileSync(out, 'utf8').trim()).toBe('feat/missing from-feat');
    writeFileSync(out, 'untouched');
    const inherited = await start({ item: 'lonely-member' });
    expect(inherited.exitCode, inherited.stderr).toBe(0);
    expect(readFileSync(out, 'utf8').trim()).toBe('feat/missing from-feat');

    // Creating a branch the remote has leaves it where it is, even when the start point
    // descends from it and a plain push would fast-forward it.
    git(['checkout', '-q', '-b', 'ahead', 'feat/order']);
    git(['commit', '-q', '--allow-empty', '-m', 'ahead']);
    git(['checkout', '-q', 'main']);
    const existing = remoteSha('feat/missing');
    expect(succeeded(await create('lonely', 'feat/missing', 'ahead'))).toMatchObject({
      create: { remote: 'origin', status: 'exists' },
    });
    expect(remoteSha('feat/missing')).toBe(existing);

    // The file store cannot record a landing, so the remote is left untouched.
    const config = join(archonHome, 'config.yaml');
    const saved = readFileSync(config, 'utf8');
    writeFileSync(config, `${saved}\nstore: files\n`);
    try {
      succeeded(await invoke(host => projectAddCommand(host, { path: projectRoot, json: true })));
      const onFiles = await create('on-files', 'feat/on-files', 'main');
      expect(onFiles.exitCode).not.toBe(0);
      expect(JSON.parse(onFiles.stdout).error).toContain('store: files');
    } finally {
      writeFileSync(config, saved);
    }
    expect(remoteSha('feat/on-files')).toBe('');

    // `--item-of` finds the run's project wherever it is called from, and creates there.
    const ofRun = await invoke(host =>
      workflowLandingCommand(
        host,
        elsewhere,
        { itemOf: memberRun?.id ?? '', branch: 'feat/of-run', from: 'main' },
        true,
        callerEnv
      )
    );
    expect(succeeded(ofRun)).toMatchObject({
      branch: 'feat/of-run',
      create: { status: 'created' },
    });
    expect(remoteSha('feat/of-run')).toBe(remoteSha('main'));

    // A record the store would refuse is refused before anything is pushed.
    expect((await create('', 'feat/no-item', 'main')).exitCode).toBe(1);
    const noIdentity = await invoke(host =>
      workflowLandingCommand(
        host,
        projectRoot,
        { item: 'fresh', branch: 'feat/no-identity', from: 'main' },
        true,
        { ...callerEnv, WORKFLOW_ID: 'run-1' }
      )
    );
    expect(noIdentity.exitCode).toBe(1);
    expect(remoteSha('feat/no-item')).toBe('');
    expect(remoteSha('feat/no-identity')).toBe('');

    // A start point that names no commit records nothing.
    const unresolved = await create('fresh', 'feat/fresh', 'no-such-ref');
    expect(unresolved.exitCode).toBe(1);
    expect(remoteSha('feat/fresh')).toBe('');
    expect(
      rows(
        `SELECT 1 FROM remote_agent_item_landings l JOIN remote_agent_items i
           ON i.id = l.item_id WHERE i.key = 'fresh'`
      )
    ).toEqual([]);
  },
  // Seven real runs, each cutting a worktree.
  90_000
);

test.serial(
  'workflow link records a link read from both items, refuses bad ones and ends once',
  async () => {
    const link = (request: Parameters<typeof workflowLinkCommand>[2], json = true) =>
      invoke(host => workflowLinkCommand(host, projectRoot, request, json, callerEnv));
    const toItem1 = { item: 'item-new', kind: 'depends_on', to: 'item-1' };
    const recorded = itemLinkSchema.parse(
      succeeded(await link({ ...toItem1, as: 'triage-agent' }))
    );
    expect(recorded).toMatchObject({
      kind: 'depends_on',
      from: { key: 'item-new' },
      to: { key: 'item-1' },
      by: { declared: 'triage-agent' },
      ended: null,
    });
    const readLinks = async (key: string) => (await readItemJson(key)).links;
    expect(await readLinks('item-new')).toMatchObject([
      { id: recorded.id, direction: 'outgoing', other: { key: 'item-1' } },
    ]);
    expect(await readLinks('item-1')).toMatchObject([
      { id: recorded.id, direction: 'incoming', other: { key: 'item-new' } },
    ]);
    // Recording it again leaves one link.
    expect(succeeded(await link(toItem1))).toMatchObject({
      id: recorded.id,
      created: false,
    });
    expect(await readLinks('item-new')).toHaveLength(1);
    // A self-link and an unknown kind are refused, saying why.
    for (const [request, error] of [
      [{ ...toItem1, to: 'item-new' }, 'self_link'],
      [{ ...toItem1, kind: 'same_as' }, 'unknown_kind'],
    ] as const) {
      const refused = await link(request);
      expect(refused.exitCode).toBe(1);
      expect(JSON.parse(refused.stdout)).toEqual({ ok: false, error });
    }
    const unknownText = await link({ ...toItem1, kind: 'same_as' }, false);
    expect(unknownText.exitCode).toBe(1);
    expect(unknownText.stderr).toContain('depends_on, part_of, duplicate_of');
    // Ended once: the fact stays readable with who ended it, and is no longer active.
    const endedLink = itemLinkSchema.parse(
      succeeded(await link({ end: recorded.id, as: 'alice' }))
    );
    expect(endedLink).toMatchObject({
      ...recorded,
      ended: { via: 'cli', by: { declared: 'alice' } },
    });
    expect(await readLinks('item-1')).toMatchObject([
      { id: recorded.id, ended: { by: { declared: 'alice' } } },
    ]);
    const again = await link({ end: recorded.id });
    expect(again.exitCode).toBe(1);
    expect(JSON.parse(again.stdout)).toEqual({ ok: false, error: 'already_ended' });
  }
);

test.serial(
  "--item-of writes on the run's own item in its own project, whatever the directory",
  async () => {
    // A second registered project with its own item-1, and the writes made from inside it.
    const other = join(root, 'other');
    mkdirSync(other);
    const registered = await captureWorkflowCommand(archonHome, async host => {
      await host.records.codebases.createCodebase({ name: 'other', default_cwd: other });
    });
    expect(registered.status, registered.stderr).toBe(0);
    const landing = (request: Parameters<typeof workflowLandingCommand>[2]) =>
      invoke(host => workflowLandingCommand(host, other, request, true, callerEnv));
    succeeded(await landing({ item: 'item-1', branch: 'feat/other' }));

    const onItem = runsWithItems().find(row => row.item_key === 'item-1');
    const bare = runsWithItems().find(row => row.item_key === null);
    if (!onItem || !bare) throw new Error('Expected a run on item-1 and a run with no item');
    // Thunks: the commands share process stdout, so each runs alone.
    const writes = (itemOf: string) => [
      () => landing({ itemOf, branch: 'feat/own' }),
      () =>
        invoke(host =>
          workflowMergedCommand(
            host,
            other,
            { itemOf, change: 'https://github.com/acme/web/pull/2', at: '2026-11-02T10:00:00Z' },
            true,
            callerEnv
          )
        ),
      () =>
        invoke(host =>
          workflowLinkCommand(
            host,
            other,
            { itemOf, kind: 'depends_on', to: 'item-2' },
            true,
            callerEnv
          )
        ),
      () =>
        invoke(host =>
          workflowLinkCommand(
            host,
            other,
            { itemOf, kind: 'part_of', from: 'item-3' },
            true,
            callerEnv
          )
        ),
    ];
    for (const write of writes(onItem.id)) succeeded(await write());

    const own = await readItemJson('item-1');
    expect(own.landing).toMatchObject({ branch: 'feat/own', from: { kind: 'own' } });
    expect(own.merged?.change).toBe('https://github.com/acme/web/pull/2');
    expect(own.links).toMatchObject([
      { direction: 'outgoing', kind: 'depends_on', other: { key: 'item-2' } },
      { direction: 'incoming', kind: 'part_of', other: { key: 'item-3' } },
    ]);
    const othersItem = itemReadSchema.parse(
      await readJson(host => workflowRunsCommand(host, other, { item: 'item-1', json: true }))
    );
    expect(othersItem).toMatchObject({
      landing: { branch: 'feat/other' },
      merged: null,
      links: [],
    });

    // A run on no item is refused before anything is written.
    const facts = () =>
      rows<{ n: number }>(
        `SELECT (SELECT count(*) FROM remote_agent_item_landings)
              + (SELECT count(*) FROM remote_agent_item_merges)
              + (SELECT count(*) FROM remote_agent_item_links) AS n`
      )[0]?.n;
    const before = facts();
    for (const write of writes(bare.id)) {
      const refused = await write();
      expect(refused.exitCode).toBe(1);
      expect(JSON.parse(refused.stdout)).toEqual({ ok: false, error: 'no_item' });
    }
    expect(facts()).toBe(before);
  }
);

test.serial(
  "a forge merge records itself on the run's item, and the script calls after it keep it",
  async () => {
    const onItem = runsWithItems().find(row => row.item_key === 'item-1');
    const bare = runsWithItems().find(row => row.item_key === null);
    if (!onItem || !bare) throw new Error('Expected a run on item-1 and a run with no item');
    const facts = {
      change: 'https://github.com/acme/web/pull/3',
      commit: 'a'.repeat(40),
      at: '2026-11-20T09:30:00Z',
      branch: 'dev',
    };
    const nodeEnv = (runId: string): NodeJS.ProcessEnv => ({
      WORKFLOW_ID: runId,
      ARCHON_NODE_EXECUTION: JSON.stringify({ runId, path: 'land' }),
    });
    const record = async (runId: string, at: string | undefined) => {
      let outcome: Awaited<ReturnType<typeof recordRunMerge>> | undefined;
      const result = await invoke(async () => {
        outcome = await recordRunMerge(runId, { ...facts, at }, nodeEnv(runId));
      });
      expect(result.exitCode, result.stderr).toBe(0);
      return outcome;
    };
    const merges = () => rows<{ n: number }>('SELECT count(*) AS n FROM remote_agent_item_merges');

    // A plugin that reports no merge time leaves the item as it was, merge and landing alike.
    expect(await record(onItem.id, undefined)).toBe('no_merge_time');
    const untouched = await readItemJson('item-1');
    expect(untouched.merged).toBeNull();
    expect(untouched.landing).toBeNull();

    // A landing the operator set before the merge is recorded is kept, and the result says so.
    const env = nodeEnv(onItem.id);
    succeeded(
      await invoke(host =>
        workflowLandingCommand(
          host,
          projectRoot,
          { itemOf: onItem.id, branch: 'release/planned' },
          true,
          env
        )
      )
    );
    expect(await record(onItem.id, facts.at)).toBe('landing_kept');
    const item = await readItemJson('item-1');
    expect(item.merged).toMatchObject({
      change: facts.change,
      commit: facts.commit,
      at: '2026-11-20T09:30:00.000Z',
      via: 'forge',
      fromRun: { runId: onItem.id, nodePath: 'land' },
    });
    expect(item.landing).toMatchObject({ branch: 'release/planned', from: { kind: 'own' } });

    // A pack that still records the merge afterwards keeps the first; its own landing call
    // sets the branch, as `workflow landing` always does.
    const merged = await invoke(host =>
      workflowMergedCommand(
        host,
        projectRoot,
        { itemOf: onItem.id, change: facts.change, at: facts.at, commit: facts.commit },
        true,
        env
      )
    );
    expect(succeeded(merged)).toMatchObject({ recorded: false, merge: { via: 'forge' } });
    succeeded(
      await invoke(host =>
        workflowLandingCommand(host, projectRoot, { itemOf: onItem.id, branch: 'dev' }, true, env)
      )
    );
    const after = await readItemJson('item-1');
    expect(after.merged).toEqual(item.merged);
    expect(after.landing?.branch).toBe('dev');
    expect(merges()).toEqual([{ n: 1 }]);

    // A repeat, or the merge of another pull request, keeps both records as they are,
    // including a landing the operator corrected since.
    succeeded(
      await invoke(host =>
        workflowLandingCommand(
          host,
          projectRoot,
          { itemOf: onItem.id, branch: 'release/next' },
          true,
          env
        )
      )
    );
    for (const repeat of [facts, { ...facts, change: 'https://github.com/acme/web/pull/5' }]) {
      let outcome: Awaited<ReturnType<typeof recordRunMerge>> | undefined;
      await invoke(async () => {
        outcome = await recordRunMerge(onItem.id, { ...repeat, branch: 'main' }, env);
      });
      expect(outcome).toBe('already_recorded');
      const repeated = await readItemJson('item-1');
      expect(repeated.merged).toEqual(item.merged);
      expect(repeated.landing?.branch).toBe('release/next');
    }

    // A run on no item writes nothing.
    expect(await record(bare.id, facts.at)).toBe('no_item');
    expect(merges()).toEqual([{ n: 1 }]);

    // A merge recorded by hand, which writes no landing, gets its landing from the forge's
    // answer for that same change; the merge stays as it was recorded.
    const second = runsWithItems().find(row => row.item_key === 'item-2');
    if (!second) throw new Error('Expected a run on item-2');
    succeeded(
      await invoke(host =>
        workflowMergedCommand(
          host,
          projectRoot,
          { item: 'item-2', change: facts.change, at: facts.at },
          true,
          env
        )
      )
    );
    const byHand = (await readItemJson('item-2')).merged;
    expect(byHand).toMatchObject({ change: facts.change, via: 'cli' });
    let filled: Awaited<ReturnType<typeof recordRunMerge>> | undefined;
    const fill = await invoke(async () => {
      filled = await recordRunMerge(
        second.id,
        { ...facts, branch: 'release/1' },
        nodeEnv(second.id)
      );
    });
    expect(fill.exitCode, fill.stderr).toBe(0);
    expect(filled).toBe('recorded');
    const recovered = await readItemJson('item-2');
    expect(recovered.merged).toEqual(byHand);
    expect(recovered.landing?.branch).toBe('release/1');
  }
);
