import { expect, test } from 'bun:test';
import { packDisplayName } from './pack-name';

// Drops the owner, makes separators spaces, keeps the rest as written, and falls back to the
// raw id when nothing readable is left.
test.each([
  ['Wirasm/archon-software-factory', 'Archon software factory'],
  ['acme/kit', 'Kit'],
  ['my_pack.v2', 'My pack v2'],
  ['acme/CI-tools', 'CI tools'],
  ['acme/--', 'acme/--'],
  ['acme/', 'acme/'],
])('packDisplayName(%p) is %p', (id, name) => {
  expect(packDisplayName(id)).toBe(name);
});
