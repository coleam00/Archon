import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { extractSchemaSql } from './generate-sqlite-vintages';

function adapterSource(schemaBody: string, helper = ''): string {
  return `${helper}
export class SqliteAdapter {
  private createSchema(): void {
    this.db.exec(\`${schemaBody}\`);
  }
}
`;
}

const HOLDERS_HELPER = `
function holdersTable(name: string): string {
  return \`CREATE TABLE IF NOT EXISTS \${name} (id TEXT);\`;
}
`;

describe('extractSchemaSql', () => {
  test('returns an uninterpolated literal unchanged', () => {
    const sql = '\n      CREATE TABLE a (id TEXT);\n    ';
    expect(extractSchemaSql('v1', adapterSource(sql))).toBe(sql);
  });

  test("resolves a helper('literal') call from the same source", () => {
    const source = adapterSource(
      "CREATE TABLE a (id TEXT);\n      ${holdersTable('holders')}\n      CREATE TABLE b (id TEXT);",
      HOLDERS_HELPER
    );
    expect(extractSchemaSql('v1', source)).toBe(
      'CREATE TABLE a (id TEXT);\n      CREATE TABLE IF NOT EXISTS holders (id TEXT);\n      CREATE TABLE b (id TEXT);'
    );
  });

  test('refuses an interpolation that is not a helper call', () => {
    expect(() => extractSchemaSql('v1', adapterSource('CREATE TABLE ${name} (id TEXT);'))).toThrow(
      'v1: extracted schema contains ${name} interpolation'
    );
  });

  test('refuses a helper call whose helper is not in the source', () => {
    expect(() => extractSchemaSql('v1', adapterSource("${holdersTable('holders')}"))).toThrow(
      'v1: cannot resolve ${holdersTable(…)}'
    );
  });

  test('refuses a helper whose template interpolates more than its parameter', () => {
    const helper = `
function holdersTable(name: string): string {
  return \`CREATE TABLE \${name} (id \${COLUMN_TYPE});\`;
}
`;
    expect(() =>
      extractSchemaSql('v1', adapterSource("${holdersTable('holders')}", helper))
    ).toThrow('v1: cannot resolve ${holdersTable(…)}');
  });

  test('refuses a helper whose body is more than one template return', () => {
    const helper = `
function holdersTable(name: string): string {
  return \`CREATE TABLE \${name} (id TEXT);\` + extra;
}
`;
    expect(() =>
      extractSchemaSql('v1', adapterSource("${holdersTable('holders')}", helper))
    ).toThrow('v1: cannot resolve ${holdersTable(…)}');
  });

  // The next release tag is cut from this file. Extracting it here, where the
  // tag-reading check cannot run (shallow checkout), catches a schema shape the
  // extractor cannot read before that release breaks check:sqlite-vintages.
  test('reads the current SQLite adapter', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', 'packages/core/src/db/adapters/sqlite.ts'),
      'utf8'
    );
    const sql = extractSchemaSql('current', source);
    expect(sql).not.toContain('${');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS remote_agent_resource_slot_holders (');
  });
});
