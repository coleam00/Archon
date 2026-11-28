import { expect, test } from 'bun:test';
import { packDisplayName, packIdOfKey } from './pack-name';

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

test("an installed pack's key reads as its owner/name, so the owner is not in its name", () => {
  expect(packDisplayName(packIdOfKey('Wirasm.archon-software-factory'))).toBe(
    'Archon software factory'
  );
  expect(packIdOfKey('local-pack')).toBe('local-pack');
});
