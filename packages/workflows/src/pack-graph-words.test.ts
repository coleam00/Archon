import { describe, expect, test } from 'bun:test';
import type { PackGraph } from './pack-graph';
import { unlabelled } from './pack-graph-words';

type GraphNode = PackGraph['stages'][number]['nodes'][number];

const node = (id: string, blocks: GraphNode['blocks'] = []): GraphNode => ({
  id,
  kind: 'bash',
  dependsOn: [],
  loopGroup: null,
  blocks,
  fanOut: null,
});

/** One in-flow stage with words, whose steps have none: its own node and an included one. */
const graph = {
  stages: [
    {
      name: 'check',
      workflow: 'check',
      inFlow: true,
      outcome: null,
      display: { label: 'Checks' },
      nodes: [node('base'), node('review__review', [{ include: 'review', workflow: 'review' }])],
    },
  ],
  arrows: [],
} as unknown as Pick<PackGraph, 'stages' | 'arrows'>;

describe('a step without words', () => {
  test("names where its label is authored: the stage's own node, or the included workflow's", () => {
    const hints = Object.fromEntries(
      unlabelled(graph).map(finding => [finding.message.split("'")[1], finding.hint])
    );
    expect(hints.base).toContain('in this workflow');
    expect(hints.review__review).toContain(
      "Give node 'review' a display: { label } in the included workflow 'review'"
    );
  });
});
