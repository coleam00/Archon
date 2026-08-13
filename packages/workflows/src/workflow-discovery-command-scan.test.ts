import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, test } from 'bun:test';
import { discoverWorkflows } from './workflow-discovery';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  );
});

describe('discoverWorkflows — nested included command compilation', () => {
  test('pre-resolves and compiles loop_group command files before include expansion', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'archon-workflow-discovery-'));
    tempDirectories.push(cwd);
    const workflowDir = join(cwd, '.archon', 'workflows');
    const commandDir = join(cwd, '.archon', 'commands');
    await Promise.all([
      mkdir(workflowDir, { recursive: true }),
      mkdir(commandDir, { recursive: true }),
    ]);

    await writeFile(
      join(workflowDir, 'block.yaml'),
      JSON.stringify({
        name: 'nested-block',
        description: 'Nested command scan fixture',
        nodes: [
          { id: 'seed', bash: 'echo seed' },
          {
            id: 'group',
            loop_group: {
              until: 'DONE',
              max_iterations: 1,
              nodes: [
                {
                  id: 'repeat',
                  loop: { command: 'nested-command', until: 'DONE', max_iterations: 1 },
                },
              ],
            },
          },
        ],
      })
    );
    await writeFile(
      join(workflowDir, 'parent.yaml'),
      JSON.stringify({
        name: 'parent',
        description: 'Nested command scan parent',
        nodes: [{ id: 'inc', include: 'nested-block' }],
      })
    );
    await writeFile(join(commandDir, 'nested-command.md'), 'Read $seed.output and continue.');

    const result = await discoverWorkflows(cwd, { loadDefaults: false });

    expect(result.errors.filter(error => error.filename === 'parent.yaml')).toHaveLength(0);
    const parent = result.workflows.find(item => item.workflow.name === 'parent')?.workflow;
    const group = parent?.nodes.find(node => node.id === 'inc__group');
    const repeat = group && 'loop_group' in group ? group.loop_group.nodes[0] : undefined;
    expect(repeat && 'loop' in repeat ? repeat.loop.prompt : '').toBe(
      'Read $inc__seed.output and continue.'
    );
  });

  test('rejects a command-body caller ref even when the parent has the same node id', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'archon-workflow-discovery-'));
    tempDirectories.push(cwd);
    const workflowDir = join(cwd, '.archon', 'workflows');
    const commandDir = join(cwd, '.archon', 'commands');
    await Promise.all([
      mkdir(workflowDir, { recursive: true }),
      mkdir(commandDir, { recursive: true }),
    ]);
    await writeFile(
      join(workflowDir, 'block.yaml'),
      JSON.stringify({
        name: 'leaky-block',
        description: 'Must not bind parent state',
        nodes: [{ id: 'review', command: 'leaky-command' }],
      })
    );
    await writeFile(
      join(workflowDir, 'parent.yaml'),
      JSON.stringify({
        name: 'parent',
        description: 'Has a colliding caller id',
        nodes: [
          { id: 'caller', bash: 'echo parent' },
          { id: 'inc', include: 'leaky-block', depends_on: ['caller'] },
        ],
      })
    );
    await writeFile(join(commandDir, 'leaky-command.md'), 'Use $caller.output directly.');

    const result = await discoverWorkflows(cwd, { loadDefaults: false });

    expect(result.workflows.map(item => item.workflow.name)).not.toContain('parent');
    const message = result.errors.find(error => error.filename === 'parent.yaml')?.error;
    expect(message).toContain("command 'leaky-command'");
    expect(message).toContain("'$caller.output'");
    expect(message).toContain('inputs:');
    expect(message).toContain('with:');
  });
});
