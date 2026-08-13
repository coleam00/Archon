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

describe('discoverWorkflows — nested command-file scan', () => {
  test('pre-resolves loop_group command files before include expansion', async () => {
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

    expect(result.workflows.map(item => item.workflow.name)).not.toContain('parent');
    expect(result.errors.some(error => error.filename === 'parent.yaml')).toBe(true);
    expect(result.errors.some(error => error.error.includes("sibling node '$seed'"))).toBe(true);
  });
});
