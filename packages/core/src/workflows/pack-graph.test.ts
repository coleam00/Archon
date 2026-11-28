import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { providerRegistry } from '@archon/providers';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { readPackGraph } from './pack-graph';

const track = trackTempRoots();

const stage = (name: string) => `name: ${name}
description: ${name}
returns: { node: decide, outcome: outcome }
nodes:
  - id: decide
    bash: echo '{"outcome":"ready"}'
    output_format:
      type: object
      properties:
        outcome: { type: string, enum: [ready, park] }
      required: [outcome]
`;

function trigger(
  id: string,
  cwd: string,
  fields: {
    from?: string;
    to?: string;
    discoveryCwd?: string;
    inputs?: unknown;
    linked?: unknown;
  } = {}
) {
  return {
    version: 1,
    sourceInstanceId: id,
    binding: {
      bindingId: id,
      bindingRevision: null,
      hostId: 'host',
      runAsUserId: 'operator',
      resource: 'b',
      overlap: 'queue',
      launch: {
        cwd,
        workflowName: fields.to ?? 'chain-b',
        inputs: {},
        isolation: { kind: 'default' },
        ...(fields.discoveryCwd === undefined ? {} : { discoveryCwd: fields.discoveryCwd }),
      },
    },
    on: {
      runEnded: {
        workflowName: fields.from ?? 'chain-a',
        outcome: 'ready',
        ...(fields.inputs === undefined ? {} : { inputs: fields.inputs }),
        ...(fields.linked === undefined ? {} : { linked: fields.linked }),
      },
    },
  };
}

/** A root with a project checkout, a `chain` pack of two stages under `packRoot`, and triggers. */
async function fixture(packIn: 'project' | 'source') {
  const root = track(await mkdtemp(join(tmpdir(), 'archon-pack-graph-')));
  const project = join(root, 'project');
  const source = join(root, 'source');
  const pack = join(packIn === 'project' ? project : source, '.archon', 'workflows', 'chain');
  for (const name of ['chain-a', 'chain-b']) {
    await mkdir(join(pack, name), { recursive: true });
    await writeFile(join(pack, name, `${name}.yaml`), stage(name));
  }
  await mkdir(join(pack, '.pack'), { recursive: true });
  await writeFile(join(pack, '.pack', 'pack.yaml'), '{}\n');
  await mkdir(project, { recursive: true });
  const triggers = join(root, 'triggers');
  await mkdir(triggers, { recursive: true });
  const write = (name: string, value: unknown) =>
    writeFile(join(triggers, `${name}.json`), JSON.stringify(value));
  const deps = {
    loadConfig: async () => ({
      assistant: 'claude' as const,
      assistants: { claude: {}, codex: {} },
      commands: {},
    }),
    providers: providerRegistry,
    projectOf: async () => null,
    triggersDirectory: () => triggers,
    projectKeyOf: async (cwd: string) => (cwd === project ? 'acme/widgets' : 'acme/other'),
  };
  return { root, project, source, pack, write, deps };
}

describe('readPackGraph', () => {
  test('reads only the run-ended files that launch in the pack project and touch its stages', async () => {
    const { root, project, write, deps } = await fixture('project');
    const other = join(root, 'other');
    await mkdir(other, { recursive: true });
    await write('here', trigger('here', project));
    await write('there', trigger('there', other));
    // Same project, but neither end is a stage of the pack.
    await write('unrelated', trigger('unrelated', project, { from: 'x-a', to: 'x-b' }));

    const graph = await readPackGraph(project, 'chain', deps);

    expect(graph.stages.map(s => s.name).sort()).toEqual(['chain-a', 'chain-b']);
    expect(graph.arrows.map(arrow => arrow.installed?.sourceInstanceId)).toEqual(['here']);
  });

  test("the document's groups lose only a stale stage, and an ungrouped in-flow stage is a problem", async () => {
    const { project, pack, write, deps } = await fixture('project');
    await write('here', trigger('here', project));
    // `chain-c` is a workflow of the pack that nothing starts: not in flow, so no group needs it.
    await mkdir(join(pack, 'chain-c'), { recursive: true });
    await writeFile(join(pack, 'chain-c', 'chain-c.yaml'), stage('chain-c'));
    // No `document` key: the pack's `how-it-works.md` is read.
    await writeFile(
      join(pack, 'archon-plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        kind: 'workflow-pack',
        name: 'chain',
        description: 'A pack.',
        entrypoints: { 'chain-a': 'chain-a/chain-a.yaml', 'chain-b': 'chain-b/chain-b.yaml' },
      })
    );
    await writeFile(
      join(pack, 'how-it-works.md'),
      '---\ncolour: blue\ngroups:\n  - name: Start\n    kind: intake\n    stages: [chain-a, ghost]\n---\n# Chain\n'
    );

    const graph = await readPackGraph(project, 'chain', deps);

    expect(graph.stages.find(s => s.workflow === 'chain-c')?.inFlow).toBe(false);
    expect(graph.document?.path).toBe('how-it-works.md');
    expect(graph.document?.text).toBe('# Chain\n');
    // One problem each: the stale name, the in-flow stage left out, and the unknown key.
    const problems = graph.document?.problems ?? [];
    expect(problems).toHaveLength(3);
    expect(problems.filter(problem => problem.includes("'ghost'"))).toHaveLength(1);
    expect(problems.filter(problem => problem.includes("'chain-b'"))).toHaveLength(1);
    expect(problems.filter(problem => problem.includes("'colour'"))).toHaveLength(1);
    expect(problems.some(problem => problem.includes('chain-c'))).toBe(false);
    expect(graph.groups).toEqual([{ name: 'Start', kind: 'intake', stages: ['chain-a'] }]);
  });

  test('a setting naming a missing file is a settings problem, and the other values still show', async () => {
    const { project, pack, deps } = await fixture('project');
    await writeFile(
      join(pack, '.pack', 'pack.yaml'),
      'inputs:\n  policy:\n    file: true\n  label: {}\n'
    );
    // A file setting is checked only where a stage reads it.
    await writeFile(
      join(pack, 'chain-a', 'chain-a.yaml'),
      stage('chain-a').replace("bash: echo '", "bash: cat $INPUTS.policy; echo '")
    );
    await mkdir(join(project, '.archon', 'packs'), { recursive: true });
    await writeFile(
      join(project, '.archon', 'packs', 'chain.yaml'),
      'settings:\n  policy: docs/missing.md\n  label: hello\n'
    );

    const graph = await readPackGraph(project, 'chain', deps);

    expect(graph.settingsFile.problems).toEqual([expect.stringContaining('policy')]);
    expect(graph.settings.map(setting => [setting.name, setting.value])).toEqual([
      ['policy', 'docs/missing.md'],
      ['label', 'hello'],
    ]);
  });

  test('discovers through the discover it is given, from the workflow source', async () => {
    const { project, source, deps } = await fixture('source');
    const roots: string[] = [];
    const graph = await readPackGraph(
      project,
      'chain',
      {
        ...deps,
        discover: root => {
          roots.push(root);
          return discoverWorkflowsWithConfig(root, deps.loadConfig, deps.providers);
        },
      },
      { workflowSource: source }
    );
    expect(roots).toEqual([source]);
    expect(graph.stages.map(s => s.name).sort()).toEqual(['chain-a', 'chain-b']);
  });

  test('a pack in a separate workflow source is read from there, with the project arrows', async () => {
    const { project, source, write, deps } = await fixture('source');
    await write('here', trigger('here', project, { discoveryCwd: source }));

    const graph = await readPackGraph(project, 'chain', deps, { workflowSource: source });

    expect(graph.arrows).toMatchObject([
      { active: true, installed: { sourceInstanceId: 'here', problems: [] } },
    ]);
  });

  test("a linked file's arrow shows the items it names and the inputs read from each entry", async () => {
    const { project, write, deps } = await fixture('project');
    const linked = { kind: 'part_of', holder: 'from', items: '/start' } as const;
    await write(
      'split',
      trigger('split', project, {
        linked,
        inputs: { brief: { entry: '/brief' }, parent: { item: 'key' } },
      })
    );

    const graph = await readPackGraph(project, 'chain', deps);

    expect(graph.arrows.map(arrow => arrow.linked)).toEqual([
      { ...linked, entries: { brief: '/brief' } },
    ]);
  });

  test('an arrow whose input mapping the run preflight refuses carries the problem', async () => {
    const { project, write, deps } = await fixture('project');
    await write(
      'broken',
      trigger('broken', project, { inputs: { plan: { input: 'does_not_exist' } } })
    );

    const graph = await readPackGraph(project, 'chain', deps);

    const [arrow] = graph.arrows;
    if (!arrow?.active) throw new Error('the installed file is not an active arrow');
    expect(arrow.installed.problems).not.toEqual([]);
    expect(graph.stages.find(s => s.name === 'chain-a')?.outcome?.values).toContainEqual({
      value: 'ready',
      startsNothing: true,
      ends: false,
      stops: true,
    });
  });

  test('a file whose target observes its item, outside the pack, starts no step', async () => {
    const { project, write, deps } = await fixture('project');
    await writeFile(
      join(project, '.archon', 'workflows', 'shadow.yaml'),
      'name: shadow\ndescription: shadow\nobserves: true\nnodes:\n  - id: look\n    bash: echo look\n'
    );
    await write('shadow', trigger('shadow', project, { to: 'shadow' }));

    const graph = await readPackGraph(project, 'chain', deps);

    expect(graph.arrows[0]).toMatchObject({ active: true, installed: { problems: [] } });
    expect(graph.stages.find(s => s.name === 'chain-a')?.outcome?.values).toContainEqual({
      value: 'ready',
      startsNothing: false,
      ends: false,
      stops: true,
    });
  });

  test('a file whose launch checkout is gone never starts, so it shows with that problem', async () => {
    const { root, project, write, deps } = await fixture('project');
    await write('stale', trigger('stale', join(root, 'removed-checkout')));

    const graph = await readPackGraph(project, 'chain', deps);

    const [arrow] = graph.arrows;
    if (!arrow?.active) throw new Error('the installed file is not an active arrow');
    // One problem, naming the checkout that is gone; its wording is free to change.
    expect(arrow.installed.problems).toEqual([
      expect.stringContaining(join(root, 'removed-checkout')),
    ]);
    expect(graph.stages.find(s => s.name === 'chain-a')?.outcome?.values).toContainEqual({
      value: 'ready',
      startsNothing: true,
      ends: false,
      stops: true,
    });
  });

  test('a declared stage that fails to load leaves the graph, its arrow and the load error', async () => {
    const { project, pack, deps } = await fixture('project');
    await writeFile(
      join(pack, '.pack', 'pack.yaml'),
      'bindings:\n  next:\n    workflow: chain-b\n    resource: b\n    overlap: queue\n    run_ended: { workflow: chain-a, outcome: ready }\n'
    );
    await writeFile(
      join(pack, 'chain-b', 'chain-b.yaml'),
      'name: chain-b\ndescription: b\nnodes:\n  - id: w\n    include: missing-block\n'
    );

    const graph = await readPackGraph(project, 'chain', deps);

    expect(graph.stages.map(s => s.name)).toEqual(['chain-a']);
    expect(graph.discoveryErrors).toContainEqual(
      expect.objectContaining({ filename: 'chain-b.yaml', workflowName: 'chain-b' })
    );
    expect(graph.arrows).toMatchObject([
      {
        from: { stage: 'chain-a', outcome: 'ready' },
        to: 'chain-b',
        active: false,
        declared: { binding: 'next', problems: [expect.stringContaining("'chain-b'")] },
      },
    ]);
  });
});
