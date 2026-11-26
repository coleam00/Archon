// @archon-test-isolated
import {
  discoverFiles,
  parseError,
  parseWorkflow,
  parseWorkflowYaml,
  useTempWorkflowRoot,
} from './test-utils';
import { describe, it, expect } from 'bun:test';
import { buildPackGraph } from '../pack-graph';

/** A stage whose `end` node returns one of `values` as its outcome, with `extra` YAML after it. */
const stage = (extra: string, values = '[go, stop]') => `name: decide
description: decides
returns: { node: end, outcome: outcome }
nodes:
  - id: end
    bash: echo '{"outcome":"go"}'
    output_format:
      type: object
      properties: { outcome: { type: string, enum: ${values} } }
      required: [outcome]
${extra}`;

describe('display: on a workflow, a node and an outcome', () => {
  it('parses the words where they are authored', () => {
    const { workflow } = parseWorkflowYaml(
      stage(`display:
  label: Decide
  short: Makes the call
  blurb: Decides whether the item goes on.
  outcomes:
    go: { label: Went on, story: It went on }
    stop:
      story: { withChange: It stopped with a change, withoutChange: It stopped }
`).replace('    bash:', '    display: { label: Ends it, text: Hands the decision on }\n    bash:')
    );
    expect(workflow.display).toEqual({
      label: 'Decide',
      short: 'Makes the call',
      blurb: 'Decides whether the item goes on.',
      outcomes: {
        go: { label: 'Went on', story: 'It went on' },
        stop: { story: { withChange: 'It stopped with a change', withoutChange: 'It stopped' } },
      },
    });
    expect(workflow.nodes[0]).toMatchObject({
      display: { label: 'Ends it', text: 'Hands the decision on' },
    });
  });

  it('leaves a workflow without display: as it was', () => {
    const { workflow, warnings } = parseWorkflowYaml(stage(''));
    expect('display' in workflow).toBe(false);
    expect('display' in (workflow.nodes[0] ?? {})).toBe(false);
    expect(warnings).toEqual([]);
  });

  it('refuses an unknown key at every level as a load error, not a warning', () => {
    expect(parseError(stage('display: { label: Decide, lable: Decide }\n'))).toContain(
      "Invalid 'display'"
    );
    expect(
      parseError(stage('display: { label: Decide, outcomes: { go: { label: Go, tale: x } } }\n'))
    ).toContain("Invalid 'display'");
    expect(
      parseError(
        stage('').replace('    bash:', '    display: { label: End, lable: End }\n    bash:')
      )
    ).toContain('display');
    // A node display without its label is as wrong as a misspelt key.
    expect(
      parseWorkflow(stage('').replace('    bash:', '    display: {}\n    bash:'), 'x.yaml').workflow
    ).toBeNull();
  });

  it('refuses words for an outcome the workflow cannot end with', () => {
    expect(
      parseError(stage('display: { label: D, outcomes: { gone: { label: Gone } } }\n'))
    ).toContain("display.outcomes names 'gone'");
    expect(
      parseError(`name: plain
description: no outcome
nodes:
  - id: end
    bash: 'true'
display: { label: Plain, outcomes: { go: { label: Go } } }
`)
    ).toContain('display.outcomes but no returns.outcome');
  });

  it('refuses display: on an include node, whose label belongs on the included node', () => {
    expect(
      parseError(`name: outer
description: includes
nodes:
  - id: blk
    include: decide
    display: { label: Block }
`)
    ).toContain(
      "is not supported on an include node: it expands into the included workflow's nodes"
    );
  });
});

/** A stage that asks, whose `end` returns one of four outcomes and whose asks offer two options. */
const asking = (extra: string) => `name: decide
description: decides
returns:
  node: end
  outcome: outcome
  asks: asks
  options:
    - { id: send-back, does: Sends it back, cost: A round }
    - { id: drop, does: Drops it, cost: The work }
nodes:
  - id: base
    bash: 'true'
  - id: rounds
    depends_on: [base]
    loop_group:
      until_bash: 'true'
      max_iterations: 2
      nodes:
        - id: verdict
          bash: echo '{"outcome":"go"}'
  - id: end
    depends_on: [rounds]
    bash: echo '{"outcome":"go","asks":[]}'
    output_format:
      type: object
      properties:
        outcome: { type: string, enum: [go, stop] }
      required: [outcome]
${extra}`;

describe('display: answers, phases, marks, results and replaces', () => {
  it('parses each and serves it as written', () => {
    const { workflow } = parseWorkflowYaml(
      asking(`display:
  label: Decide
  story: It decided
  answers:
    send-back: { label: sent back }
    other: { label: something else }
  phases:
    - label: Read
      cards:
        - { title: Base, text: Reads the base, icon: git-branch, kind: script, covers: [base] }
        - { title: Verdict, text: Each round's verdict, icon: gavel, kind: check, covers: [rounds.verdict] }
  marks:
    - { node: rounds.verdict, outcome: stop, means: returns }
  results: { round: /round, change: /change }
  replaces:
    - workflow: older
      loops: { round: loop }
      marks: [{ node: loop.verdict__verdict, outcome: return, means: returns }]
      results: { change: /change }
`)
    );
    expect(workflow.display).toMatchObject({
      story: 'It decided',
      answers: { 'send-back': { label: 'sent back' }, other: { label: 'something else' } },
      marks: [{ node: 'rounds.verdict', outcome: 'stop', means: 'returns' }],
      results: { round: '/round', change: '/change' },
      replaces: [{ workflow: 'older', loops: { round: 'loop' } }],
    });
    expect(workflow.display?.phases?.[0]?.cards.map(card => card.covers)).toEqual([
      ['base'],
      ['rounds.verdict'],
    ]);
  });

  it('refuses an answer for an option the workflow does not declare', () => {
    expect(
      parseError(asking('display: { label: D, answers: { keep: { label: kept } } }\n'))
    ).toContain("display.answers names 'keep', which is not an option it declares");
    expect(
      parseError(stage('display: { label: D, answers: { other: { label: else } } }\n'))
    ).toContain('display.answers but no returns.options');
  });

  it('refuses a card or a mark naming a step the workflow lacks, and a step two cards cover', () => {
    const card = (covers: string) =>
      asking(`display:
  label: D
  phases:
    - label: P
      cards:
        - { title: A, text: a, icon: send, kind: script, covers: [${covers}] }
        - { title: B, text: b, icon: send, kind: script, covers: [end] }
`);
    expect(parseError(card('verdict'))).toContain(
      "display.phases card 'A' names step 'verdict', which it does not have"
    );
    expect(parseError(card('end'))).toContain("cards 'A' and 'B' both cover step 'end'");
    expect(
      parseError(
        asking('display: { label: D, marks: [{ node: gone, outcome: stop, means: returns }] }\n')
      )
    ).toContain("display.marks names step 'gone'");
  });

  it('refuses a malformed slug, pointer or key at every new level', () => {
    const bad = [
      'display: { label: D, results: { round: round } }',
      'display: { label: D, marks: [{ node: end, outcome: stop, means: Returns }] }',
      'display: { label: D, answers: { drop: { label: x, starts: y } } }',
      'display: { label: D, phases: [{ label: P, cards: [{ title: A, text: a, icon: Send, kind: script, covers: [end] }] }] }',
      'display: { label: D, replaces: [{ workflow: older, loop: rounds }] }',
      'display: { label: D, replaces: [{ workflow: older, results: { change: change } }] }',
    ];
    for (const line of bad) expect(parseError(asking(`${line}\n`))).toContain("Invalid 'display'");
  });
});

describe('the pack graph serves display:', () => {
  const root = useTempWorkflowRoot();

  it('serves stage, outcome and node words, an included node under its expanded id', async () => {
    const result = await discoverFiles(root(), {
      'check.yaml': `name: check
description: an included check
returns: { node: verdict, outcome: outcome }
display: { label: Check alone }
nodes:
  - id: verdict
    display: { label: Verdict }
    bash: echo '{"outcome":"approve"}'
    output_format:
      type: object
      properties: { outcome: { type: string, enum: [approve, return] } }
      required: [outcome]
`,
      'stage.yaml': `name: stage
description: includes the check at the top and in a loop body
returns: { node: final, outcome: outcome }
display:
  label: Checks
  short: Reads the change
  outcomes:
    return: { label: Sent back, story: The checks sent it back }
nodes:
  - id: base
    display: { label: Reads the base }
    bash: 'true'
  - id: rounds
    depends_on: [base]
    loop_group:
      until_bash: 'true'
      max_iterations: 2
      nodes:
        - id: verdict
          include: check
  - id: final
    include: check
    depends_on: [rounds]
`,
    });
    expect(result.errors).toEqual([]);
    const staged = result.workflows.map(w => w.workflow).filter(w => w.name === 'stage');
    const graph = buildPackGraph({
      packKey: 'chain',
      stages: staged,
      workflows: result.workflows.map(w => w.workflow),
      declared: undefined,
      installed: [],
      discoveryErrors: [],
    });
    const [only] = graph.stages;
    expect(only?.display).toEqual({ label: 'Checks', short: 'Reads the change' });
    expect(only?.display).not.toHaveProperty('outcomes');
    expect(only?.outcome?.values.map(v => [v.value, v.display])).toEqual([
      ['approve', undefined],
      ['return', { label: 'Sent back', story: 'The checks sent it back' }],
    ]);
    const labels = Object.fromEntries(only?.nodes.map(n => [n.id, n.display?.label]) ?? []);
    expect(labels).toEqual({
      base: 'Reads the base',
      rounds: undefined,
      'rounds.verdict__verdict': 'Verdict',
      final__verdict: 'Verdict',
    });
    // Absent, never null, so a pack without display: serves the same JSON as before.
    expect(only?.nodes.find(n => n.id === 'rounds')).not.toHaveProperty('display');
  });

  it('checks covered and marked steps of an including workflow by their expanded ids', async () => {
    const check = `name: check
description: an included check
nodes:
  - id: verdict
    bash: 'true'
`;
    const stage = (covers: string) => `name: stage
description: includes the check at the top and in a loop body
display:
  label: Checks
  phases:
    - label: Check
      cards:
        - { title: Verdict, text: Each verdict, icon: gavel, kind: check, covers: [${covers}] }
nodes:
  - id: rounds
    loop_group:
      until_bash: 'true'
      max_iterations: 2
      nodes:
        - id: verdict
          include: check
  - id: final
    include: check
    depends_on: [rounds]
`;
    const good = await discoverFiles(root(), {
      'check.yaml': check,
      'stage.yaml': stage('rounds.verdict__verdict, final__verdict'),
    });
    expect(good.errors).toEqual([]);
    const bad = await discoverFiles(root(), {
      'check.yaml': check,
      'stage.yaml': stage('final__gone'),
    });
    expect(bad.errors.map(error => error.error).join('\n')).toContain(
      "names step 'final__gone', which it does not have"
    );
  });
});
