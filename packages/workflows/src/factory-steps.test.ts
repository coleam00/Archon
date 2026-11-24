import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { providerRegistry } from '@archon/providers';
import { trackTempRoots } from '@archon/paths/test-utils';
import * as bundleInventory from './defaults/bundle-inventory';
import { factoryWorkflowSteps } from './factory-steps';
import { DEFAULT_WORKFLOW_SOURCE_CONFIG, liveSourceRoots } from './workflow-source';
import { discoverWorkflows } from './workflow-discovery';

const track = trackTempRoots();
const indexSpy = spyOn(bundleInventory, 'readBundleIndex').mockResolvedValue([]);
afterAll(() => {
  indexSpy.mockRestore();
});

/** A folder pack `kit` in a project: `ship` includes three small workflows, one inside a loop. */
const PACK: Record<string, string> = {
  'ship/ship.yaml': `name: ship
description: Ships.
nodes:
  - id: start
    include: setup
  # Authored at the top with the include separator in it: not an include.
  - id: odd__id
    depends_on: [start]
    bash: echo top
  - id: rounds
    depends_on: [odd__id]
    when: "$odd__id.output != 'skip'"
    loop_group:
      max_iterations: 3
      until_bash: "true"
      nodes:
        - id: fix
          command: fix
          model: ['@builder', large]
          when: "$odd__id.output == 'go' && $LOOP_PREV.verdict__decide.output == 'return'"
        - id: check
          include: check
          depends_on: [fix]
          trigger_rule: all_done
        - id: verdict
          include: verdict
          depends_on: [check]
  - id: result
    depends_on: [rounds]
    when: "$odd__id.output != '' && $INPUTS.mode == 'fast' || $rounds.output.score >= 80"
    runtime: bun
    script: console.log('{}')
  - id: tally
    depends_on: [result]
    runtime: bun
    script: tally
`,
  // A named script, with CRLF line ends as a Windows checkout may hold them.
  '.shared/scripts/tally.ts': "console.log('tally');\r\nconsole.log('done');\r\n",
  'ship/commands/fix.md': [
    '# Fix what came back',
    'Land $INPUTS.item on `$INPUTS.land_on`; read $INPUTS.item again, and $INPUTS.output.',
    'Read $odd__id.output, then $odd__id.output.why and $LOOP_PREV.verdict__decide.output.why.',
  ].join('\n'),
  'setup/setup.yaml': `name: setup
description: Sets up.
nodes:
  - id: s
    prompt: Set up.
`,
  'check/check.yaml': `name: check
description: Checks.
nodes:
  - id: look
    command: look
`,
  'check/commands/look.md': '# Look at it\n',
  'verdict/verdict.yaml': `name: verdict
description: Decides.
nodes:
  - id: decide
    bash: echo approve
`,
};

/** `ship`'s steps, discovered from the pack above in a scratch project. */
async function shipSteps(): Promise<Awaited<ReturnType<typeof factoryWorkflowSteps>>> {
  const project = track(await mkdtemp(join(tmpdir(), 'archon-factory-steps-')));
  const fileOf = (path: string): string =>
    join(project, '.archon', 'workflows', 'kit', ...path.split('/'));
  for (const [path, content] of Object.entries(PACK)) {
    const file = fileOf(path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  const { workflows, errors } = await discoverWorkflows(project, {
    providers: providerRegistry,
    loadDefaults: false,
  });
  expect(errors).toEqual([]);
  const ship = workflows.find(entry => entry.workflow.name === 'ship');
  if (ship === undefined) throw new Error('ship was not discovered');
  return factoryWorkflowSteps('ship', ship.workflow, {
    cwd: project,
    deps: { loadConfig: async () => ({}) as never },
    roots: liveSourceRoots(project, DEFAULT_WORKFLOW_SOURCE_CONFIG),
  });
}

describe('factoryWorkflowSteps', () => {
  test('a loop group frames its body, and each include is a group named for its workflow', async () => {
    const ship = await shipSteps();
    expect(ship.groups.map(g => [g.id, g.kind, g.parent, g.label, g.maxRounds])).toEqual([
      ['start', 'include', null, 'setup', null],
      ['rounds', 'loop', null, 'rounds', 3],
      ['rounds.check', 'include', 'rounds', 'check', null],
      ['rounds.verdict', 'include', 'rounds', 'verdict', null],
    ]);
    expect(ship.groups.find(g => g.id === 'rounds')?.dependsOn).toEqual(['odd__id']);
    // A loop's own condition is keyed as its steps' are.
    expect(ship.groups.find(g => g.id === 'rounds')?.whenClauses).toEqual([
      [{ reads: { kind: 'step', key: 'odd__id' }, operator: '!=', value: 'skip' }],
    ]);
    expect(ship.steps.map(s => [s.key, s.label, s.group, s.kind, s.includedFrom])).toEqual([
      ['start__s', 's', 'start', 'agent', 'setup'],
      ['odd__id', 'odd__id', null, 'bash', null],
      ['rounds.fix', 'fix', 'rounds', 'agent', null],
      ['rounds.check__look', 'look', 'rounds.check', 'agent', 'check'],
      ['rounds.verdict__decide', 'decide', 'rounds.verdict', 'bash', 'verdict'],
      ['result', 'result', null, 'script', null],
      ['tally', 'tally', null, 'script', null],
    ]);
  });

  test('dependencies inside a loop are keyed as run events name the steps', async () => {
    const steps = new Map((await shipSteps()).steps.map(s => [s.key, s]));
    expect(steps.get('rounds.check__look')?.dependsOn).toEqual(['rounds.fix']);
    expect(steps.get('rounds.verdict__decide')?.dependsOn).toEqual(['rounds.check__look']);
    expect(steps.get('result')?.dependsOn).toEqual(['rounds']);
  });

  test("a command step carries its model, condition, command file's prompt and authored YAML", async () => {
    const steps = new Map((await shipSteps()).steps.map(s => [s.key, s]));
    const fix = steps.get('rounds.fix');
    expect(fix?.model).toEqual(['@builder', 'large']);
    expect(fix?.when).toBe(
      "$odd__id.output == 'go' && $LOOP_PREV.verdict__decide.output == 'return'"
    );
    expect(fix?.command).toBe('fix');
    expect(fix?.prompt).toBe(PACK['ship/commands/fix.md']);
    expect(fix?.promptError).toBeNull();
    expect(fix?.yaml).toBe(
      "id: fix\ncommand: fix\nmodel: ['@builder', large]\nwhen: \"$odd__id.output == 'go' && $LOOP_PREV.verdict__decide.output == 'return'\""
    );
    // An included step's YAML and command come from the workflow that declared it.
    const look = steps.get('rounds.check__look');
    expect([look?.yaml, look?.command]).toEqual(['id: look\ncommand: look', 'look']);
    expect(look?.prompt).toContain('# Look at it');
  });

  test("a condition's clauses and a prompt's references are keyed as run events name the steps", async () => {
    const steps = new Map((await shipSteps()).steps.map(s => [s.key, s]));
    const step = (key: string) => ({ kind: 'step' as const, key });
    // In a loop body: a top-level step by its own id, a sibling under the loop's prefix.
    expect(steps.get('rounds.fix')?.whenClauses).toEqual([
      [
        { reads: step('odd__id'), operator: '==', value: 'go' },
        { reads: step('rounds.verdict__decide'), operator: '==', value: 'return' },
      ],
    ]);
    // And, or, inputs, other operators and an empty value are kept; the field read is dropped.
    expect(steps.get('result')?.whenClauses).toEqual([
      [
        { reads: step('odd__id'), operator: '!=', value: '' },
        { reads: { kind: 'input', name: 'mode' }, operator: '==', value: 'fast' },
      ],
      [{ reads: step('rounds'), operator: '>=', value: '80' }],
    ]);
    // Inputs and outputs once each, in order of first appearance; $INPUTS.output is an input.
    expect(steps.get('rounds.fix')?.references).toEqual([
      { kind: 'input', token: '$INPUTS.item', name: 'item' },
      { kind: 'input', token: '$INPUTS.land_on', name: 'land_on' },
      { kind: 'input', token: '$INPUTS.output', name: 'output' },
      { kind: 'output', token: '$odd__id.output', key: 'odd__id', path: null },
      { kind: 'output', token: '$odd__id.output.why', key: 'odd__id', path: 'why' },
      {
        kind: 'prior-output',
        token: '$LOOP_PREV.verdict__decide.output.why',
        key: 'rounds.verdict__decide',
        path: 'why',
      },
    ]);
    expect(steps.get('odd__id')?.references).toEqual([]);
  });

  test('a bash or script step runs no prompt; it carries its body, a named script its file', async () => {
    const steps = new Map((await shipSteps()).steps.map(s => [s.key, s]));
    expect(steps.get('odd__id')?.prompt).toBeNull();
    expect(steps.get('odd__id')?.yaml).toBe('id: odd__id\ndepends_on: [start]\nbash: echo top');
    expect(steps.get('odd__id')?.script).toEqual({ runtime: 'sh', name: null, body: 'echo top' });
    expect(steps.get('result')?.prompt).toBeNull();
    expect(steps.get('result')?.script).toEqual({
      runtime: 'bun',
      name: null,
      body: "console.log('{}')",
    });
    expect(steps.get('tally')?.script).toEqual({
      runtime: 'bun',
      name: 'tally',
      body: "console.log('tally');\nconsole.log('done');\n",
    });
    expect(steps.get('tally')?.scriptError).toBeNull();
    expect(steps.get('rounds.fix')?.script).toBeNull();
  });
});
