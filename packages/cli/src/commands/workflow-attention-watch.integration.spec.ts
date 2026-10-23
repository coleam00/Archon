/**
 * `archon workflow attention --watch` as its own process against a real SQLite store.
 *
 * The runs here are launched after the watch started, by other processes, so every line
 * the watch prints can only have come from the persisted store: no in-process emitter
 * is shared between the watcher and the run.
 */
import { multiAttentionWorkflows } from '../test-support/multi-attention-fixture';
import { attentionQueueItemSchema } from '@archon/workflows/attention-queue';
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { requestRunLiveOwnerStop } from '@archon/core/services/run-live-owner';
import { requestDetachedRunStop } from '@archon/core/services/run-owner-stop';

const CLI_PATH = resolve(import.meta.dir, '..', 'cli.ts');
const cleanupPaths: string[] = [];
const activeRunIds = new Set<string>();
const watchers = new Set<Bun.Subprocess>();

afterEach(async () => {
  for (const watcher of watchers) {
    watcher.kill('SIGKILL');
    await watcher.exited;
  }
  watchers.clear();
  for (const runId of activeRunIds) {
    try {
      const target = await requestDetachedRunStop(runId);
      await target.stop();
    } catch {
      // A finished owner has already removed its endpoint.
    }
  }
  activeRunIds.clear();
  for (const path of cleanupPaths.splice(0)) await removeTempTree(path);
});

interface Fixture {
  projectRoot: string;
  archonHome: string;
}

function makeFixture(workflows: Record<string, string>): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'archon-attention-watch-'));
  cleanupPaths.push(root);
  const projectRoot = join(root, 'project');
  const workflowsDir = join(projectRoot, '.archon', 'workflows');
  mkdirSync(workflowsDir, { recursive: true });
  for (const [name, body] of Object.entries(workflows))
    writeFileSync(join(workflowsDir, `${name}.yaml`), body);
  return { projectRoot, archonHome: join(root, 'home') };
}

function spawnCli(fixture: Fixture, args: string[]): Bun.Subprocess<'ignore', 'pipe', 'pipe'> {
  return Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd: fixture.projectRoot,
    env: { ...process.env, ARCHON_HOME: fixture.archonHome },
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

async function launchDetached(fixture: Fixture, workflow: string): Promise<string> {
  const { exitCode, stdout, stderr } = await runCli(fixture, [
    'workflow',
    'run',
    workflow,
    'attention watch integration',
    '--folder',
    '--detach',
    '--json',
  ]);
  if (exitCode !== 0) throw new Error(`Detached launcher failed: ${stderr || stdout}`);
  const { runId } = JSON.parse(stdout.trim()) as { runId: string };
  activeRunIds.add(runId);
  return runId;
}

/** Poll `workflow get` until the run reports `status`. */
async function statusOf(fixture: Fixture, runId: string, status: string): Promise<void> {
  let last = '';
  for (const deadline = Date.now() + 60_000; Date.now() < deadline; await Bun.sleep(100)) {
    const { stdout } = await runCli(fixture, ['workflow', 'get', runId, '--json']);
    last = stdout;
    if ((JSON.parse(stdout) as { status?: string }).status === status) return;
  }
  throw new Error(`run ${runId} never reported ${status}: ${last}`);
}

type Line = Record<string, unknown> & { type: string; cursor?: string };

interface Watcher {
  lines: Line[];
  next(what: string, match: (line: Line) => boolean, timeoutMs?: number): Promise<Line>;
  /**
   * SIGTERM, which the watch answers by exiting 0. Windows has no signal to deliver: the
   * kill terminates the child, so only POSIX proves the graceful exit.
   */
  stop(): Promise<void>;
}

/** Start `workflow attention --watch --json` and parse its stdout line by line. */
function startWatch(fixture: Fixture, extra: string[] = []): Watcher {
  const child = spawnCli(fixture, [
    'workflow',
    'attention',
    '--watch',
    '--json',
    '--all',
    ...extra,
  ]);
  watchers.add(child);
  const lines: Line[] = [];
  const stdout = (async (): Promise<void> => {
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
  const stderr = new Response(child.stderr).text();
  return {
    lines,
    async next(what, match, timeoutMs = 60_000): Promise<Line> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = lines.find(match);
        if (found) return found;
        if (child.exitCode !== null || Date.now() > deadline)
          throw new Error(
            `no ${what} line (exit ${String(child.exitCode)}): ${JSON.stringify(lines)}\n${await Promise.race([stderr, Bun.sleep(100).then(() => '')])}`
          );
        await Bun.sleep(25);
      }
    },
    async stop(): Promise<void> {
      child.kill('SIGTERM');
      const exitCode = await child.exited;
      await stdout;
      watchers.delete(child);
      if (process.platform !== 'win32') expect(exitCode).toBe(0);
    },
  };
}

const ofRun =
  (runId: string, type: string) =>
  (line: Line): boolean =>
    line.type === type &&
    (line.runId === runId || (line.item as { runId?: string } | undefined)?.runId === runId);

const ASK =
  'name: watch-ask\ndescription: Attention watch fixture.\nnodes:\n' +
  '  - id: warmup\n    bash: "echo ready"\n' +
  '  - id: ask\n    depends_on: [warmup]\n    wait:\n      attention: "Ship it?"\n' +
  '  - id: finish\n    depends_on: [ask]\n    bash: "echo done"\n';

test('a run launched after the watch reaches it from the store alone, and --after replays it', async () => {
  const fixture = makeFixture({ 'watch-ask': ASK });
  const watch = startWatch(fixture);
  await watch.next('ready', line => line.type === 'ready');

  const runId = await launchDetached(fixture, 'watch-ask');
  const opened = await watch.next('attention', ofRun(runId, 'attention'));
  const single = await runCli(fixture, ['workflow', 'attention', runId, '--json']);
  expect(opened.item).toEqual((JSON.parse(single.stdout) as { item: unknown }).item);
  expect(opened.project).toEqual((opened.item as { project: unknown }).project);

  const occurrence = (opened.item as { occurrence: string }).occurrence;
  const answered = await runCli(fixture, [
    'workflow',
    'answer',
    runId,
    '--occurrence',
    occurrence,
    '--text',
    'yes',
  ]);
  if (answered.exitCode !== 0) throw new Error(`answer failed: ${answered.stderr}`);
  activeRunIds.delete(runId);
  expect(await watch.next('resolved', ofRun(runId, 'resolved'))).toMatchObject({
    occurrence,
    reason: 'answered',
    answeredVia: 'cli',
  });
  const terminal = await watch.next('terminal', ofRun(runId, 'terminal'));
  const got = JSON.parse((await runCli(fixture, ['workflow', 'get', runId, '--json'])).stdout) as {
    status: string;
    outcome: string | null;
  };
  expect(terminal).toMatchObject({ status: got.status, outcome: got.outcome });

  await watch.stop();
  expect(
    JSON.parse((await runCli(fixture, ['workflow', 'get', runId, '--json'])).stdout) as object
  ).toEqual(got);

  // Everything after the attention line happened before this watch started.
  const replay = startWatch(fixture, ['--after', String(opened.cursor)]);
  const replayed = await replay.next('replayed terminal', ofRun(runId, 'terminal'));
  expect(replayed).toEqual(terminal);
  expect(replay.lines.filter(ofRun(runId, 'attention'))).toEqual([]);
  await replay.stop();
}, 180_000);

test('the text stream reports a failed run resuming', async () => {
  const fixture = makeFixture({
    'watch-fail':
      'name: watch-fail\ndescription: Resume stream fixture.\nnodes:\n' +
      '  - id: warmup\n    bash: "echo ready"\n' +
      '  - id: fail\n    depends_on: [warmup]\n    bash: "exit 1"\n',
  });
  const child = spawnCli(fixture, ['workflow', 'attention', '--watch', '--all']);
  watchers.add(child);
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const until = async (expected: string): Promise<void> => {
    while (!text.includes(expected)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`stdout ended before ${expected}: ${text}`);
      text += decoder.decode(value, { stream: true });
    }
  };
  try {
    await until('Ctrl-C stops.');
    const runId = await launchDetached(fixture, 'watch-fail');
    const failed = `Run ${runId} failed`;
    await until(`${failed}: node fail (exec_failed). Workflow watch-fail.`);
    const resumed = await runCli(fixture, [
      'workflow',
      'resume',
      runId,
      '--cwd',
      fixture.projectRoot,
      '--detach',
      '--json',
    ]);
    if (resumed.exitCode !== 0)
      throw new Error(`resume failed: ${resumed.stderr || resumed.stdout}`);
    const running = `Run ${runId} resumed (running).`;
    await until(running);
    expect(text.indexOf(failed)).toBeLessThan(text.indexOf(running));
    await statusOf(fixture, runId, 'failed');
    activeRunIds.delete(runId);
  } finally {
    reader.releaseLock();
    child.kill('SIGTERM');
    const exitCode = await child.exited;
    watchers.delete(child);
    if (process.platform !== 'win32') expect(exitCode).toBe(0);
  }
}, 180_000);

test('the text stream exits 0 at its first line after the reader closes stdout', async () => {
  const fixture = makeFixture({ 'watch-ask': ASK });
  const child = spawnCli(fixture, ['workflow', 'attention', '--watch', '--all']);
  watchers.add(child);
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('Ctrl-C stops.')) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`stdout ended before ready: ${text}`);
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel();

  await launchDetached(fixture, 'watch-ask');
  expect(await child.exited).toBe(0);
  watchers.delete(child);
}, 180_000);

test('a cursor this install did not issue exits 4 with a cursor_invalid line', async () => {
  const fixture = makeFixture({});
  const { exitCode, stdout } = await runCli(fixture, [
    'workflow',
    'attention',
    '--watch',
    '--json',
    '--after',
    'file:1.0',
  ]);
  expect(exitCode).toBe(4);
  expect(stdout.trim()).toBe('{"type":"error","error":"cursor_invalid"}');
}, 60_000);

test('an owner killed mid-run is reported once as owner_lost and the row stays running', async () => {
  if (process.platform === 'win32') return;
  const fixture = makeFixture({
    'watch-hold':
      'name: watch-hold\ndescription: Owner-loss fixture.\nnodes:\n' +
      '  - id: hold\n    bash: "sleep 60; echo done"\n',
  });
  const watch = startWatch(fixture);
  await watch.next('ready', line => line.type === 'ready');
  const runId = await launchDetached(fixture, 'watch-hold');
  await statusOf(fixture, runId, 'running');

  const lease = await requestRunLiveOwnerStop(runId);
  const ownerPid = lease.pid;
  lease.release();
  process.kill(-ownerPid, 'SIGKILL');

  expect(await watch.next('owner_lost', ofRun(runId, 'owner_lost'))).toMatchObject({
    observedStatus: 'running',
  });
  await Bun.sleep(3000);
  expect(watch.lines.filter(ofRun(runId, 'owner_lost'))).toHaveLength(1);
  await statusOf(fixture, runId, 'running');
  await watch.stop();

  const abandoned = await runCli(fixture, ['workflow', 'abandon', runId]);
  if (abandoned.exitCode !== 0) throw new Error(`abandon failed: ${abandoned.stderr}`);
  activeRunIds.delete(runId);
}, 180_000);

test('fan-out questions have independent stream identities and resolve second first', async () => {
  const fixture = makeFixture(multiAttentionWorkflows);
  const watch = startWatch(fixture);
  await watch.next('ready', line => line.type === 'ready');
  const parentId = await launchDetached(fixture, 'questions');
  const opened = [];
  for (const index of [0, 1]) {
    const line = await watch.next(`question ${index}`, line => {
      if (line.type !== 'attention') return false;
      const item = attentionQueueItemSchema.parse(line.item);
      return item.fanOut?.parentRunId === parentId && item.fanOut.index === index;
    });
    expect(line).toMatchObject({ workflow: 'question', parentRunId: parentId });
    opened.push(attentionQueueItemSchema.parse(line.item));
  }
  const [first, second] = opened;
  expect(first.runId).not.toBe(second.runId);
  const answer = async (item: typeof first, choose: string) => {
    if (item.kind !== 'attention') throw new Error('Expected attention');
    const answered = await runCli(fixture, [
      'workflow',
      'answer',
      item.runId,
      '--occurrence',
      item.occurrence,
      '--choose',
      choose,
    ]);
    expect(answered, answered.stdout + answered.stderr).toMatchObject({ exitCode: 0 });
    expect(await watch.next('resolved', ofRun(item.runId, 'resolved'))).toMatchObject({
      occurrence: item.occurrence,
      reason: 'answered',
    });
  };
  await answer(second, 'defer');
  const remaining = await runCli(fixture, ['workflow', 'attention', first.runId, '--json']);
  expect(remaining.exitCode).toBe(0);
  expect(JSON.parse(remaining.stdout).item).toEqual(first);
  expect(watch.lines.filter(ofRun(first.runId, 'resolved'))).toEqual([]);
  await statusOf(fixture, parentId, 'paused');
  await answer(first, 'accept');
  expect(await watch.next('parent completed', ofRun(parentId, 'terminal'))).toMatchObject({
    workflow: 'questions',
    parentRunId: null,
  });
  await statusOf(fixture, parentId, 'completed');
  activeRunIds.delete(parentId);
  await watch.stop();
}, 60_000);
