import { afterAll, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';

const originalArchonHome = process.env.ARCHON_HOME;
const originalDatabaseUrl = process.env.DATABASE_URL;
const archonHome = await mkdtemp(join(tmpdir(), 'archon-github-check-signal-'));
process.env.ARCHON_HOME = archonHome;
delete process.env.DATABASE_URL;

const { GitHubAdapter } = await import('./adapter');
const {
  closeDatabase,
  createWorkflowRun,
  getDatabase,
  getWorkflowRun,
  pauseWorkflowRunForWait,
  updateWorkflowRun,
} = await import('@archon/core/db');
const { persistWorkflowEvent } = await import('@archon/core/db/workflow-events');

afterAll(async () => {
  await closeDatabase();
  await removeTempTree(archonHome);
  if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalArchonHome;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe('GitHub completed-check workflow signal — real SQLite', () => {
  test('signals only the persisted wait that owns the qualified pull request', async () => {
    const database = getDatabase();
    await database.query(
      `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
       VALUES ('check-signal-conversation', 'web', 'check-signal-conversation')`,
      []
    );

    const now = Date.now();
    const wait = {
      owner: 'loop_group' as const,
      nodeId: 'await-checks',
      bodyWaitId: 'ci-pause',
      iteration: 1,
      sessionId: null,
      sessionProvider: null,
      kind: 'event' as const,
      event: 'checks.complete',
      waitingSince: new Date(now - 60_000).toISOString(),
      resumeAt: new Date(now + 3_600_000).toISOString(),
    };
    const seedRun = async (id: string, repositoryPath: string): Promise<void> => {
      await createWorkflowRun({
        id,
        workflow_name: 'archon-deliver',
        conversation_id: 'check-signal-conversation',
        user_message: 'test check signal',
      });
      await updateWorkflowRun(id, { status: 'running' });
      await persistWorkflowEvent({
        workflow_run_id: id,
        event_type: 'node_completed',
        step_name: 'pr',
        data: {
          output_type: 'pull-request',
          structured_output: {
            repo: { host: 'github.com', path: repositoryPath },
            number: 42,
          },
        },
      });
      await pauseWorkflowRunForWait(id, wait, {
        kind: 'started',
        stepName: 'await-checks.ci-pause',
      });
    };

    await seedRun('owned-pr-run', 'example/repo');
    await seedRun('different-repo-run', 'other/repo');

    const payload = JSON.stringify({
      action: 'completed',
      check_run: {
        status: 'completed',
        conclusion: 'success',
        completed_at: new Date(now).toISOString(),
        pull_requests: [{ number: 42 }],
      },
      repository: { full_name: 'example/repo' },
      sender: { login: 'github-actions[bot]' },
    });
    const secret = 'integration-webhook-secret';
    const signature = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
    const adapter = new GitHubAdapter({ kind: 'pat', token: 'unused-test-token' }, secret, {
      acquireLock: async (_id: string, handler: () => Promise<void>) => {
        await handler();
        return { status: 'started' as const };
      },
    });

    await adapter.handleWebhook(payload, signature, 'check-signal-delivery', 'check_run');

    const ownedRun = await getWorkflowRun('owned-pr-run');
    expect(ownedRun?.metadata.wait).toMatchObject({
      ...wait,
      payload: { conclusion: 'success' },
      signaledAt: expect.any(String),
    });
    const differentRun = await getWorkflowRun('different-repo-run');
    expect(differentRun?.metadata.wait).toEqual(wait);
  });
});
