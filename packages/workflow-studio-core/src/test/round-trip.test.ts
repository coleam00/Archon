import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { workflowDefinitionSchema } from '../schemas';

const FIXTURE_DIR = join(import.meta.dir, './fixtures/round-trip-fixtures');

const fixtures = readdirSync(FIXTURE_DIR).filter(f => f.endsWith('.yaml'));

describe('round-trip: every Archon bundled default', () => {
  it('has at least one fixture vendored', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(1);
  });

  for (const fixture of fixtures) {
    it(`${fixture} round-trips byte-equivalent through importer + exporter`, async () => {
      const yamlText = readFileSync(join(FIXTURE_DIR, fixture), 'utf8');
      const yaml = await import('yaml');
      const original = yaml.parse(yamlText);

      // Step 1: schema validates the source
      const validation = workflowDefinitionSchema.safeParse(original);
      if (!validation.success) {
        console.error(`Schema parse failed for ${fixture}:`);
        console.error(JSON.stringify(validation.error.format(), null, 2));
      }
      expect(validation.success).toBe(true);

      // Step 2: import → export
      const { fromWorkflowDefinition } = await import('../exporter/fromWorkflowDefinition');
      const { toWorkflowDefinition } = await import('../exporter/toWorkflowDefinition');
      const reExported = toWorkflowDefinition(fromWorkflowDefinition(original));

      // Step 3: schema validates the round-tripped object
      const reValidation = workflowDefinitionSchema.safeParse(reExported);
      expect(reValidation.success).toBe(true);

      // Step 4: deep-equal — every byte preserved
      expect(reExported).toEqual(original);
    });
  }
});
