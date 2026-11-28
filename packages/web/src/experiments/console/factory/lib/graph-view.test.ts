import { describe, expect, test } from 'bun:test';
import type { PackGraph } from '../../skills/items';
import { testGraph } from '../curated.test-fixtures';
import { graphWords } from './graph-view';

type GraphStage = PackGraph['stages'][number];

/** `testGraph` with `edit` applied to the stage named `workflow`. */
const withStage = (workflow: string, edit: (stage: GraphStage) => GraphStage): PackGraph => ({
  ...testGraph,
  stages: testGraph.stages.map(stage => (stage.workflow === workflow ? edit(stage) : stage)),
});

describe("a pack graph's words and declarations", () => {
  const words = graphWords(testGraph);

  test('a stage reads its label, its steps by recorded id and its outcomes from its display', () => {
    expect(words.stages['stage-check']).toMatchObject({
      label: 'Checks',
      short: 'Review, tests, product',
    });
    // An included node's label, under the id its runs record it by.
    expect(words.stages['stage-check']?.steps.review__review).toBe('Code review');
    expect(words.outcomes['stage-check:return']).toEqual({
      label: 'returned',
      story: 'The checks sent it back',
    });
    // An ask option's words are its label in returns.options; the reserved `other` is the engine's.
    expect(words.answers['stage-check:one-more-round']).toEqual({ label: 'one more round' });
    expect(words.answers['stage-check:other']).toEqual({ label: 'Other' });
    // A stage's own story covers its runs whose outcome tells none.
    expect(words.outcomes['discoveries:*']).toEqual({
      story: 'The factory looked for other work it noticed',
    });
  });

  test("the document's words and exit, and the stage-form rounds and the change", () => {
    expect(words.words.rounds).toBe('check rounds');
    expect(words.merged).toBe('landed');
    expect(words.rounds).toContainEqual({
      workflow: 'stage-check',
      round: '/round',
      allowance: '/allowance',
    });
    expect(words.change).toContainEqual({ workflow: 'stage-host', pointer: '/change' });
  });

  test('a retired workflow stands at the stage that replaces it, with its own loop, marks and change', () => {
    expect(words.retired).toEqual([{ workflow: 'deliver', stage: 'stage-build' }]);
    expect(words.rounds).toContainEqual({ workflow: 'deliver', loop: 'rounds' });
    expect(words.returns).toContainEqual({
      workflow: 'deliver',
      node: 'hostrounds.host__host',
      outcome: 'return',
    });
    expect(words.approves).toContainEqual({
      workflow: 'deliver',
      node: 'rounds.verdict__verdict',
      outcome: 'approve',
    });
    expect(words.change).toContainEqual({ workflow: 'deliver', pointer: '/change' });
  });

  test('is derived once per graph object', () => {
    expect(graphWords(testGraph)).toBe(words);
  });
});

test("a mark whose means is not the console's, and a replaces naming a live stage, are left alone", () => {
  const graph = withStage('stage-host', stage => ({
    ...stage,
    display: {
      ...stage.display!,
      marks: [{ node: 'rounds__host', outcome: 'return', means: 'escalates' }],
      replaces: [{ workflow: 'stage-check' }],
    },
  }));
  const words = graphWords(graph);
  expect(words.returns.filter(point => point.workflow === 'stage-host')).toEqual([]);
  expect(words.approves.filter(point => point.workflow === 'stage-host')).toEqual([]);
  expect(words.retired).toEqual([{ workflow: 'deliver', stage: 'stage-build' }]);
});

test('drift: a renamed stage and a new outcome read their YAML words, with no view file to edit', () => {
  // The pack renames stage-check to stage-review and gives it a new outcome with a story.
  const renamed = JSON.parse(
    JSON.stringify(testGraph).replaceAll('stage-check', 'stage-review')
  ) as PackGraph;
  const graph: PackGraph = {
    ...renamed,
    stages: renamed.stages.map(stage =>
      stage.workflow !== 'stage-review' || stage.outcome === null
        ? stage
        : {
            ...stage,
            outcome: {
              ...stage.outcome,
              values: [
                ...stage.outcome.values,
                {
                  value: 'escalate',
                  startsNothing: true,
                  ends: false,
                  stops: true,
                  display: { label: 'escalated', story: 'The checks escalated it to you' },
                },
              ],
            },
          }
    ),
  };
  const words = graphWords(graph);
  expect(words.stages['stage-review']?.label).toBe('Checks');
  expect(words.stages['stage-check']).toBeUndefined();
  expect(words.outcomes['stage-review:escalate']).toEqual({
    label: 'escalated',
    story: 'The checks escalated it to you',
  });
  // Its rounds and send-backs follow the rename: they are declared on the stage itself.
  expect(words.rounds).toContainEqual({
    workflow: 'stage-review',
    round: '/round',
    allowance: '/allowance',
  });
  expect(words.returns).toContainEqual({
    workflow: 'stage-review',
    node: 'verdict__verdict',
    outcome: 'return',
  });
});
