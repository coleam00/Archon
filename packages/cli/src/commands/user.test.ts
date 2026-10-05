import { afterAll, beforeAll, expect, test } from 'bun:test';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import { removeTempTree } from '@archon/paths/test-utils';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'archon-user-cli-'));
const cli = join(import.meta.dir, '..', 'cli.ts');
const db = new SqliteAdapter(join(root, 'archon.db'));
beforeAll(async () => {
  await db.query(
    "INSERT INTO remote_agent_users (id, display_name) VALUES ('operator-user', 'Alice'), ('unlinked', NULL)",
    []
  );
  await db.query(
    "INSERT INTO remote_agent_user_identities (user_id, platform, platform_user_id) VALUES ('operator-user', 'slack', 'U123'), ('operator-user', 'web', 'web-login')",
    []
  );
});
afterAll(async () => {
  await db.close();
  await removeTempTree(root);
});

async function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, cli, 'user', ...args], {
    cwd: root,
    env: { ...process.env, ARCHON_HOME: root, DATABASE_URL: '', ARCHON_TELEMETRY_DISABLED: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test('list prints ids, roles, names and every platform identity outside a git repository', async () => {
  const result = await run('list');
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('operator-user\tadmin\tAlice\tslack:U123, web:web-login');
  expect(result.stdout).toContain('unlinked\tadmin\t-\t-');
});

test('role changes persist, including demoting every admin', async () => {
  for (const id of ['operator-user', 'unlinked']) {
    const result = await run('role', id, 'member');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`${id}\tmember`);
  }
  expect((await run('list')).stdout).toContain('operator-user\tmember');
  const promotion = await run('role', 'operator-user', 'admin');
  expect(promotion.code).toBe(0);
  expect(promotion.stdout).toContain('operator-user\tadmin');
});

test('unknown ids, invalid roles and missing arguments fail clearly', async () => {
  const unknown = await run('role', 'missing', 'admin');
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain('Unknown user id: missing');
  const invalid = await run('role', 'operator-user', 'owner');
  expect(invalid.code).toBe(1);
  expect(invalid.stderr).toContain('Invalid role: owner. Expected admin or member.');
  expect((await run('list')).stdout).toContain('operator-user\tadmin');
  const missing = await run('role', 'operator-user');
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain('Usage: archon user role');
});
