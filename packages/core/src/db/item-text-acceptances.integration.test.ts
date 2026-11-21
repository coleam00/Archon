// @archon-test-isolated
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeTempTree } from '@archon/paths/test-utils';
import { closeDatabase, getDatabase, resetDatabase } from './connection';
import {
  declareItemTextRequirement,
  readItemTextAcceptance,
  readItemTextAcceptanceByItemId,
  readItemTextRequirement,
  writeItemTextAcceptance,
} from './item-text-acceptances';
import type { TrustedTextRunMetadata } from '@archon/workflows/trusted-text';
import { createTrustedTextRecords } from '../workflows/trusted-text';

let root = '';
const originalHome = process.env.ARCHON_HOME;
const originalDatabaseUrl = process.env.DATABASE_URL;
const requirement: TrustedTextRunMetadata['requirement'] = {
  subject: {
    kind: 'issue',
    ref: { repo: { host: 'github.com', path: 'owner/repo' }, number: 7 },
  },
  maintainersPath: '.archon/maintainers.json',
  input: 'trusted_item',
};
const snapshot: TrustedTextRunMetadata = {
  schemaVersion: 1,
  requirement,
  title: 'Title',
  body: 'Body',
  contentDigest: 'a'.repeat(64),
  editProvenance: {
    editor: { host: 'github.com', id: 'outside', login: 'outside' },
    lastEditedAt: '2026-11-19T00:00:00Z',
    titleEditor: null,
    titleEditedAt: null,
  },
  policy: { head: 'b'.repeat(40), digest: 'c'.repeat(64), maintainers: ['alice'] },
  acceptedBy: { host: 'github.com', id: '1', login: 'alice' },
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archon-item-trust-'));
  delete process.env.DATABASE_URL;
  process.env.ARCHON_HOME = root;
  await getDatabase().query(
    `INSERT INTO remote_agent_codebases (id, name, default_cwd, kind)
     VALUES ('codebase', 'repo', $1, 'repo')`,
    [join(root, 'repo')]
  );
});

afterEach(async () => {
  await closeDatabase();
  await resetDatabase();
  if (originalHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalHome;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  await removeTempTree(root);
});

test('declares once, reuses acceptance across runs and serializes competing accepts', async () => {
  await declareItemTextRequirement('codebase', 'issue-7', requirement);
  const item = await getDatabase().query<{ id: string; project_key: string }>(
    "SELECT id, project_key FROM remote_agent_items WHERE key = 'issue-7'"
  );
  const { id, project_key: projectKey } = item.rows[0]!;
  expect(await readItemTextRequirement(id)).toEqual(requirement);
  await Promise.all([
    writeItemTextAcceptance(projectKey, 'issue-7', snapshot),
    writeItemTextAcceptance(projectKey, 'issue-7', snapshot),
  ]);
  expect(await readItemTextAcceptance(projectKey, 'issue-7')).toEqual(snapshot);
  expect(await readItemTextAcceptanceByItemId(id)).toEqual(snapshot);
  expect(await readItemTextAcceptance(projectKey, 'issue-8')).toBeNull();
  await expect(
    createTrustedTextRecords().readAccepted(projectKey, 'issue-7', {
      ...requirement,
      input: 'different_input',
    })
  ).rejects.toThrow('acceptance_requirement_changed');
  const rows = await getDatabase().query<{ count: number }>(
    'SELECT COUNT(*) AS count FROM remote_agent_item_text_acceptances'
  );
  expect(rows.rows[0]?.count).toBe(1);
});
