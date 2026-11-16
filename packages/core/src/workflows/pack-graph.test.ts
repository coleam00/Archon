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

function trigger(id: string, cwd: string) {
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
      launch: { cwd, workflowName: 'chain-b', inputs: {}, isolation: { kind: 'default' } },
    },
    on: { runEnded: { workflowName: 'chain-a', outcome: 'ready' } },
  };
}

describe('readPackGraph', () => {
  test('reads only the run-ended files that launch in the pack project', async () => {
    const root = track(await mkdtemp(join(tmpdir(), 'archon-pack-graph-')));
    const project = join(root, 'project');
    const other = join(root, 'other');
    const pack = join(project, '.archon', 'workflows', 'chain');
    for (const name of ['chain-a', 'chain-b']) {
      await mkdir(join(pack, name), { recursive: true });
      await writeFile(join(pack, name, `${name}.yaml`), stage(name));
    }
    await mkdir(join(pack, '.pack'), { recursive: true });
    await writeFile(join(pack, '.pack', 'pack.yaml'), '{}\n');
    await mkdir(other, { recursive: true });
    const triggers = join(root, 'triggers');
    await mkdir(triggers, { recursive: true });
    await writeFile(join(triggers, 'here.json'), JSON.stringify(trigger('here', project)));
    await writeFile(join(triggers, 'there.json'), JSON.stringify(trigger('there', other)));

    const graph = await readPackGraph(project, 'chain', {
      loadConfig: async () => ({
        assistant: 'claude',
        assistants: { claude: {}, codex: {} },
        commands: {},
      }),
      providers: providerRegistry,
      triggersDirectory: () => triggers,
      projectKeyOf: async cwd => (cwd === project ? 'acme/widgets' : 'acme/other'),
    });

    expect(graph.stages.map(s => s.name).sort()).toEqual(['chain-a', 'chain-b']);
    expect(graph.arrows.map(arrow => arrow.installed?.sourceInstanceId)).toEqual(['here']);
  });
});
