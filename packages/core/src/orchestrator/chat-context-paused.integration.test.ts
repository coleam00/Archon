// @archon-test-isolated
import { afterAll, expect, mock, test } from 'bun:test';
import { SqliteAdapter, sqliteDialect } from '../db/adapters/sqlite';
import { MockPlatformAdapter } from '../test/mocks/platform';

const db = new SqliteAdapter(':memory:');
mock.module('../db/connection', () => ({
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));
const { pauseWorkflowRun } = await import('../db/workflows');
const { updateConversation, getConversationById } = await import('../db/conversations');
const { loadPausedGateContext, buildFullPrompt } = await import('./chat-context');
afterAll(() => db.close());
const platform = new MockPlatformAdapter();

await db.query(
  `INSERT INTO remote_agent_codebases (id, name, default_cwd)
   VALUES ('project-a', 'a', '/a'), ('project-b', 'b', '/b')`,
  []
);

async function seedRun(
  id: string,
  conversationId: string,
  parentId: string | null,
  project: string,
  hour: number
) {
  await db.query(
    `INSERT INTO remote_agent_workflow_runs
     (id, workflow_name, conversation_id, parent_conversation_id, codebase_id, status, user_message, started_at)
     VALUES ($1, 'test', $2, $3, $4, 'running', 'test', $5)`,
    [id, conversationId, parentId, project, `2026-10-21 ${String(hour)}:00:00`]
  );
  await pauseWorkflowRun(id, { nodeId: `gate-${id}`, type: 'approval', message: `Review ${id}` });
}

const storedRuns = async () =>
  (await db.query('SELECT * FROM remote_agent_workflow_runs ORDER BY id', [])).rows;

async function promptInProject(chat: string, project: string | null) {
  await updateConversation(chat, { codebase_id: project, cwd: null, isolation_env_id: null });
  const conversation = await getConversationById(chat);
  if (!conversation) throw new Error('Missing fixture conversation');
  const gate = await loadPausedGateContext(platform, conversation, chat);
  return buildFullPrompt('What is next?', undefined, undefined, undefined, undefined, gate);
}

test.each(['direct', 'parent'] as const)(
  '%s gate context follows project rebinding without changing runs',
  async association => {
    const chat = `${association}-chat`;
    const worker = `${association}-worker`;
    const other = `${association}-other`;
    for (const id of [chat, worker, other]) {
      await db.query(
        `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id) VALUES ($1, 'test', $1)`,
        [id]
      );
    }
    const runConversation = association === 'direct' ? chat : worker;
    const parent = association === 'direct' ? null : chat;
    const a = `${association}-a`;
    const b = `${association}-b`;
    await seedRun(a, runConversation, parent, 'project-a', 11);
    await seedRun(`${association}-unrelated`, other, null, 'project-b', 14);
    await seedRun(`${association}-completed`, runConversation, parent, 'project-b', 15);
    await db.query("UPDATE remote_agent_workflow_runs SET status = 'completed' WHERE id = $1", [
      `${association}-completed`,
    ]);
    let before = await storedRuns();
    expect(await promptInProject(chat, 'project-a')).toContain(`Review ${a}`);
    expect(await storedRuns()).toEqual(before);
    const empty = await promptInProject(chat, 'project-b');
    expect(empty).not.toContain('## Paused Approval Gate');
    expect(empty).not.toContain(a);
    expect(await storedRuns()).toEqual(before);

    await seedRun(b, runConversation, parent, 'project-b', 10);
    before = await storedRuns();
    const inB = await promptInProject(chat, 'project-b');
    expect(inB).toContain(`Review ${b}`);
    expect(inB).toContain(`gate-${b}`);
    expect(inB).not.toContain(a);
    expect(await storedRuns()).toEqual(before);
    const inA = await promptInProject(chat, 'project-a');
    expect(inA).toContain(`Review ${a}`);
    expect(inA).toContain(`gate-${a}`);
    expect(inA).not.toContain(b);
    expect(await storedRuns()).toEqual(before);

    const projectless = await promptInProject(chat, null);
    expect(projectless).toContain(`Review ${a}`);
    expect(projectless).toContain('no project is attached');
    expect(projectless).toContain(`approve ${a}`);
    expect(projectless).not.toContain('resolve the gate as APPROVED');
    expect(await storedRuns()).toEqual(before);
  }
);
