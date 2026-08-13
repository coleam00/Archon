import { chmod, mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, test } from 'bun:test';
import { discoverWorkflows } from './workflow-discovery';
import { COMPILED_LOOP_COMMAND, type LoopWithCompiledCommand } from './compiled-command';

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
    const compiled =
      repeat && 'loop' in repeat
        ? (repeat.loop as typeof repeat.loop & LoopWithCompiledCommand)[COMPILED_LOOP_COMMAND]
        : undefined;
    expect(compiled?.prompt).toBe('Read $inc__seed.output and continue.');
    expect(repeat && 'loop' in repeat ? repeat.loop.command : undefined).toBe('nested-command');
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

  test.skipIf(process.platform === 'win32')(
    'fails closed when a matched project command cannot be read',
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'archon-workflow-discovery-'));
      tempDirectories.push(cwd);
      const workflowDir = join(cwd, '.archon', 'workflows');
      const commandDir = join(cwd, '.archon', 'commands');
      const archonHome = join(cwd, 'home');
      const homeCommandDir = join(archonHome, 'commands');
      await Promise.all([
        mkdir(workflowDir, { recursive: true }),
        mkdir(commandDir, { recursive: true }),
        mkdir(homeCommandDir, { recursive: true }),
      ]);
      await writeFile(
        join(workflowDir, 'block.yaml'),
        JSON.stringify({
          name: 'read-error-block',
          description: 'Matched command read errors must not fall through',
          nodes: [{ id: 'review', command: 'read-error-command' }],
        })
      );
      await writeFile(
        join(workflowDir, 'parent.yaml'),
        JSON.stringify({
          name: 'parent',
          description: 'Includes a command whose project file is unreadable',
          nodes: [{ id: 'inc', include: 'read-error-block' }],
        })
      );
      const projectCommandPath = join(commandDir, 'read-error-command.md');
      await writeFile(projectCommandPath, 'PROJECT body must not fall through.');
      await chmod(projectCommandPath, 0o000);
      await writeFile(
        join(homeCommandDir, 'read-error-command.md'),
        'HOME fallback must never execute.'
      );

      const originalArchonHome = process.env.ARCHON_HOME;
      process.env.ARCHON_HOME = archonHome;
      try {
        const result = await discoverWorkflows(cwd, { loadDefaults: false });

        expect(result.workflows.map(item => item.workflow.name)).not.toContain('parent');
        const message = result.errors.find(error => error.filename === 'parent.yaml')?.error;
        expect(message).toContain("included workflow 'read-error-block'");
        expect(message).toContain("node 'review'");
        expect(message).toContain("command 'read-error-command'");
        expect(message).toContain(projectCommandPath);
        expect(message).toContain('could not be read');
        expect(message).toContain('will not fall through');
      } finally {
        if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
        else process.env.ARCHON_HOME = originalArchonHome;
        await chmod(projectCommandPath, 0o600);
      }
    }
  );

  test.skipIf(process.platform === 'win32')(
    'fails closed when a higher-precedence command scope cannot be inspected',
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'archon-workflow-discovery-'));
      tempDirectories.push(cwd);
      const workflowDir = join(cwd, '.archon', 'workflows');
      const commandDir = join(cwd, '.archon', 'commands');
      const archonHome = join(cwd, 'home');
      const homeCommandDir = join(archonHome, 'commands');
      await Promise.all([
        mkdir(workflowDir, { recursive: true }),
        mkdir(commandDir, { recursive: true }),
        mkdir(homeCommandDir, { recursive: true }),
      ]);
      await writeFile(
        join(workflowDir, 'block.yaml'),
        JSON.stringify({
          name: 'scope-error-block',
          description: 'Scope inspection errors must not fall through',
          nodes: [{ id: 'review', command: 'scope-error-command' }],
        })
      );
      await writeFile(
        join(workflowDir, 'parent.yaml'),
        JSON.stringify({
          name: 'parent',
          description: 'Includes a command while the project scope is unreadable',
          nodes: [{ id: 'inc', include: 'scope-error-block' }],
        })
      );
      await writeFile(
        join(homeCommandDir, 'scope-error-command.md'),
        'HOME fallback must never execute.'
      );
      await chmod(commandDir, 0o000);

      const originalArchonHome = process.env.ARCHON_HOME;
      process.env.ARCHON_HOME = archonHome;
      try {
        const result = await discoverWorkflows(cwd, { loadDefaults: false });

        expect(result.workflows.map(item => item.workflow.name)).not.toContain('parent');
        const message = result.errors.find(error => error.filename === 'parent.yaml')?.error;
        expect(message).toContain("included workflow 'scope-error-block'");
        expect(message).toContain("node 'review'");
        expect(message).toContain("command 'scope-error-command'");
        expect(message).toContain(commandDir);
        expect(message).toContain('could not inspect higher-precedence command scope');
        expect(message).toContain('will not fall through');
      } finally {
        if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
        else process.env.ARCHON_HOME = originalArchonHome;
        await chmod(commandDir, 0o700);
      }
    }
  );
});
