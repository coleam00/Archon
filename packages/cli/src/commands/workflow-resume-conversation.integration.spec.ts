/**
 * A resumed run keeps writing to its own conversation (#3328).
 *
 * The run row's `conversation_id` is the single record of which thread a run belongs
 * to, and it is written once at creation. An explicit resume that mints a fresh
 * conversation therefore does not move the run — it just sends the resumed segment
 * somewhere the run never references, and the run's own thread stops at the pause.
 *
 * These spawn the real CLI against a scratch `ARCHON_HOME` because the observable
 * outcome is rows: one run, one conversation, across a resume. An in-process test of
 * the options object would assert the call shape instead, which is the thing that was
 * already "correct" at three other sites while this one silently was not.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { requestDetachedRunStop } from '../utils/detached-run-control';

const CLI_ENTRY = join(import.meta.dir, '..', 'cli.ts');
const cleanupPaths: string[] = [];
const detachedRunIds = new Set<string>();

// One hook, in order: a detached owner still holding the fixture has to stop before its
// tree can go. Two hooks would leave registration order as the only thing keeping that
// correct.
afterEach(async () => {
  for (const runId of detachedRunIds) {
    try {
      const target = await requestDetachedRunStop(runId);
      await target.stop();
    } catch {
      // A completed owner has already removed its endpoint.
    }
  }
  detachedRunIds.clear();
  for (const path of cleanupPaths.splice(0)) await removeTempTree(path);
});

interface Fixture {
  repo: string;
  archonHome: string;
}

const WORKFLOW_NAME = 'resume-thread';

/**
 * A repo, a scratch `ARCHON_HOME`, and a workflow where `settle` succeeds and `boom`
 * fails. A run with no completed node is refused for an unrelated reason, so the pair
 * is what leaves a run a resume can actually continue.
 */
function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'archon-resume-conversation-'));
  cleanupPaths.push(root);
  const repo = join(root, 'repo');
  const archonHome = join(root, 'home');
  const workflowDir = join(repo, '.archon', 'workflows');
  mkdirSync(workflowDir, { recursive: true });
  mkdirSync(archonHome, { recursive: true });
  expect(spawnSync('git', ['init', '-q', '.'], { cwd: repo }).status).toBe(0);
  writeFileSync(
    join(workflowDir, `${WORKFLOW_NAME}.yaml`),
    [
      `name: ${WORKFLOW_NAME}`,
      'description: resume conversation threading',
      'nodes:',
      '  - id: settle',
      '    bash: echo settled',
      '  - id: boom',
      '    depends_on: [settle]',
      '    bash: exit 1',
      '',
    ].join('\n')
  );
  return { repo, archonHome };
}

function runCli(fixture: Fixture, args: string[]): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ARCHON_HOME: fixture.archonHome, ARCHON_TELEMETRY_DISABLED: '1' },
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

interface ThreadState {
  runId: string;
  runStatus: string;
  runConversationId: string;
  conversationIds: string[];
  /** `Dispatching workflow` messages inside the run's own thread. */
  dispatchMessages: number;
  /** The same messages in ANY thread — what tells a slow child from a misdirected one. */
  dispatchMessagesAnywhere: number;
}

/**
 * Open the fixture database for reading, willing to wait out a writer.
 *
 * The detached case reads while its child is still running, so a bare open raced the
 * child's own writes and failed with `SQLITE_BUSY` on a loaded CI runner. The timeout
 * is what makes these reads observations of a live database rather than a gamble on
 * landing between two transactions.
 */
function openDatabase(fixture: Fixture): Database {
  const database = new Database(join(fixture.archonHome, 'archon.db'), { readonly: true });
  database.exec('PRAGMA busy_timeout = 15000');
  return database;
}

/**
 * The run's thread as the database records it.
 *
 * Reads every conversation row, not just the run's, because the defect is an EXTRA
 * row: asserting only that the run still points somewhere valid would pass while a
 * second thread collected the resumed output.
 */
function readThreadState(fixture: Fixture): ThreadState {
  const database = openDatabase(fixture);
  try {
    const run = database
      .query<
        { id: string; status: string; conversation_id: string },
        [string]
      >('SELECT id, status, conversation_id FROM remote_agent_workflow_runs WHERE workflow_name = ? ORDER BY started_at DESC LIMIT 1')
      .get(WORKFLOW_NAME);
    if (!run) throw new Error('no run row was recorded');
    const conversationIds = database
      .query<{ id: string }, []>('SELECT id FROM remote_agent_conversations ORDER BY created_at')
      .all()
      .map(row => row.id);
    const countDispatches = database.query<{ total: number }, [string]>(
      "SELECT COUNT(*) AS total FROM remote_agent_messages WHERE conversation_id = ? AND content LIKE 'Dispatching workflow%'"
    );
    return {
      runId: run.id,
      runStatus: run.status,
      runConversationId: run.conversation_id,
      conversationIds,
      dispatchMessages: countDispatches.get(run.conversation_id)?.total ?? 0,
      dispatchMessagesAnywhere: conversationIds.reduce(
        (total, id) => total + (countDispatches.get(id)?.total ?? 0),
        0
      ),
    };
  } finally {
    database.close();
  }
}

/**
 * The platform id of a conversation row.
 *
 * The run row holds a database id while the CLI's `--conversation-id` and its detached
 * ack both speak the platform id, so comparing the two needs this hop.
 */
function readPlatformConversationId(fixture: Fixture, conversationId: string): string {
  const database = openDatabase(fixture);
  try {
    const row = database
      .query<
        { platform_conversation_id: string },
        [string]
      >('SELECT platform_conversation_id FROM remote_agent_conversations WHERE id = ?')
      .get(conversationId);
    if (!row) throw new Error(`no conversation row for ${conversationId}`);
    return row.platform_conversation_id;
  } finally {
    database.close();
  }
}

function removeRecordedConversation(fixture: Fixture, conversationId: string): void {
  const database = new Database(join(fixture.archonHome, 'archon.db'));
  try {
    database.exec('PRAGMA foreign_keys = OFF');
    database.query('DELETE FROM remote_agent_conversations WHERE id = ?').run(conversationId);
  } finally {
    database.close();
  }
}

function countConversations(fixture: Fixture): number {
  const database = openDatabase(fixture);
  try {
    return (
      database
        .query<{ total: number }, []>('SELECT COUNT(*) AS total FROM remote_agent_conversations')
        .get()?.total ?? 0
    );
  } finally {
    database.close();
  }
}

/** Run the workflow once so it fails, leaving exactly one run in exactly one thread. */
function seedFailedRun(fixture: Fixture): ThreadState {
  const first = runCli(fixture, [
    'workflow',
    'run',
    WORKFLOW_NAME,
    '--cwd',
    fixture.repo,
    '--no-worktree',
  ]);
  // The node must genuinely execute and fail here. A non-zero status alone would also
  // accept the workflow never loading, which leaves nothing for a resume to continue.
  expect(first.output).toContain('boom');
  expect(first.status).not.toBe(0);
  const before = readThreadState(fixture);
  expect(before.conversationIds).toEqual([before.runConversationId]);
  expect(before.dispatchMessages).toBe(1);
  return before;
}

/**
 * Block until a detached child has announced its resumed segment.
 *
 * That announcement is the last thing the thread decision can affect: the child opens
 * its conversation and then dispatches into it, so once a second `Dispatching workflow`
 * message exists anywhere, the conversation rows are already final and the assertions
 * below are reading a settled picture rather than racing the run to its end.
 *
 * The wait counts messages in ANY thread on purpose. A child that opened a second
 * conversation still announces, so this returns and lets the assertions name the split;
 * waiting on the run's own thread would turn the defect into a timeout, which reads as
 * a flaky test rather than as a wrong thread.
 */
async function waitForDetachedDispatch(fixture: Fixture): Promise<ThreadState> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  for (;;) {
    let state: ThreadState | undefined;
    try {
      state = readThreadState(fixture);
      if (state.dispatchMessagesAnywhere >= 2) return state;
    } catch (error) {
      // The child owns the database while it runs. `busy_timeout` waits out a held
      // lock, but this loop is already a retry, so a read that still gives up is a
      // reason to look again rather than to fail the test.
      lastError = error;
    }
    if (Date.now() > deadline) {
      throw new Error(
        state
          ? `the detached child never announced its resume: run status ${state.runStatus}, ` +
              `${String(state.dispatchMessagesAnywhere)} dispatch message(s) across ` +
              `${String(state.conversationIds.length)} conversation(s)`
          : `the fixture database stayed unreadable: ${String(lastError)}`
      );
    }
    await Bun.sleep(100);
  }
}

/**
 * Assert the resume stayed in the run's thread.
 *
 * `dispatchMessages` is the resumed segment itself: the continuation announces
 * `Dispatching workflow` to whichever conversation it opened, so a second one inside
 * the run's own thread is the positive evidence that the output landed there rather
 * than merely that no extra row appeared.
 */
function expectResumedInPlace(after: ThreadState, before: ThreadState): void {
  expect(after.runId).toBe(before.runId);
  expect(after.runConversationId).toBe(before.runConversationId);
  expect(after.conversationIds).toEqual(before.conversationIds);
  expect(after.dispatchMessages).toBe(2);
}

describe('resumed runs keep one conversation', () => {
  test('a continuation stops when its recorded conversation is missing', () => {
    const fixture = makeFixture();
    const before = seedFailedRun(fixture);
    removeRecordedConversation(fixture, before.runConversationId);

    const resumed = runCli(fixture, ['workflow', 'resume', before.runId, '--cwd', fixture.repo]);
    expect(resumed.status).not.toBe(0);
    expect(resumed.output).toContain(
      `Conversation '${before.runConversationId}' for workflow run '${before.runId}' no longer exists.`
    );
    expect(countConversations(fixture)).toBe(0);
  }, 120_000);

  test('workflow resume <run-id> continues the run existing thread', async () => {
    const fixture = makeFixture();
    const before = seedFailedRun(fixture);

    const resumed = runCli(fixture, ['workflow', 'resume', before.runId, '--cwd', fixture.repo]);
    // The resume re-executes the failed node, so it fails again — the run stays in the
    // same state it started in and the only thing under test is where the output went.
    expect(resumed.output).toContain("Bash node 'boom' failed");

    expectResumedInPlace(readThreadState(fixture), before);
  }, 120_000);

  test('workflow run <name> --resume continues the run existing thread', async () => {
    const fixture = makeFixture();
    const before = seedFailedRun(fixture);

    const resumed = runCli(fixture, [
      'workflow',
      'run',
      WORKFLOW_NAME,
      '--cwd',
      fixture.repo,
      '--no-worktree',
      '--resume',
    ]);
    expect(resumed.output).toContain("Bash node 'boom' failed");

    expectResumedInPlace(readThreadState(fixture), before);
  }, 120_000);

  // The detached launch is the one form where the id is not used in this process: the
  // parent resolves it and pins it onto the child's argv, and the child is what opens
  // the conversation. Nothing else here would catch that pin carrying a fresh id.
  test('workflow run <name> --resume --detach hands the child the run existing thread', async () => {
    const fixture = makeFixture();
    const before = seedFailedRun(fixture);
    // Read before the launch: nothing is writing yet, and the thread the ack must name
    // is already decided.
    const platformConversationId = readPlatformConversationId(fixture, before.runConversationId);

    const launched = runCli(fixture, [
      'workflow',
      'run',
      WORKFLOW_NAME,
      '--cwd',
      fixture.repo,
      '--no-worktree',
      '--resume',
      '--detach',
      '--json',
    ]);
    if (launched.status !== 0) throw new Error(`detached launch failed: ${launched.output}`);
    const ack = JSON.parse(launched.output.trim()) as { runId: string; conversationId: string };
    detachedRunIds.add(ack.runId);
    // The ack is the launch's public contract: it tells an automation which run and which
    // thread the background work belongs to, so both must name what already exists.
    expect(ack.runId).toBe(before.runId);
    expect(ack.conversationId).toBe(platformConversationId);

    // The snapshot the wait already took: at that point the conversation rows are final,
    // so asserting on it beats a second read that would race the child to its exit.
    expectResumedInPlace(await waitForDetachedDispatch(fixture), before);
  }, 120_000);

  test('workflow resume <run-id> --detach keeps the child in the run existing thread', async () => {
    const fixture = makeFixture();
    const before = seedFailedRun(fixture);

    const launched = runCli(fixture, [
      'workflow',
      'resume',
      before.runId,
      '--cwd',
      fixture.repo,
      '--detach',
      '--json',
    ]);
    if (launched.status !== 0) throw new Error(`detached resume failed: ${launched.output}`);
    const ack = JSON.parse(launched.output.trim()) as {
      ok: boolean;
      runId: string;
      action: string;
      detached: boolean;
    };
    detachedRunIds.add(ack.runId);
    expect(ack).toMatchObject({
      ok: true,
      runId: before.runId,
      action: 'resume',
      detached: true,
    });

    expectResumedInPlace(await waitForDetachedDispatch(fixture), before);
  }, 120_000);
});
