import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nodeFieldDeprecations } from './dag-node';

const start = '<!-- node-deprecations:start -->';
const end = '<!-- node-deprecations:end -->';
const cell = (text: string): string => text.replaceAll('|', '\\|').replace(/\s+/g, ' ').trim();

function nodeDeprecationsTable(): string {
  return [
    start,
    '| Field | Deprecated since | Replacement |',
    '| --- | --- | --- |',
    ...nodeFieldDeprecations().map(
      field =>
        `| \`${field.path.join('.')}\` | ${field.metadata.since} | \`${cell(field.message)}\` |`
    ),
    end,
  ].join('\n');
}

test('the canonical workflow reference matches every live node-field deprecation', () => {
  const reference = readFileSync(
    join(import.meta.dir, '../../../docs-web/src/content/docs/reference/workflow-language.md'),
    'utf8'
  ).replaceAll('\r\n', '\n');
  const block = reference.slice(reference.indexOf(start), reference.indexOf(end) + end.length);
  expect(block).toBe(nodeDeprecationsTable());
});
