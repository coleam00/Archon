// @archon-test-isolated
/**
 * Asks a completed run leaves on its item (`returns: { node, asks }`), against a real SQLite
 * store with every command in its own CLI process: the run opens them when it completes, the
 * list and the watch show them with no paused run behind them, and they are answered and
 * withdrawn by ref.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { itemReadSchema } from '@archon/workflows/item-read';

const CLI_PATH = resolve(import.meta.dir, '..', 'cli.ts');
const cleanupPaths: string[] = [];
const watchers = new Set<Bun.Subprocess>();

afterEach(async () => {
  for (const watcher of watchers) {
    watcher.kill('SIGKILL');
    await watcher.exited;
  }
  watchers.clear();
  for (const path of cleanupPaths.splice(0)) await removeTempTree(path);
});

const ask = (question: string) => ({
  question,
  context: 'The issue can be read two ways.',
  options: [
    { id: 'keep', does: 'Keep the flag.', cost: 'One more flag to maintain.' },
    { id: 'drop', does: 'Drop the flag.', cost: 'Older configs break.' },
  ],
  recommendation: { option: 'keep', why: 'Nothing depends on dropping it.' },
  artifacts: [],
});

/** A workflow whose script returns node leaves two asks; `later` runs after it. */
function leavesAsks(name: string, later = 'true'): string {
  const value = JSON.stringify({ summary: 'planned', asks: [ask('Keep it?'), ask('Rename it?')] });
  return (
    `name: ${name}\ndescription: Leaves two asks.\nmutates_checkout: false\n` +
    'returns: { node: decide, asks: asks }\nnodes:\n' +
    `  - id: decide\n    bash: |\n      echo '${value}'\n` +
    '    output_format:\n      type: object\n' +
    '      properties:\n        summary: { type: string }\n      required: [summary]\n' +
    `  - id: later\n    depends_on: [decide]\n    bash: "${later}"\n`
  );
}

interface Fixture {
  projectRoot: string;
  archonHome: string;
}

async function makeFixture(): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'archon-item-asks-')));
  cleanupPaths.push(root);
  const projectRoot = join(root, 'project');
  const workflows = join(projectRoot, '.archon', 'workflows');
  mkdirSync(workflows, { recursive: true });
  writeFileSync(join(workflows, 'leave-asks.yaml'), leavesAsks('leave-asks'));
  writeFileSync(join(workflows, 'leave-asks-fails.yaml'), leavesAsks('leave-asks-fails', 'exit 1'));
  expect(await Bun.spawn(['git', 'init', '-q'], { cwd: projectRoot }).exited).toBe(0);
  return { projectRoot, archonHome: join(root, 'home') };
}

function spawnCli(fixture: Fixture, args: string[]): Bun.Subprocess<'ignore', 'pipe', 'pipe'> {
  return Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd: fixture.projectRoot,
    env: {
      ...process.env,
      ARCHON_HOME: fixture.archonHome,
      DATABASE_URL: '',
      WORKFLOW_ID: '',
      ARCHON_NODE_EXECUTION: '',
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

async function runCli(
  fixture: Fixture,
  args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = spawnCli(fixture, args);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

type Line = Record<string, unknown> & { type: string };

function startWatch(fixture: Fixture) {
  const child = spawnCli(fixture, [
    'workflow',
    'attention',
    '--watch',
    '--json',
    '--all',
    '--protocol',
  ]);
  watchers.add(child);
  const lines: Line[] = [];
  void (async () => {
    const decoder = new TextDecoder();
    let text = '';
    for await (const chunk of child.stdout) {
      text += decoder.decode(chunk, { stream: true });
      for (let newline = text.indexOf('\n'); newline !== -1; newline = text.indexOf('\n')) {
        lines.push(JSON.parse(text.slice(0, newline)) as Line);
        text = text.slice(newline + 1);
      }
    }
  })();
  return {
    lines,
    async next(what: string, match: (line: Line) => boolean): Promise<Line> {
      for (const deadline = Date.now() + 60_000; Date.now() < deadline; await Bun.sleep(25)) {
        const found = lines.find(match);
        if (found) return found;
      }
      throw new Error(`no ${what} line: ${JSON.stringify(lines)}`);
    },
  };
}

interface ListedItem {
  ref: string;
  run?: unknown;
  message: string;
  item?: { key: string };
  askedIn?: { runId: string; workflow: string };
  options: { id: string; cost?: string }[];
}

async function listed(fixture: Fixture): Promise<ListedItem[]> {
  const { stdout, exitCode, stderr } = await runCli(fixture, [
    'workflow',
    'attention',
    '--all',
    '--json',
  ]);
  if (exitCode !== 0) throw new Error(stderr || stdout);
  return (JSON.parse(stdout) as { items: ListedItem[] }).items;
}

async function run(fixture: Fixture, workflow: string, item?: string) {
  return runCli(fixture, [
    'workflow',
    'run',
    workflow,
    'go',
    '--folder',
    ...(item === undefined ? [] : ['--item', item]),
  ]);
}

test('a run on an item opens its asks when it completes; they are listed, answered and withdrawn by ref', async () => {
  const fixture = await makeFixture();
  // The first database command creates the scratch schema.
  expect((await listed(fixture)).length).toBe(0);
  const watch = startWatch(fixture);
  await watch.next('ready', line => line.type === 'ready');

  const started = await run(fixture, 'leave-asks', 'issue-1');
  expect(started.exitCode).toBe(0);

  const items = await listed(fixture);
  // Both asks open at the same time; the queue does not order them within the set.
  expect(items.map(item => item.message).sort()).toEqual(['Keep it?', 'Rename it?']);
  for (const item of items) {
    expect(item.run).toBeUndefined();
    expect(item.item?.key).toBe('issue-1');
    expect(item.askedIn?.workflow).toBe('leave-asks');
    expect(item.options.map(option => option.id)).toEqual(['keep', 'drop', 'other']);
    expect(item.options[0]?.cost).toBe('One more flag to maintain.');
  }
  const first = items.find(item => item.message === 'Keep it?');
  const second = items.find(item => item.message === 'Rename it?');
  if (first === undefined || second === undefined) throw new Error('Expected two asks');
  // The text names each as an open ask on its item, and reads one by its ref.
  const text = (await runCli(fixture, ['workflow', 'attention'])).stdout;
  expect(text).toContain('2 item(s) need attention');
  expect(text).toContain(`${first.ref}  open ask`);
  expect(text).toContain('item issue-1');
  expect(text).not.toContain('paused');
  const one = await runCli(fixture, ['workflow', 'attention', first.ref]);
  expect(one.exitCode).toBe(0);
  expect(one.stdout).toContain('Keep it?');
  for (const item of items)
    await watch.next(
      'attention',
      line => line.type === 'attention' && (line.item as { ref?: string }).ref === item.ref
    );

  // The answer records who gave it and through which surface.
  const answered = await runCli(fixture, [
    'workflow',
    'answer',
    '--ref',
    first.ref,
    '--choose',
    'keep',
    '--as',
    'planner',
    '--json',
  ]);
  expect(JSON.parse(answered.stdout)).toEqual({
    ok: true,
    ref: first.ref,
    action: 'answer',
    settled: false,
  });
  expect(
    await watch.next('resolved', line => line.type === 'resolved' && line.ref === first.ref)
  ).toMatchObject({ reason: 'answered', answeredVia: 'cli', answeredBy: { declared: 'planner' } });

  // A different answer to an answered ask is refused; the same one changes nothing.
  const differently = await runCli(fixture, [
    'workflow',
    'answer',
    '--ref',
    first.ref,
    '--choose',
    'drop',
    '--json',
  ]);
  expect(differently.exitCode).toBe(1);
  expect(JSON.parse(differently.stdout)).toMatchObject({ ok: false, error: 'already_answered' });
  const again = await runCli(fixture, [
    'workflow',
    'answer',
    '--ref',
    first.ref,
    '--choose',
    'keep',
    '--json',
  ]);
  expect(JSON.parse(again.stdout)).toMatchObject({ ok: true, unchanged: true });

  const withdrawn = await runCli(fixture, [
    'workflow',
    'answer',
    '--withdraw',
    second.ref,
    '--json',
  ]);
  expect(JSON.parse(withdrawn.stdout)).toMatchObject({
    ok: true,
    action: 'withdraw',
    settled: true,
  });
  expect(
    await watch.next('resolved', line => line.type === 'resolved' && line.ref === second.ref)
  ).toMatchObject({ reason: 'withdrawn' });
  expect(await listed(fixture)).toEqual([]);

  // The item read shows both closes and the settled set, once.
  const read = itemReadSchema.parse(
    JSON.parse((await runCli(fixture, ['workflow', 'runs', '--item', 'issue-1', '--json'])).stdout)
  );
  expect(read.questions).toEqual([]);
  expect(read.answers.map(answer => answer.kind)).toEqual(['ask', 'ask', 'asks_settled']);
  expect(read.answers[2]).toMatchObject({ answered: 1, withdrawn: 1 });
  // The history says what was asked and what the chosen option does, from the ask's row.
  expect(read.answers[0]).toMatchObject({
    question: 'Keep it?',
    chosen: { id: 'keep', does: 'Keep the flag.' },
  });
  expect(read.answers[1]).toMatchObject({ question: 'Rename it?', withdrawn: true });
  const history = (await runCli(fixture, ['workflow', 'runs', '--item', 'issue-1'])).stdout;
  expect(history).toContain('ask "Keep it?" answered keep');
  expect(history).toContain('(Keep the flag.)');

  // A second completed run replaces the first run's open asks.
  expect((await run(fixture, 'leave-asks', 'issue-1')).exitCode).toBe(0);
  const replaced = (await listed(fixture)).map(item => item.ref);
  expect(replaced).toHaveLength(2);
  expect((await run(fixture, 'leave-asks', 'issue-1')).exitCode).toBe(0);
  const now = (await listed(fixture)).map(item => item.ref);
  expect(now.some(ref => replaced.includes(ref))).toBe(false);
  for (const ref of replaced)
    expect(
      await watch.next('resolved', line => line.type === 'resolved' && line.ref === ref)
    ).toMatchObject({ reason: 'replaced' });
}, 180_000);

test('a run that fails after its returns node ran leaves no ask', async () => {
  const fixture = await makeFixture();
  const result = await run(fixture, 'leave-asks-fails', 'issue-2');
  expect(result.exitCode).not.toBe(0);
  expect(await listed(fixture)).toEqual([]);
}, 120_000);

test('a workflow that declares asks is refused at start without an item', async () => {
  const fixture = await makeFixture();
  const result = await run(fixture, 'leave-asks');
  expect(result.exitCode).not.toBe(0);
  expect(`${result.stdout}${result.stderr}`).toContain(
    "declares returns.asks 'asks', so it runs on an item"
  );
  const runs = JSON.parse(
    (await runCli(fixture, ['workflow', 'runs', '--all', '--json'])).stdout
  ) as { runs: { status: string }[] };
  expect(runs.runs.map(stored => stored.status)).toEqual(['cancelled']);
}, 120_000);
