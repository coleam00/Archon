import { test, mock, expect } from 'bun:test';
import { canonicalizeProjectPath } from '@archon/paths';
import { createMockPlatform } from '../test/mocks/platform';
import { quoteCommandArg } from '../utils/command-args';
import { SqliteAdapter, sqliteDialect } from './adapters/sqlite';
import { verifyCodebasePathContract } from '../test/codebase-path-contract';

const db = new SqliteAdapter(':memory:');
mock.module('./connection', () => ({
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));

test('SQLite rejects legacy paths and preserves registration identity on explicit repair', async () => {
  try {
    await verifyCodebasePathContract(db);
    const codebases = await import('./codebases');
    const conversations = await import('./conversations');
    const { handleMessage } = await import('../orchestrator/orchestrator-agent');
    const project = await codebases.findCodebaseByName('Client "Ops"');
    if (!project) throw new Error('Missing contract project');
    const conversation = await conversations.getOrCreateConversation('mock', 'legacy-repair');
    await conversations.updateConversation(conversation.id, { codebase_id: project.id });
    await db.query('UPDATE remote_agent_codebases SET default_cwd = $1 WHERE id = $2', [
      'projects/repo',
      project.id,
    ]);
    const platform = createMockPlatform();
    const replacement = await canonicalizeProjectPath(import.meta.dir);
    await handleMessage(
      platform,
      'legacy-repair',
      `/register-project ${quoteCommandArg(project.name)} ${quoteCommandArg(replacement)}`
    );
    expect(platform.sendMessage.mock.calls[0]?.[1]).toContain('re-registered successfully');
    expect(await codebases.getCodebase(project.id)).toMatchObject({
      ...project,
      default_cwd: replacement,
      updated_at: expect.anything(),
    });
    expect(await codebases.listCodebases()).toHaveLength(1);
    expect(
      (await conversations.getConversationByPlatformId('mock', 'legacy-repair'))?.codebase_id
    ).toBe(project.id);
  } finally {
    await db.close();
  }
});
