import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getSchemaSQL } from './bundled-schema';

test('embeds the combined Postgres schema exactly', () => {
  expect(getSchemaSQL()).toBe(
    readFileSync(resolve(import.meta.dir, '../../../../migrations/000_combined.sql'), 'utf8')
  );
});
