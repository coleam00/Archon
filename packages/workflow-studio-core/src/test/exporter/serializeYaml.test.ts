import { describe, it, expect } from 'bun:test';
import { parse as parseYaml } from 'yaml';
import { serializeYaml } from '../../exporter/serializeYaml';
import type { LoadWorkflowInput } from '../../store/builder-store';

const input = (): LoadWorkflowInput => ({
  meta: { name: 'demo', description: 'd', base: {}, unknown: {} },
  nodes: [
    { id: 'a', variant: 'prompt', data: { prompt: 'first' }, base: {}, unknown: {} },
    {
      id: 'b',
      variant: 'bash',
      data: { bash: "echo 'hi'" },
      base: { depends_on: ['a'] },
      unknown: {},
    },
  ],
});

describe('serializeYaml', () => {
  it('returns a yaml string and a sourceMap', () => {
    const r = serializeYaml(input());
    expect(typeof r.yaml).toBe('string');
    expect(Array.isArray(r.sourceMap)).toBe(true);
  });

  it('parses to the canonical-shape object', () => {
    const r = serializeYaml(input());
    const parsed = parseYaml(r.yaml) as Record<string, unknown>;
    expect(parsed.name).toBe('demo');
    expect(parsed.description).toBe('d');
    expect(Array.isArray(parsed.nodes)).toBe(true);
    expect((parsed.nodes as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 'a',
      prompt: 'first',
    });
  });

  it('emits a sourceMap entry per node, in document order', () => {
    const r = serializeYaml(input());
    expect(r.sourceMap.map(e => e.id)).toEqual(['a', 'b']);
  });

  it('startLine and endLine are 1-based and bracket the node mapping', () => {
    const r = serializeYaml(input());
    const lines = r.yaml.split('\n');
    for (const range of r.sourceMap) {
      expect(range.startLine).toBeGreaterThanOrEqual(1);
      expect(range.endLine).toBeGreaterThanOrEqual(range.startLine);
      expect(range.endLine).toBeLessThanOrEqual(lines.length);
      const slice = lines.slice(range.startLine - 1, range.endLine).join('\n');
      expect(slice).toContain(`id: ${range.id}`);
    }
  });

  it('source map includes the full multiline scalar block', () => {
    const r = serializeYaml({
      meta: { name: 'm', description: 'd', base: {}, unknown: {} },
      nodes: [
        {
          id: 'multi',
          variant: 'bash',
          data: { bash: 'line1\nline2\nline3\n' },
          base: {},
          unknown: {},
        },
      ],
    });
    const range = r.sourceMap[0]!;
    const slice = r.yaml
      .split('\n')
      .slice(range.startLine - 1, range.endLine)
      .join('\n');
    expect(slice).toContain('line1');
    expect(slice).toContain('line2');
    expect(slice).toContain('line3');
  });

  it('is idempotent: serialize → parse → re-stringify yields the same yaml', async () => {
    const r1 = serializeYaml(input());
    const { stringify } = await import('yaml');
    const parsed = parseYaml(r1.yaml) as Record<string, unknown>;
    const r2Yaml = stringify(parsed, { lineWidth: 0 });
    expect(r2Yaml.trim()).toBe(r1.yaml.trim());
  });

  it('multi-line block scalars are fully bracketed by the node range', () => {
    const r = serializeYaml({
      meta: { name: 'm', description: 'd', base: {}, unknown: {} },
      nodes: [
        {
          id: 'before',
          variant: 'prompt',
          data: { prompt: 'p' },
          base: {},
          unknown: {},
        },
        {
          id: 'multi',
          variant: 'bash',
          data: { bash: 'line1\nline2\nline3\n' },
          base: {},
          unknown: {},
        },
        {
          id: 'after',
          variant: 'prompt',
          data: { prompt: 'q' },
          base: {},
          unknown: {},
        },
      ],
    });
    const lines = r.yaml.split('\n');
    const multi = r.sourceMap.find(e => e.id === 'multi')!;
    for (const needle of ['line1', 'line2', 'line3']) {
      const lineIdx = lines.findIndex(l => l.includes(needle));
      expect(lineIdx + 1).toBeGreaterThanOrEqual(multi.startLine);
      expect(lineIdx + 1).toBeLessThanOrEqual(multi.endLine);
    }
    const after = r.sourceMap.find(e => e.id === 'after')!;
    expect(after.startLine).toBeGreaterThan(multi.endLine);
  });
});
