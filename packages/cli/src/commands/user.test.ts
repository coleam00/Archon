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

test('link creates and moves identities without changing roles or deleting the previous user', async () => {
  await db.query("UPDATE remote_agent_users SET role = 'member' WHERE id = 'unlinked'", []);
  const linked = await run('link', 'unlinked', 'matrix-chat:user:123');
  expect(linked.code).toBe(0);
  expect(linked.stdout).toContain('unlinked\tmatrix-chat:user:123');
  expect((await run('link', 'unlinked', 'matrix-chat:user:123')).code).toBe(0);
  const conflict = await run('link', 'unlinked', 'slack:U123');
  expect(conflict.code).toBe(1);
  expect(conflict.stderr).toContain('operator-user');
  expect(conflict.stderr).toContain('unlinked');
  expect((await run('list')).stdout).toContain('slack:U123');
  expect((await run('link', 'unlinked', 'slack:U123', '--move')).code).toBe(0);
  const users = (await run('list')).stdout;
  expect(users).toContain('unlinked\tmember\t-\tmatrix-chat:user:123, slack:U123');
  expect(users).toContain('operator-user\tadmin\tAlice\tweb:web-login');
});

test('link rejects unknown users, malformed identities and missing arguments', async () => {
  const unknown = await run('link', 'missing', 'slack:U999', '--move');
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain('Unknown user id: missing');
  for (const identity of ['slack', ':U123', 'slack:', 'Invalid_platform:U123', 'slack:   ']) {
    const result = await run('link', 'unlinked', identity);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Expected <platform>:<platform-user-id>');
  }
  expect((await run('link', 'unlinked')).stderr).toContain('Usage: archon user link');
  expect((await run('link', '--help')).stdout).toContain('[--move]');
});
