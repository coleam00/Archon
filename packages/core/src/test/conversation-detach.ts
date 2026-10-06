import { beforeEach, describe, expect, test } from 'bun:test';
import type { IDatabase } from '../db/adapters/types';
import type { TransactionQuery } from '../db/resource-slots';
import { detachConversationProject } from '../db/conversations';
import { createWorkflowRun } from '../db/workflows';
import { admitResourceStart } from '../db/resource-starts';
import type { ApprovalContext, WorkflowWaitContext } from '@archon/workflows/schemas/workflow-run';

function intercept(
  db: IDatabase,
  hook: (sql: string, query: TransactionQuery) => Promise<void>,
  phase: 'before' | 'after' = 'before'
): IDatabase {
  return {
    dialect: db.dialect,
    sql: db.sql,
    query: db.query.bind(db),
    close: db.close.bind(db),
    withTransaction: fn =>
      db.withTransaction(query =>
        fn(async <U>(sql: string, params?: unknown[]) => {
          if (phase === 'before') await hook(sql, query);
          const result = await query<U>(sql, params);
          if (phase === 'after') await hook(sql, query);
          return result;
        })
      ),
  };
}

function barrier(): { reached: Promise<void>; release: () => void; pause: () => Promise<void> } {
  const reached = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return {
    reached: reached.promise,
    release: () => released.resolve(),
    pause: async () => {
      reached.resolve();
      await released.promise;
    },
  };
}

export function conversationDetachTests(
  getConnections: () => { db: IDatabase; other: IDatabase },
  useDatabase: (db: IDatabase) => void
): void {
  let db: IDatabase;
  let other: IDatabase;
  let conversationId: string;
  let workerId: string;
  let projectId: string;
  let sessionId: string;
  let projectName: string;
  let userId: string;
  const input = (): Parameters<typeof detachConversationProject>[0] => ({
    conversationId,
    projectName,
    platformType: 'telegram',
  });

  beforeEach(async () => {
    ({ db, other } = getConnections());
    useDatabase(db);
    conversationId = crypto.randomUUID();
    workerId = crypto.randomUUID();
    projectId = crypto.randomUUID();
    sessionId = crypto.randomUUID();
    userId = crypto.randomUUID();
    await db.query("INSERT INTO remote_agent_users (id, display_name) VALUES ($1, 'Test')", [
      userId,
    ]);
    projectName = `My App ${projectId}`;
    await db.query(
      "INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, '/project')",
      [projectId, projectName]
    );
    for (const id of [conversationId, workerId]) {
      await db.query(
        `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id, codebase_id, cwd)
        VALUES ($1, 'telegram', $2, $3, '/override')`,
        [id, `platform-${id}`, projectId]
      );
    }
    await db.query(
      `INSERT INTO remote_agent_sessions (id, conversation_id, codebase_id, ai_assistant_type)
      VALUES ($1, $2, $3, 'claude')`,
      [sessionId, conversationId, projectId]
    );
  });

  const snapshot = async (): Promise<unknown> => {
    const conversation = await db.query('SELECT * FROM remote_agent_conversations WHERE id = $1', [
      conversationId,
    ]);
    const sessions = await db.query(
      'SELECT * FROM remote_agent_sessions WHERE conversation_id = $1',
      [conversationId]
    );
    const runs = await db.query(
      'SELECT * FROM remote_agent_workflow_runs WHERE conversation_id = $1 OR parent_conversation_id = $1 ORDER BY id',
      [conversationId]
    );
    return { conversations: conversation.rows, sessions: sessions.rows, runs: runs.rows };
  };
  const expectBound = async (): Promise<void> => {
    const row = await db.query<{ codebase_id: string; cwd: string; active: boolean | number }>(
      `SELECT c.codebase_id, c.cwd, s.active FROM remote_agent_conversations c
       JOIN remote_agent_sessions s ON s.conversation_id = c.id WHERE c.id = $1`,
      [conversationId]
    );
    expect(row.rows[0].codebase_id).toBe(projectId);
    expect(row.rows[0].cwd).toBe('/override');
    expect(Boolean(row.rows[0].active)).toBe(true);
  };

  describe('atomic conversation project detach', () => {
    test('clears only the target, deactivates session before clear, retains history and project', async () => {
      await db.query(
        "INSERT INTO remote_agent_messages (conversation_id, role, content) VALUES ($1, 'user', 'history')",
        [conversationId]
      );
      useDatabase(
        intercept(db, async (sql, query) => {
          if (sql.includes('SET codebase_id = NULL')) {
            const session = await query<{ active: boolean | number }>(
              'SELECT active FROM remote_agent_sessions WHERE id = $1',
              [sessionId]
            );
            expect(Boolean(session.rows[0].active)).toBe(false);
          }
        })
      );
      expect(await detachConversationProject(input())).toEqual({ status: 'detached', projectName });
      const target = await db.query<{
        codebase_id: string | null;
        cwd: string | null;
        isolation_env_id: string | null;
      }>('SELECT * FROM remote_agent_conversations WHERE id = $1', [conversationId]);
      expect(target.rows[0]).toMatchObject({
        codebase_id: null,
        cwd: null,
        isolation_env_id: null,
      });
      const session = await db.query<{ active: boolean | number; ended_reason: string }>(
        'SELECT * FROM remote_agent_sessions WHERE id = $1',
        [sessionId]
      );
      expect(Boolean(session.rows[0].active)).toBe(false);
      expect(session.rows[0].ended_reason).toBe('project-changed');
      expect(
        (await db.query('SELECT id FROM remote_agent_codebases WHERE id = $1', [projectId])).rows
      ).toHaveLength(1);
      expect(
        (
          await db.query<{ codebase_id: string }>(
            'SELECT codebase_id FROM remote_agent_conversations WHERE id = $1',
            [workerId]
          )
        ).rows[0].codebase_id
      ).toBe(projectId);
      expect(
        (
          await db.query('SELECT id FROM remote_agent_messages WHERE conversation_id = $1', [
            conversationId,
          ])
        ).rows
      ).toHaveLength(1);
    });

    test('deactivates every active provider session before clearing the binding', async () => {
      const secondSessionId = crypto.randomUUID();
      await db.query(
        `INSERT INTO remote_agent_sessions (id, conversation_id, codebase_id, ai_assistant_type)
         VALUES ($1, $2, $3, 'codex')`,
        [secondSessionId, conversationId, projectId]
      );
      useDatabase(
        intercept(db, async (sql, query) => {
          if (sql.includes('SET codebase_id = NULL')) {
            const active = await query(
              'SELECT id FROM remote_agent_sessions WHERE conversation_id = $1 AND active = true',
              [conversationId]
            );
            expect(active.rows).toHaveLength(0);
          }
        })
      );
      expect((await detachConversationProject(input())).status).toBe('detached');
      const sessions = await db.query<{
        active: boolean | number;
        ended_at: string | null;
        ended_reason: string;
      }>('SELECT * FROM remote_agent_sessions WHERE conversation_id = $1', [conversationId]);
      expect(sessions.rows).toHaveLength(2);
      for (const session of sessions.rows) {
        expect(Boolean(session.active)).toBe(false);
        expect(session.ended_at).not.toBeNull();
        expect(session.ended_reason).toBe('project-changed');
      }
    });

    for (const name of ['none', 'clear', '-']) {
      test(`detaches a project literally named ${JSON.stringify(name)}`, async () => {
        await db.query('UPDATE remote_agent_codebases SET name = $1 WHERE id = $2', [
          name,
          projectId,
        ]);
        expect(await detachConversationProject({ ...input(), projectName: name })).toEqual({
          status: 'detached',
          projectName: name,
        });
        const target = await db.query<{ codebase_id: string | null }>(
          'SELECT codebase_id FROM remote_agent_conversations WHERE id = $1',
          [conversationId]
        );
        expect(target.rows[0].codebase_id).toBeNull();
        expect(
          (await db.query('SELECT id FROM remote_agent_codebases WHERE id = $1', [projectId])).rows
        ).toHaveLength(1);
      });
    }

    test('no active session is a valid success', async () => {
      await db.query('UPDATE remote_agent_sessions SET active = false WHERE id = $1', [sessionId]);
      expect((await detachConversationProject(input())).status).toBe('detached');
    });

    for (const name of ['', '   ', 'wrong', 'my app', 'My App']) {
      test(`refuses invalid exact name ${JSON.stringify(name)} without changes`, async () => {
        const before = await snapshot();
        expect(await detachConversationProject({ ...input(), projectName: name })).toEqual({
          status: 'refused',
          reason: 'name',
        });
        expect(await snapshot()).toEqual(before);
      });
    }

    test('case-only mismatch, another project, duplicate name and neutral binding refuse', async () => {
      const before = await snapshot();
      expect(
        (await detachConversationProject({ ...input(), projectName: projectName.toLowerCase() }))
          .status
      ).toBe('refused');
      await db.query(
        "INSERT INTO remote_agent_codebases (name, default_cwd) VALUES ('Other Project', '/other')"
      );
      expect(
        (await detachConversationProject({ ...input(), projectName: 'Other Project' })).status
      ).toBe('refused');
      await db.query(
        "INSERT INTO remote_agent_codebases (name, default_cwd) VALUES ($1, '/duplicate')",
        [projectName]
      );
      expect((await detachConversationProject(input())).status).toBe('refused');
      expect(await snapshot()).toEqual(before);
      await db.query('UPDATE remote_agent_conversations SET codebase_id = NULL WHERE id = $1', [
        conversationId,
      ]);
      const neutral = await snapshot();
      expect(await detachConversationProject(input())).toEqual({
        status: 'refused',
        reason: 'neutral',
      });
      expect(await snapshot()).toEqual(neutral);
    });

    test('missing conversation fails without changing any existing state', async () => {
      const before = await snapshot();
      await expect(
        detachConversationProject({ ...input(), conversationId: crypto.randomUUID() })
      ).rejects.toThrow('Conversation not found');
      expect(await snapshot()).toEqual(before);
    });

    test('bound parent refuses; neutral and absent parents allow independent children', async () => {
      const before = await snapshot();
      expect(
        await detachConversationProject({ ...input(), parentPlatformId: `platform-${workerId}` })
      ).toEqual({ status: 'refused', reason: 'parent-bound' });
      expect(await snapshot()).toEqual(before);
      await db.query('UPDATE remote_agent_conversations SET codebase_id = NULL WHERE id = $1', [
        workerId,
      ]);
      expect(
        (await detachConversationProject({ ...input(), parentPlatformId: `platform-${workerId}` }))
          .status
      ).toBe('detached');
      await db.query('UPDATE remote_agent_conversations SET codebase_id = $1 WHERE id = $2', [
        projectId,
        conversationId,
      ]);
      expect(
        (await detachConversationProject({ ...input(), parentPlatformId: 'missing-parent' })).status
      ).toBe('detached');
    });

    for (const ownership of ['direct', 'parent', 'both'] as const) {
      for (const status of ['pending', 'running', 'paused', 'failed'] as const) {
        test(`${status} run blocks through ${ownership} ownership exactly once`, async () => {
          const runId = crypto.randomUUID();
          await db.query(
            `INSERT INTO remote_agent_workflow_runs (id, workflow_name, user_message, conversation_id, parent_conversation_id, status)
            VALUES ($1, 'test', '', $2, $3, $4)`,
            [
              runId,
              ownership === 'parent' ? workerId : conversationId,
              ownership === 'direct' ? null : conversationId,
              status,
            ]
          );
          const before = await snapshot();
          expect(await detachConversationProject(input())).toEqual({
            status: 'blocked',
            runs: [{ id: runId, status }],
            environmentId: null,
          });
          expect(await snapshot()).toEqual(before);
        });
      }
    }

    test('all paused wait metadata, environment pointer and runs are reported together', async () => {
      const runs = [];
      const waitingSince = '2026-10-01T00:00:00.000Z';
      const resumeAt = '2026-10-02T00:00:00.000Z';
      const metadataVariants = [
        { approval: { type: 'approval', nodeId: 'review', message: 'Approve this work' } },
        { approval: { type: 'interactive_loop', nodeId: 'input', message: 'Provide input' } },
        {
          wait: {
            kind: 'attention',
            owner: 'node',
            nodeId: 'attention',
            waitingSince,
            message: 'Input needed',
          },
        },
        { wait: { kind: 'time', owner: 'node', nodeId: 'timer', waitingSince, resumeAt } },
        {
          wait: {
            kind: 'event',
            owner: 'node',
            nodeId: 'event',
            waitingSince,
            resumeAt,
            event: 'ready',
          },
        },
      ] satisfies { approval?: ApprovalContext; wait?: WorkflowWaitContext }[];
      for (const metadata of metadataVariants) {
        const id = crypto.randomUUID();
        runs.push({ id, status: 'paused' as const });
        await db.query(
          `INSERT INTO remote_agent_workflow_runs (id, workflow_name, user_message, conversation_id, status, metadata)
          VALUES ($1, 'test', '', $2, 'paused', $3)`,
          [id, conversationId, JSON.stringify(metadata)]
        );
      }
      // Even a stale environment pointer must remain reachable for explicit cleanup.
      const environmentId = crypto.randomUUID();
      await db.query('UPDATE remote_agent_conversations SET isolation_env_id = $1 WHERE id = $2', [
        environmentId,
        conversationId,
      ]);
      const before = await snapshot();
      expect(await detachConversationProject(input())).toEqual({
        status: 'blocked',
        runs: runs.sort((a, b) => a.id.localeCompare(b.id)),
        environmentId,
      });
      expect(await snapshot()).toEqual(before);
    });

    for (const provider of ['worktree', 'container']) {
      test(`attached ${provider} environment blocks and remains unchanged`, async () => {
        const environmentId = crypto.randomUUID();
        await db.query(
          `INSERT INTO remote_agent_isolation_environments
          (id, codebase_id, workflow_type, workflow_id, provider, working_path, branch_name)
          VALUES ($1, $2, 'conversation', $3, $4, '/worktree', 'feature')`,
          [environmentId, projectId, conversationId, provider]
        );
        await db.query(
          'UPDATE remote_agent_conversations SET isolation_env_id = $1 WHERE id = $2',
          [environmentId, conversationId]
        );
        const before = await snapshot();
        const environment = await db.query(
          'SELECT * FROM remote_agent_isolation_environments WHERE id = $1',
          [environmentId]
        );
        expect(await detachConversationProject(input())).toEqual({
          status: 'blocked',
          runs: [],
          environmentId,
        });
        expect(await snapshot()).toEqual(before);
        expect(
          await db.query('SELECT * FROM remote_agent_isolation_environments WHERE id = $1', [
            environmentId,
          ])
        ).toEqual(environment);
      });
    }

    test('completed, cancelled and unrelated runs do not block', async () => {
      for (const [owner, status] of [
        [conversationId, 'completed'],
        [conversationId, 'cancelled'],
        [workerId, 'running'],
      ]) {
        await db.query(
          `INSERT INTO remote_agent_workflow_runs (workflow_name, user_message, conversation_id, status)
          VALUES ('test', '', $1, $2)`,
          [owner, status]
        );
      }
      expect((await detachConversationProject(input())).status).toBe('detached');
    });

    for (const failingStatement of [
      'SELECT id, status',
      'UPDATE remote_agent_sessions',
      'SET codebase_id = NULL',
    ]) {
      test(`failure at ${failingStatement} rolls back binding and session`, async () => {
        const before = await snapshot();
        useDatabase(
          intercept(db, async sql => {
            if (sql.includes(failingStatement)) throw new Error('injected database failure');
          })
        );
        await expect(detachConversationProject(input())).rejects.toThrow(
          'injected database failure'
        );
        expect(await snapshot()).toEqual(before);
        await expectBound();
      });
    }

    test('failure after final write but before commit rolls back the whole transition', async () => {
      const before = await snapshot();
      useDatabase({
        ...intercept(db, async () => {}),
        withTransaction: fn =>
          db.withTransaction(async query => {
            await fn(query);
            throw new Error('commit boundary failure');
          }),
      });
      await expect(detachConversationProject(input())).rejects.toThrow('commit boundary failure');
      expect(await snapshot()).toEqual(before);
      await expectBound();
    });

    for (const ownership of ['direct', 'parent'] as const) {
      for (const admission of ['ordinary', 'resource'] as const) {
        if (ownership === 'parent' && admission === 'resource') continue;
        for (const first of ['detach', 'insert'] as const) {
          test(`${first} wins the ${ownership} ${admission} insertion race across connections`, async () => {
            const runId = crypto.randomUUID();
            const run = {
              id: runId,
              workflow_name: 'test',
              user_message: '',
              codebase_id: projectId,
              metadata: {},
              origin: {
                userId,
                conversationId: ownership === 'parent' ? workerId : conversationId,
                ...(ownership === 'parent' ? { parentConversationId: conversationId } : {}),
              },
            };
            const gate = barrier();
            const insert = async (): Promise<unknown> =>
              admission === 'ordinary'
                ? createWorkflowRun(run)
                : admitResourceStart({
                    resource: `resource-${runId}`,
                    capacity: 1,
                    hostId: 'test',
                    overlap: 'queue',
                    launch: {
                      version: 2,
                      run,
                      execution: {
                        cwd: '/project',
                        conversationId: 'platform',
                        isolation: { kind: 'in-place' },
                      },
                    },
                  });
            const paused = intercept(
              db,
              async sql => {
                if (
                  (first === 'detach' && sql.includes('SELECT id, status')) ||
                  (first === 'insert' && sql.includes('INSERT INTO remote_agent_workflow_runs'))
                )
                  await gate.pause();
              },
              'after'
            );
            useDatabase(paused);
            const leading = first === 'detach' ? detachConversationProject(input()) : insert();
            await gate.reached;
            useDatabase(other);
            let settled = false;
            const trailing = (
              first === 'detach' ? insert() : detachConversationProject(input())
            ).then(
              value => {
                settled = true;
                return { value };
              },
              error => {
                settled = true;
                return { error };
              }
            );
            try {
              if (db.dialect === 'sqlite') {
                // The competing connection waits out SQLITE_BUSY until the leader commits.
                // Its zero busy timeout keeps each attempt from blocking the event loop the
                // paused leader shares, so the wait happens in the adapter's async backoff.
                await Bun.sleep(100);
                expect(settled).toBe(false);
              } else {
                // Wait for PostgreSQL to prove the competing transaction is lock-blocked.
                let waiting = false;
                for (let i = 0; i < 200 && !waiting; i++) {
                  const locks = await other.query<{ waiting: boolean }>(
                    `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock') AS waiting`
                  );
                  waiting = locks.rows[0].waiting;
                  if (!waiting) await Bun.sleep(5);
                }
                expect(waiting).toBe(true);
                expect(settled).toBe(false);
              }
            } finally {
              gate.release();
            }
            const leadingResult = await leading;
            const trailingResult = await trailing;
            useDatabase(other);
            if (first === 'detach') {
              expect(leadingResult).toMatchObject({ status: 'detached' });
              if ('error' in trailingResult) await insert();
              else expect(trailingResult.value).toBeDefined();
            } else {
              const refused =
                'error' in trailingResult
                  ? await detachConversationProject(input())
                  : trailingResult.value;
              expect(refused).toMatchObject({
                status: 'blocked',
                runs: [{ id: runId, status: 'pending' }],
              });
              await expectBound();
            }
          }, 10000);
        }
      }
    }
  });
}
