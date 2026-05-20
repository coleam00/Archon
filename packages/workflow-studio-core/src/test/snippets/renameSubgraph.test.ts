import { describe, it, expect } from 'bun:test';
import { renameSubgraph } from '../../snippets/renameSubgraph';
import type { BuilderNode } from '../../nodes/shared/types';

const n = (over: Partial<BuilderNode>): BuilderNode => ({
  id: 'x',
  variant: 'command',
  data: {},
  base: {},
  unknown: {},
  ...over,
});

describe('renameSubgraph', () => {
  it('rewrites ids per the map', () => {
    const out = renameSubgraph(
      [n({ id: 'a' }), n({ id: 'b' })],
      new Map([
        ['a', 'a-2'],
        ['b', 'b-2'],
      ])
    );
    expect(out.map(x => x.id)).toEqual(['a-2', 'b-2']);
  });

  it('rewrites depends_on entries', () => {
    const out = renameSubgraph(
      [n({ id: 'a' }), n({ id: 'b', base: { depends_on: ['a'] } })],
      new Map([
        ['a', 'a-2'],
        ['b', 'b-2'],
      ])
    );
    expect(out[1].base.depends_on).toEqual(['a-2']);
  });

  it('rewrites $oldId references in when: strings, not unrelated identifiers', () => {
    const out = renameSubgraph(
      [n({ id: 'gate', base: { when: "$a.output == 'go' && $abc.output == 'no'" } })],
      new Map([['a', 'a-2']])
    );
    expect(out[0].base.when).toBe("$a-2.output == 'go' && $abc.output == 'no'");
  });

  it('leaves untouched ids alone', () => {
    const out = renameSubgraph(
      [n({ id: 'keep' }), n({ id: 'change', base: { depends_on: ['keep'] } })],
      new Map([['change', 'change-2']])
    );
    expect(out[0].id).toBe('keep');
    expect(out[1].base.depends_on).toEqual(['keep']);
  });

  it('does not partial-match when one id is a hyphen-prefix of another', () => {
    // Hazard: `\b` treats `-` as a word boundary, so `\$run\b` would falsely
    // match inside `$run-cmd`. With the hyphen-aware lookahead, `$run-cmd`
    // stays intact when only `run` is mapped.
    const out = renameSubgraph(
      [n({ id: 'gate', base: { when: '$run.output == 1 && $run-cmd.output == 2' } })],
      new Map([['run', 'run-2']])
    );
    expect(out[0].base.when).toBe('$run-2.output == 1 && $run-cmd.output == 2');
  });
});
