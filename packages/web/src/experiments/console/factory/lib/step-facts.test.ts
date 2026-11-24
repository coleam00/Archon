import { describe, expect, test } from 'bun:test';
import type { FactoryWorkflow } from '../../skills/factory';
import deliverJson from './fixtures/deliver-workflow.json';
import { stepFacts } from './step-facts';
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

  test('a loop that waits on the step, and a step a result starts next round, start after it', () => {
    const deliver = deliverJson as FactoryWorkflow;
    const thenOf = (key: string): string[] | undefined =>
      stepFacts({
        step: deliver.steps.find(candidate => candidate.key === key)!,
        view: VIEW,
        workflow: 'deliver',
        steps: deliver.steps,
        groups: deliver.groups,
        stepName: name,
      }).find(fact => fact.key === 'then')?.lines;
    expect(thenOf('build__build')).toEqual(['Rounds, up to 3 rounds, after this step']);
    expect(thenOf('rounds.verdict__verdict')).toEqual([
      'Rounds.fix, next round, if Rounds.verdict__verdict = return',
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
});
