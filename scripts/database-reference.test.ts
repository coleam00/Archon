import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('database reference lists exactly the tables owned by the combined schema', () => {
  const root = join(import.meta.dir, '..');
  const schema = readFileSync(join(root, 'migrations/000_combined.sql'), 'utf8');
  const reference = readFileSync(
    join(root, 'packages/docs-web/src/content/docs/reference/database.md'),
    'utf8'
  );
  const overview = reference.split('## Schema Overview')[1]?.split('\n## ')[0];
  expect(overview).toBeDefined();

  const schemaTables = Array.from(
    schema.matchAll(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(remote_agent_\w+)\s*\(/gim),
    match => match[1]
  ).sort();
  const documentedTables = Array.from((overview ?? '').matchAll(/^- \*\*(.+?)\*\*/gm), match =>
    Array.from(match[1].matchAll(/`(remote_agent_\w+)`/g), table => table[1])
  )
    .flat()
    .sort();

  expect(schemaTables.length).toBeGreaterThan(0);
  expect(documentedTables).toEqual(schemaTables);
});
