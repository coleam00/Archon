import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { providerRegistry } from '@archon/providers';
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
  fields: { from?: string; to?: string; discoveryCwd?: string; inputs?: unknown } = {}
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
    triggersDirectory: () => triggers,
    projectKeyOf: async (cwd: string) => (cwd === project ? 'acme/widgets' : 'acme/other'),
  };
  return { root, project, source, write, deps };
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

  test('a pack in a separate workflow source is read from there, with the project arrows', async () => {
    const { project, source, write, deps } = await fixture('source');
    await write('here', trigger('here', project, { discoveryCwd: source }));

    const graph = await readPackGraph(project, 'chain', deps, { workflowSource: source });

    expect(graph.arrows).toMatchObject([
      { active: true, installed: { sourceInstanceId: 'here', problems: [] } },
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
    expect(arrow?.active && arrow.installed.problems.length).toBeGreaterThan(0);
    expect(graph.stages.find(s => s.name === 'chain-a')?.outcome?.values).toContainEqual({
      value: 'ready',
      startsNothing: true,
    });
  });
});
