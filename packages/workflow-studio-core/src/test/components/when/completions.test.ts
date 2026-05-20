import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'bun:test';
import { whenAutocomplete } from '../../../components/when/completions';

function ctx(doc: string, pos: number): CompletionContext {
  const state = EditorState.create({ doc });
  return new CompletionContext(state, pos, true);
}

describe('whenAutocomplete', () => {
  const upstreamNodes = [
    {
      id: 'classify',
      outputFormat: {
        properties: { issue_type: { type: 'string' }, title: { type: 'string' } },
      },
    },
    { id: 'fetch-issue', outputFormat: null },
  ];
  const lookup = (id: string) => upstreamNodes.find(n => n.id === id)?.outputFormat ?? null;
  const source = whenAutocomplete({
    upstreamIds: upstreamNodes.map(n => n.id),
    outputFormatLookup: lookup,
  });

  it('after $, completes with upstream node ids', () => {
    const c = ctx('$', 1);
    const r = source(c);
    expect(r).not.toBeNull();
    if (!r) return;
    const labels = r.options.map(o => o.label);
    expect(labels).toContain('classify');
    expect(labels).toContain('fetch-issue');
  });

  it('after $classify., completes with "output"', () => {
    const c = ctx('$classify.', 10);
    const r = source(c);
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.options.map(o => o.label)).toContain('output');
  });

  it('after $classify.output., completes with output_format properties', () => {
    const c = ctx('$classify.output.', 17);
    const r = source(c);
    expect(r).not.toBeNull();
    if (!r) return;
    const labels = r.options.map(o => o.label);
    expect(labels).toContain('issue_type');
    expect(labels).toContain('title');
  });

  it('returns null when output_format is missing', () => {
    const c = ctx('$fetch-issue.output.', 20);
    const r = source(c);
    expect(r).toBeNull();
  });
});
