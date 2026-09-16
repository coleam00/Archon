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

const CLI_ENTRY = join(import.meta.dir, '..', 'cli.ts');
const cleanupPaths: string[] = [];

afterEach(async () => {
  for (const path of cleanupPaths.splice(0)) await removeTempTree(path);
});

interface Fixture {
  repo: string;
  archonHome: string;
}

/** `settle` succeeds and `boom` fails, which is what leaves a run that can be resumed. */
const WORKFLOW_NAME = 'resume-thread';

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
  runConversationId: string;
  conversationIds: string[];
  dispatchMessages: number;
}

/**
 * The run's thread as the database records it.
 *
 * Reads every conversation row, not just the run's, because the defect is an EXTRA
 * row: asserting only that the run still points somewhere valid would pass while a
 * second thread collected the resumed output.
 */
function readThreadState(fixture: Fixture): ThreadState {
  // No concurrent writer: each CLI invocation above is a finished synchronous child.
  const database = new Database(join(fixture.archonHome, 'archon.db'), { readonly: true });
  try {
    const run = database
      .query<
        { id: string; conversation_id: string },
        [string]
      >('SELECT id, conversation_id FROM remote_agent_workflow_runs WHERE workflow_name = ? ORDER BY started_at DESC LIMIT 1')
      .get(WORKFLOW_NAME);
    if (!run) throw new Error('no run row was recorded');
    const conversationIds = database
      .query<{ id: string }, []>('SELECT id FROM remote_agent_conversations ORDER BY created_at')
      .all()
      .map(row => row.id);
    const dispatchMessages = database
      .query<
        { total: number },
        [string]
      >("SELECT COUNT(*) AS total FROM remote_agent_messages WHERE conversation_id = ? AND content LIKE 'Dispatching workflow%'")
      .get(run.conversation_id);
    return {
      runId: run.id,
      runConversationId: run.conversation_id,
      conversationIds,
      dispatchMessages: dispatchMessages?.total ?? 0,
    };
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
 * Assert the resume stayed in the run's thread.
 *
 * `dispatchMessages` is the resumed segment itself: the continuation announces
 * `Dispatching workflow` to whichever conversation it opened, so a second one inside
 * the run's own thread is the positive evidence that the output landed there rather
 * than merely that no extra row appeared.
 */
function expectResumedInPlace(fixture: Fixture, before: ThreadState): void {
  const after = readThreadState(fixture);
  expect(after.runId).toBe(before.runId);
  expect(after.runConversationId).toBe(before.runConversationId);
  expect(after.conversationIds).toEqual(before.conversationIds);
  expect(after.dispatchMessages).toBe(2);
}

describe('resumed runs keep one conversation', () => {
  test('workflow resume <run-id> continues the run existing thread', async () => {
    const fixture = makeFixture();
    const before = seedFailedRun(fixture);

    const resumed = runCli(fixture, ['workflow', 'resume', before.runId, '--cwd', fixture.repo]);
    // The resume re-executes the failed node, so it fails again — the run stays in the
    // same state it started in and the only thing under test is where the output went.
    expect(resumed.output).toContain("Bash node 'boom' failed");

    expectResumedInPlace(fixture, before);
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

    expectResumedInPlace(fixture, before);
  }, 120_000);
});
