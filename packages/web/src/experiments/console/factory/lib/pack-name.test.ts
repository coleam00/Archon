import { describe, expect, test } from 'bun:test';
import { packDisplayName } from './pack-name';

describe('packDisplayName', () => {
  test('drops the owner and makes the separators spaces', () => {
    expect(packDisplayName('Wirasm/archon-software-factory')).toBe('Archon software factory');
    expect(packDisplayName('acme/kit')).toBe('Kit');
  });

  test('reads a name with no owner, underscores and dots', () => {
    expect(packDisplayName('my_pack.v2')).toBe('My pack v2');
  });

  test('keeps the rest of the name as written', () => {
    expect(packDisplayName('acme/CI-tools')).toBe('CI tools');
  });

  test('falls back to the raw id when nothing readable is left', () => {
    expect(packDisplayName('acme/--')).toBe('acme/--');
    expect(packDisplayName('acme/')).toBe('acme/');
  });
});
