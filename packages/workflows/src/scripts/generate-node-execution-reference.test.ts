import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  generateReference,
  referencePath,
  renderReferenceTables,
  renderSchemaTable,
  updateReference,
} from './generate-node-execution-reference';

const trackTempRoot = trackTempRoots();
const markers =
  '<!-- BEGIN GENERATED NODE EXECUTION TABLES -->\nold\n<!-- END GENERATED NODE EXECUTION TABLES -->';

describe('node execution reference', () => {
  it('matches all committed schema tables', async () => {
    const current = await readFile(referencePath, 'utf8');
    expect(updateReference(current)).toBe(current);
    const rendered = renderReferenceTables();
    for (const title of [
      'Execution record',
      'Execution metadata',
      'Cache record',
      'Persisted event data',
    ]) {
      expect(rendered).toContain(`### ${title}`);
    }
    expect(rendered).toContain('`spend.tokens.value.cacheRead`');
    expect(rendered).toContain('`cache.invalidatingDeps[]`');
    expect(rendered).toContain('`node_output_spill_path`');
  });

  it('retains nested optional fields, array members, and union conditions', () => {
    const rendered = renderSchemaTable(
      z.object({
        details: z.object({ label: z.string().optional() }).optional(),
        entries: z.array(
          z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('a'), value: z.number() }),
            z.object({ kind: z.literal('b'), labels: z.array(z.string()).optional() }),
          ])
        ),
      })
    );
    expect(rendered).toMatch(/`details.label`\s*\| `string`\s*\| optional/);
    expect(rendered).toMatch(
      /`entries\[\].value`\s*\| `number`\s*\| required\s*\| `entries\[\].kind = "a"`/
    );
    expect(rendered).toContain('`entries[].labels[]`');
    expect(rendered).toContain('`entries[].kind = "b"`');
  });

  it('changes for new fields, enum values, and requiredness', () => {
    const initial = renderSchemaTable(z.object({ mode: z.enum(['first']) }));
    const changed = renderSchemaTable(
      z.object({
        mode: z.enum(['first', 'second']).optional(),
        added: z.boolean(),
      })
    );
    expect(changed).not.toBe(initial);
    expect(changed).toContain('"second"');
    expect(changed).toMatch(/`mode`\s*\| .*\| optional/);
    expect(changed).toContain('`added`');
  });

  it('preserves authored prose, normalizes CRLF, and rejects ambiguous markers', () => {
    expect(updateReference(`before\r\n${markers.replaceAll('\n', '\r\n')}\r\nafter`)).toBe(
      `before\n${renderReferenceTables()}\nafter`
    );
    for (const invalid of [
      '',
      `${markers}${markers}`,
      '<!-- END GENERATED NODE EXECUTION TABLES -->\n<!-- BEGIN GENERATED NODE EXECUTION TABLES -->',
    ]) {
      expect(() => updateReference(invalid)).toThrow();
    }
  });

  it('check mode rejects stale content without writing and accepts regenerated content', async () => {
    const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'node-reference-')));
    const path = join(root, 'reference.md');
    await writeFile(path, markers);
    await expect(generateReference(path, true)).rejects.toThrow('stale');
    expect(await readFile(path, 'utf8')).toBe(markers);
    await generateReference(path);
    await generateReference(path, true);
    expect(await readFile(path, 'utf8')).toBe(renderReferenceTables());
  });

  it('fails on schema constructs it cannot document', () => {
    expect(() => renderSchemaTable(z.tuple([z.string(), z.number()]))).toThrow('Unsupported');
  });
});
