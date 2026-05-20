import { describe, it, expect } from 'bun:test';
import { parse as parseYaml } from 'yaml';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromWorkflowDefinition } from '../../exporter/fromWorkflowDefinition';
import { serializeYaml } from '../../exporter/serializeYaml';

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/round-trip-fixtures'
);

const fixtureNames = readdirSync(fixturesDir).filter(f => f.endsWith('.yaml'));

describe('serializeYaml — round-trip fixtures', () => {
  for (const name of fixtureNames) {
    it(`${name}: parse → import → serialize → parse → deep-equal`, () => {
      const yamlText = readFileSync(join(fixturesDir, name), 'utf8');
      const original = parseYaml(yamlText) as Record<string, unknown>;
      const imported = fromWorkflowDefinition(original);
      const { yaml: emitted } = serializeYaml(imported);
      const reparsed = parseYaml(emitted) as Record<string, unknown>;
      expect(reparsed).toEqual(original);
    });
  }

  it('discovers at least one fixture (sanity)', () => {
    expect(fixtureNames.length).toBeGreaterThan(0);
  });
});
