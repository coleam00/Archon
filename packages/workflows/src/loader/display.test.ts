// @archon-test-isolated
import { discoverFiles, parseWorkflowYaml, useTempWorkflowRoot } from './test-utils';
import { describe, it, expect } from 'bun:test';
import { buildPackGraph } from '../pack-graph';
import { itemAsksJsonSchema, parseItemAsks } from '../schemas/item-ask';

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

  // Words never stop a run: each of these refused the workflow before. Now it loads and runs,
  // the bad words are dropped, and a warning names them.
  it('drops a malformed display block with a warning instead of refusing the workflow', () => {
    for (const line of ['display: { label: 1 }', 'display: [Decide]', 'display: { short: S }']) {
      const { workflow, warnings } = parseWorkflowYaml(stage(`${line}\n`));
      expect(workflow).not.toHaveProperty('display');
      expect(warnings.join('\n')).toContain('display');
    }
  });

  it('ignores an unknown display key, keeping the rest of the words', () => {
    const { workflow, warnings } = parseWorkflowYaml(
      stage('display: { label: Decide, future: { anything: 1 } }\n')
    );
    expect(workflow.display).toEqual({ label: 'Decide' });
    expect(warnings).toContain("Workflow 'decide': unknown display key 'future' is ignored");
  });

  it('drops only the malformed field, naming it, when a nested key is misspelt', () => {
    const { workflow, warnings } = parseWorkflowYaml(
      stage(
        'display: { label: Decide, short: Calls it, outcomes: { go: { label: Go, tale: x } } }\n'
      )
    );
    expect(workflow.display).toEqual({ label: 'Decide', short: 'Calls it' });
    expect(warnings.join('\n')).toContain('display.outcomes is invalid and ignored');
  });

  it('strips an unknown node display key, and drops a node display that does not parse', () => {
    const withWords = (words: string) =>
      parseWorkflowYaml(stage('').replace('    bash:', `    display: ${words}\n    bash:`));
    const typo = withWords('{ label: End, lable: End }');
    expect(typo.workflow.nodes[0]).toMatchObject({ display: { label: 'End' } });
    expect(typo.warnings).toContain("Node 'end': unknown display key 'lable' is ignored");
    for (const words of ['{}', '{ lable: End }']) {
      const { workflow, warnings } = withWords(words);
      expect(workflow.nodes[0]).not.toHaveProperty('display');
      expect(warnings.join('\n')).toContain("Node 'end': display is invalid and ignored");
    }
  });

  it('drops a malformed display on a loop body node, and the loop still loads', () => {
    const { workflow, warnings } = parseWorkflowYaml(`name: looped
description: loops
nodes:
  - id: rounds
    loop_group:
      until_bash: 'true'
      max_iterations: 2
      nodes:
        - id: verdict
          display: { text: Each verdict }
          bash: 'true'
`);
    const [rounds] = workflow.nodes;
    expect(rounds).toMatchObject({ loop_group: { nodes: [{ id: 'verdict' }] } });
    expect(JSON.stringify(rounds)).not.toContain('Each verdict');
    expect(warnings.join('\n')).toContain("loop_group node 'verdict': display is invalid");
  });

  it('drops words for an outcome the workflow cannot end with, keeping the label', () => {
    const { workflow, warnings } = parseWorkflowYaml(
      stage('display: { label: D, outcomes: { gone: { label: Gone } } }\n')
    );
    expect(workflow.display).toEqual({ label: 'D' });
    expect(warnings.join('\n')).toContain("display.outcomes names 'gone'");
    const plain = parseWorkflowYaml(`name: plain
description: no outcome
nodes:
  - id: end
    bash: 'true'
display: { label: Plain, outcomes: { go: { label: Go } } }
`);
    expect(plain.workflow.display).toEqual({ label: 'Plain' });
    expect(plain.warnings.join('\n')).toContain('declares no returns.outcome');
  });

  it('drops display: on an include node, whose label belongs on the included node', () => {
    const { workflow, warnings } = parseWorkflowYaml(`name: outer
description: includes
nodes:
  - id: blk
    include: decide
    display: { label: Block }
`);
    expect(workflow.nodes[0]).not.toHaveProperty('display');
    expect(warnings.join('\n')).toContain("'display' is ignored on an include node");
  });

  it('tells a pack still writing display.answers where the words went', () => {
    const { workflow, warnings } = parseWorkflowYaml(
      stage('display: { label: D, answers: { go: { label: Go } } }\n')
    );
    expect(workflow.display).toEqual({ label: 'D' });
    expect(warnings.join('\n')).toContain("its 'label' in returns.options");
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

describe('display: phases, marks, results and replaces, and option labels', () => {
  it('parses each and serves it as written', () => {
    const { workflow } = parseWorkflowYaml(
      asking(`display:
  label: Decide
  story: It decided
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
      marks: [{ node: 'rounds.verdict', outcome: 'stop', means: 'returns' }],
      results: { round: '/round', change: '/change' },
      replaces: [{ workflow: 'older', loops: { round: 'loop' } }],
    });
    expect(workflow.display?.phases?.[0]?.cards.map(card => card.covers)).toEqual([
      ['base'],
      ['rounds.verdict'],
    ]);
  });

  it("loads an option's label from returns.options, and its asks carry it", () => {
    const { workflow } = parseWorkflowYaml(
      asking('').replace(
        '{ id: send-back, does: Sends it back, cost: A round }',
        '{ id: send-back, label: sent back, does: Sends it back, cost: A round }'
      )
    );
    expect(workflow.result?.options).toEqual([
      { id: 'send-back', label: 'sent back', does: 'Sends it back', cost: 'A round' },
      { id: 'drop', does: 'Drops it', cost: 'The work' },
    ]);
    // The asks schema the model writes to is built from ids only, so a label never reaches it.
    const asks = parseItemAsks(
      [{ question: 'Q?', context: 'C', recommendation: null, artifacts: [] }],
      workflow.result?.options
    );
    expect(asks).toMatchObject({
      asks: [{ options: [{ id: 'send-back', label: 'sent back' }, { id: 'drop' }] }],
    });
    expect(JSON.stringify(itemAsksJsonSchema(workflow.result?.options))).not.toContain('sent back');
  });

  it('drops a card or a mark naming a step the workflow lacks, and a step two cards cover', () => {
    const card = (covers: string) =>
      asking(`display:
  label: D
  marks: [{ node: end, outcome: stop, means: returns }]
  phases:
    - label: P
      cards:
        - { title: A, text: a, icon: send, kind: script, covers: [${covers}] }
        - { title: B, text: b, icon: send, kind: script, covers: [end] }
`);
    for (const [covers, why] of [
      ['verdict', "display.phases card 'A' names step 'verdict', which the workflow does not have"],
      ['end', "cards 'A' and 'B' both cover step 'end'"],
    ] as const) {
      const { workflow, warnings } = parseWorkflowYaml(card(covers));
      expect(workflow.display).not.toHaveProperty('phases');
      // Only the field that names what the workflow lacks goes.
      expect(workflow.display?.marks).toHaveLength(1);
      expect(warnings.join('\n')).toContain(why);
    }
    const marked = parseWorkflowYaml(
      asking('display: { label: D, marks: [{ node: gone, outcome: stop, means: returns }] }\n')
    );
    expect(marked.workflow.display).toEqual({ label: 'D' });
    expect(marked.warnings.join('\n')).toContain("display.marks names step 'gone'");
  });

  it('drops a malformed slug, pointer or key at every level, keeping the label', () => {
    const bad = [
      ['results', 'display: { label: D, results: { round: round } }'],
      ['marks', 'display: { label: D, marks: [{ node: end, outcome: stop, means: Returns }] }'],
      [
        'phases',
        'display: { label: D, phases: [{ label: P, cards: [{ title: A, text: a, icon: Send, kind: script, covers: [end] }] }] }',
      ],
      ['replaces', 'display: { label: D, replaces: [{ workflow: older, loop: rounds }] }'],
      [
        'replaces',
        'display: { label: D, replaces: [{ workflow: older, results: { change: change } }] }',
      ],
    ] as const;
    for (const [field, line] of bad) {
      const { workflow, warnings } = parseWorkflowYaml(asking(`${line}\n`));
      expect(workflow.display).toEqual({ label: 'D' });
      expect(warnings.join('\n')).toContain(`display.${field} is invalid and ignored`);
    }
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
    // A step the flattened workflow lacks drops the phases; the workflow keeps its label.
    const bad = await discoverFiles(root(), {
      'check.yaml': check,
      'stage.yaml': stage('final__gone'),
    });
    expect(bad.errors).toEqual([]);
    const loaded = bad.workflows.find(entry => entry.workflow.name === 'stage');
    expect(loaded?.workflow.display).toEqual({ label: 'Checks' });
    expect(loaded?.parseWarnings?.join('\n')).toContain(
      "names step 'final__gone', which the workflow does not have"
    );
  });
});
