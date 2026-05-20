import { describe, it, expect } from 'bun:test';
import { parse } from 'yaml';
import { SNIPPET_STARTERS, SNIPPET_PATTERNS, loadSnippet } from '../../snippets';
import { workflowDefinitionSchema } from '../../schemas';
import { fromWorkflowDefinition } from '../../exporter/fromWorkflowDefinition';

/**
 * Two-stage validation per snippet:
 *   1. Canonical Zod parse — catches schema-name typos like `iteration_cap` (loop schema requires
 *      `max_iterations` + `until`). Without this stage, fromWorkflowDefinition's tolerant import
 *      lifts unknown fields into _unknown silently and the snippet ships broken.
 *   2. Studio importer — catches importer-side regressions and confirms node count.
 */
describe('snippet fixtures', () => {
  for (const name of SNIPPET_STARTERS) {
    it(`starter '${name}' is canonical-Zod-valid and imports cleanly`, () => {
      const yaml = loadSnippet('starters', name);
      const def = parse(yaml);
      const zod = workflowDefinitionSchema.safeParse(def);
      if (!zod.success) {
        // Surface the first issue path/message so failures are debuggable.
        throw new Error(
          `Zod validation failed for starter '${name}': ${JSON.stringify(zod.error.issues[0])}`
        );
      }
      expect(zod.success).toBe(true);
      const result = fromWorkflowDefinition(def);
      expect(result.nodes.length).toBeGreaterThan(0);
    });
  }
  for (const name of SNIPPET_PATTERNS) {
    it(`pattern '${name}' is canonical-Zod-valid and imports cleanly`, () => {
      const yaml = loadSnippet('patterns', name);
      const def = parse(yaml);
      const zod = workflowDefinitionSchema.safeParse(def);
      if (!zod.success) {
        throw new Error(
          `Zod validation failed for pattern '${name}': ${JSON.stringify(zod.error.issues[0])}`
        );
      }
      expect(zod.success).toBe(true);
      const result = fromWorkflowDefinition(def);
      expect(result.nodes.length).toBeGreaterThan(0);
    });
  }
});
