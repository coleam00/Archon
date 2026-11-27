import { describe, expect, test } from 'bun:test';
import type { PackGraph } from './pack-graph';
import { replacedTwice, unlabelled } from './pack-graph-words';

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

describe('an ask option without words', () => {
  /** A stage whose asks offer `options`, each settled answer of which starts another stage. */
  const asking = (options: PackGraph['stages'][number]['options']) =>
    ({
      stages: [
        {
          name: 'gate',
          workflow: 'gate',
          inFlow: true,
          outcome: null,
          display: { label: 'Gate' },
          nodes: [],
          options,
        },
      ],
      arrows: ['land', 'drop', 'other'].map(option => ({
        from: { stage: 'gate', settled: 'all', option },
        to: 'next',
      })),
    }) as unknown as Pick<PackGraph, 'stages' | 'arrows'>;
  const other = { id: 'other', label: 'Other', does: 'None of these.' };

  test('warns for a declared option with no label in returns.options, never for other', () => {
    const findings = unlabelled(
      asking([
        { id: 'land', label: 'merge it', does: 'Merges', cost: 'None' },
        { id: 'drop', does: 'Drops', cost: 'The work' },
        other,
      ])
    );
    expect(findings).toEqual([
      {
        stage: 'gate',
        message: "option 'drop' of stage 'gate' has no label",
        hint: 'Give the option a label in returns.options; a reader shows its id until then.',
      },
    ]);
  });
});

describe('a retired workflow named twice', () => {
  const replacing = (stages: Record<string, string[]>) =>
    ({
      stages: Object.entries(stages).map(([workflow, retired]) => ({
        workflow,
        display: { label: workflow, replaces: retired.map(name => ({ workflow: name })) },
      })),
    }) as unknown as Pick<PackGraph, 'stages'>;

  test('is an error within one stage and across two', () => {
    expect(replacedTwice(replacing({ build: ['deliver', 'deliver'] })).map(f => f.message)).toEqual(
      ["stage 'build' display.replaces names 'deliver' twice"]
    );
    expect(
      replacedTwice(replacing({ build: ['deliver'], check: ['deliver'] })).map(f => f.message)
    ).toEqual([
      "stage 'check' display.replaces names 'deliver', which stage 'build' already replaces",
    ]);
    expect(replacedTwice(replacing({ build: ['deliver'], check: ['older'] }))).toEqual([]);
  });
});
