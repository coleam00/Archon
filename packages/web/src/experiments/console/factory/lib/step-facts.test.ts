import { describe, expect, test } from 'bun:test';
import type { FactoryWorkflow } from '../../skills/factory';
import deliverJson from './fixtures/deliver-workflow.json';
import { coveringCard, modelWords, stepFacts } from './step-facts';
import type { FactoryViewListed } from './views';

type Declaration = FactoryViewListed['declaration'];
type FactoryStep = FactoryWorkflow['steps'][number];

const step = (key: string, overrides: Partial<FactoryStep> = {}): FactoryStep => ({
  key,
  label: key,
  group: null,
  dependsOn: [],
  kind: 'agent',
  includedFrom: null,
  model: null,
  when: null,
  whenClauses: null,
  command: null,
  prompt: null,
  promptError: null,
  references: [],
  script: null,
  scriptError: null,
  yaml: null,
  yamlError: null,
  ...overrides,
});

const VIEW = {
  version: 1,
  pack: 'acme/kit',
  title: 'Kit',
  summary: 'Kit.',
  stages: [
    {
      id: 'ready',
      label: 'Ready',
      blurb: 'Ready.',
      group: 'land',
      workflows: ['land'],
      drilldown: {
        phases: [
          {
            label: 'Merge',
            cards: [
              {
                title: 'Merge',
                text: 'Merges the change',
                icon: 'git-merge',
                kind: 'agent',
                covers: [{ workflow: 'land', steps: ['land'] }],
              },
            ],
          },
        ],
      },
    },
  ],
  placement: {},
  endings: {},
  landed: { stage: 'ready' },
  map: { cards: [], arrows: [] },
  returns: [{ workflow: 'land', node: 'gate', outcome: 'return' }],
  approves: [{ workflow: 'land', node: 'gate', outcome: 'land' }],
  verdicts: { land: { gate: { ask: 'asked' } } },
} as unknown as Declaration;

const name = (key: string): string => `${key.charAt(0).toUpperCase()}${key.slice(1)}`;

const facts = (target: FactoryStep, steps: FactoryStep[] = [target]) =>
  stepFacts({ step: target, view: VIEW, workflow: 'land', steps, groups: [], stepName: name });

describe('stepFacts', () => {
  test('leaves out every row it knows nothing for: a lone script step is only its kind', () => {
    expect(facts(step('end', { kind: 'script', model: ['@lander'] }))).toEqual([
      { key: 'kind', label: 'Kind', text: 'Script' },
    ]);
  });

  test('a step the view declares outcomes for says what each does', () => {
    const outcomes = facts(step('gate')).find(fact => fact.key === 'outcomes');
    // Plain words first, the pack's outcome id second.
    expect(outcomes?.outcomes).toEqual([
      { words: 'Asks you', id: 'ask' },
      { words: 'Sends it back', id: 'return' },
      { words: 'Approves it', id: 'land' },
    ]);
  });

  test('names what starts after it, by the condition when one reads this step', () => {
    const land = step('land', { model: ['@lander', 'medium'] });
    const end = step('end', { kind: 'script', dependsOn: ['land'] });
    const notify = step('notify', {
      dependsOn: ['land'],
      when: "$land.output == 'landed'",
      whenClauses: [[{ reads: { kind: 'step', key: 'land' }, operator: '==', value: 'landed' }]],
    });
    const rows = facts(land, [land, end, notify]);
    expect(rows.find(fact => fact.key === 'model')?.text).toBe('Lander tier, else medium');
    expect(rows.find(fact => fact.key === 'then')?.lines).toEqual([
      'End, after this step',
      'Notify, if Land = landed',
    ]);
  });

  test('a loop that waits on the step starts after it, by its name and rounds', () => {
    const deliver = deliverJson as FactoryWorkflow;
    const build = deliver.steps.find(candidate => candidate.key === 'build__build');
    if (build === undefined) throw new Error('the fixture has no build step');
    const then = stepFacts({
      step: build,
      view: VIEW,
      workflow: 'deliver',
      steps: deliver.steps,
      groups: deliver.groups,
      stepName: name,
    }).find(fact => fact.key === 'then');
    expect(then?.lines).toEqual(['Rounds, up to 3 rounds, after this step']);
  });

  test("a step a result starts through its condition is listed: the verdict's fix, next round", () => {
    const deliver = deliverJson as FactoryWorkflow;
    const thenOf = (key: string): string[] | undefined => {
      const target = deliver.steps.find(candidate => candidate.key === key);
      if (target === undefined) throw new Error(`the fixture has no ${key}`);
      return stepFacts({
        step: target,
        view: VIEW,
        workflow: 'deliver',
        steps: deliver.steps,
        groups: deliver.groups,
        stepName: name,
      }).find(fact => fact.key === 'then')?.lines;
    };
    expect(thenOf('rounds.verdict__verdict')).toEqual([
      'Rounds.fix, next round, if Rounds.verdict__verdict = return',
    ]);
    expect(thenOf('hostrounds.host__host')).toEqual([
      'Hostrounds.hostfix, next round, if Hostrounds.host__host = return',
    ]);
  });

  test('lists the inputs and step outputs its prompt reads, by name', () => {
    const rows = facts(
      step('land', {
        prompt: 'x',
        references: [
          { kind: 'input', token: '$INPUTS.item', name: 'item' },
          { kind: 'input', token: '$INPUTS.validate_command', name: 'validate_command' },
          { kind: 'output', token: '$gate.output.why', key: 'gate', path: 'why' },
        ],
      })
    );
    expect(rows.find(fact => fact.key === 'reads')?.chips).toEqual(['item', 'validate command']);
    expect(rows.find(fact => fact.key === 'reads-steps')?.lines).toEqual(['Gate output, why']);
  });

  test('an expression no parser took shows as written', () => {
    const when = facts(step('land', { when: 'odd expression' })).find(fact => fact.key === 'when');
    expect(when).toEqual({ key: 'when', label: 'Runs when', text: 'odd expression', mono: true });
  });
});

describe('modelWords', () => {
  test('a tier reads as its name and "tier"; a model as written', () => {
    expect(modelWords(['@judge', 'medium'])).toBe('Judge tier, else medium');
    expect(modelWords(['sonnet'])).toBe('sonnet');
  });
});

describe('coveringCard', () => {
  test('is the drill-down card covering the step, else undefined', () => {
    expect(coveringCard(VIEW, 'land', 'land')?.text).toBe('Merges the change');
    expect(coveringCard(VIEW, 'land', 'end')).toBeUndefined();
    expect(coveringCard(VIEW, 'deliver', 'land')).toBeUndefined();
  });
});
