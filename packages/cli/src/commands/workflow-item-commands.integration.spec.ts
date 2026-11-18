// @archon-test-isolated
/**
 * The item commands against a real SQLite store, in-process: `workflow run --item` and
 * `--supersedes`, `workflow runs --item` and `--item-of`, `workflow rule`, `workflow merged`,
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
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { removeTempTree } from '@archon/paths/test-utils';
import { itemReadSchema } from '@archon/workflows/item-read';
import { itemWindowSchema } from '@archon/workflows/item-window';
import { itemLinkSchema } from '@archon/workflows/schemas/item-link';
import { itemRulingSchema } from '@archon/workflows/schemas/item-ruling';
import { captureWorkflowCommand } from '../test-support/command';
import * as workflowScope from '../workflow-scope';
import { workflowLinkCommand } from './workflow-link';
import { workflowItemsCommand } from './workflow-items';
import { workflowMergedCommand } from './workflow-merged';
import { workflowRunsCommand } from './workflow-query';
import { workflowRuleCommand } from './workflow-rule';
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
// `test.serial`: it must not run beside another, even under `--concurrent`. (In Bun 1.4.2
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
    expect(JSON.parse(unknown.stdout)).toEqual({ ok: false, error: 'not_found', item: 'item-9' });
    const textUnknown = await invoke(host =>
      workflowRunsCommand(host, projectRoot, { item: 'item-9' })
    );
    expect(textUnknown.exitCode).toBe(1);
    expect(textUnknown.stderr).toContain("No item 'item-9'");
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
