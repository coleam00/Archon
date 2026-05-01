import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createAgent, deleteAgent, readAgent, writeAgent } from './read-write';
import { AgentFrontmatterError, AgentNameError } from './types';

describe('agents read-write', () => {
  let tempHome: string;
  let tempProject: string;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'agents-home-'));
    tempProject = await mkdtemp(join(tmpdir(), 'agents-proj-'));
    await mkdir(join(tempHome, '.claude', 'agents'), { recursive: true });
    await mkdir(join(tempProject, '.claude', 'agents'), { recursive: true });
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
    await rm(tempProject, { recursive: true, force: true });
  });

  test('createAgent writes a file and reads back', async () => {
    const detail = await createAgent(
      'reviewer',
      'project',
      tempProject,
      { name: 'reviewer', description: 'reviews code', model: 'sonnet' },
      'You are a reviewer.\n'
    );
    expect(detail.name).toBe('reviewer');
    expect(detail.body.trim()).toBe('You are a reviewer.');
    expect(detail.model).toBe('sonnet');

    const filePath = join(tempProject, '.claude', 'agents', 'reviewer.md');
    const onDisk = await readFile(filePath, 'utf8');
    expect(onDisk.startsWith('---\n')).toBe(true);
    expect(onDisk).toContain('name: reviewer');
  });

  test('createAgent forces frontmatter.name to filename', async () => {
    const detail = await createAgent(
      'agent-x',
      'project',
      tempProject,
      { name: 'wrong-name', description: 'desc' },
      'body'
    );
    expect(detail.frontmatter.name).toBe('agent-x');
  });

  test('createAgent rejects duplicate names', async () => {
    await createAgent('dup', 'project', tempProject, { name: 'dup', description: 'first' }, 'a');
    await expect(
      createAgent('dup', 'project', tempProject, { name: 'dup', description: 'second' }, 'b')
    ).rejects.toThrow(/already exists/);
  });

  test('createAgent rejects empty description', async () => {
    await expect(
      createAgent('blank', 'project', tempProject, { name: 'blank', description: '' }, 'b')
    ).rejects.toThrow(AgentFrontmatterError);
  });

  test('writeAgent rejects frontmatter.name drift', async () => {
    await createAgent('keep', 'project', tempProject, { name: 'keep', description: 'd' }, '');
    await expect(
      writeAgent('keep', 'project', tempProject, { name: 'renamed', description: 'd' }, '')
    ).rejects.toThrow(AgentNameError);
  });

  test('writeAgent updates body and frontmatter', async () => {
    await createAgent(
      'foo',
      'project',
      tempProject,
      { name: 'foo', description: 'old' },
      'old body'
    );
    const updated = await writeAgent(
      'foo',
      'project',
      tempProject,
      { name: 'foo', description: 'new', model: 'haiku' },
      'new body'
    );
    expect(updated.description).toBe('new');
    expect(updated.body.trim()).toBe('new body');
    expect(updated.model).toBe('haiku');
  });

  test('readAgent surfaces parseError but still returns body', async () => {
    const broken = join(tempProject, '.claude', 'agents', 'broken.md');
    await mkdir(join(tempProject, '.claude', 'agents'), { recursive: true });
    await import('fs/promises').then(async fs => fs.writeFile(broken, 'not-frontmatter\n', 'utf8'));
    const detail = await readAgent('broken', 'project', tempProject);
    expect(detail.parseError).not.toBe(null);
    expect(detail.body).toContain('not-frontmatter');
  });

  test('deleteAgent removes the file', async () => {
    await createAgent('zap', 'project', tempProject, { name: 'zap', description: 'go' }, '');
    await deleteAgent('zap', 'project', tempProject);
    await expect(readAgent('zap', 'project', tempProject)).rejects.toThrow();
  });

  test('reserved names are rejected', async () => {
    await expect(
      createAgent('claude', 'project', tempProject, { name: 'claude', description: 'd' }, '')
    ).rejects.toThrow(AgentNameError);
    await expect(
      createAgent('_internal', 'project', tempProject, { name: '_internal', description: 'd' }, '')
    ).rejects.toThrow(AgentNameError);
  });
});
