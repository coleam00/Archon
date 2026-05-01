import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  getProjectTemplatePath,
  readScaffoldTemplate,
  renderScaffold,
  writeScaffoldTemplate,
} from './template';

describe('agent template', () => {
  let tempHome: string;
  let tempProject: string;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'agents-home-'));
    tempProject = await mkdtemp(join(tmpdir(), 'agents-proj-'));
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
    await rm(tempProject, { recursive: true, force: true });
  });

  test('bootstraps the bundled default on first read', async () => {
    const { content, location } = await readScaffoldTemplate(tempProject);
    expect(location.preExisting).toBe(false);
    expect(location.source).toBe('project');
    expect(content).toContain('TEMPLATE_AGENT_NAME');
    // File was written.
    const onDisk = await readFile(getProjectTemplatePath(tempProject), 'utf8');
    expect(onDisk).toBe(content);
  });

  test('returns existing project template when present', async () => {
    const projPath = getProjectTemplatePath(tempProject);
    await mkdir(join(tempProject, '.claude', 'agents', '_templates'), { recursive: true });
    await writeFile(
      projPath,
      '---\nname: TEMPLATE_AGENT_NAME\ndescription: x\n---\n\nproject body\n'
    );
    const { content, location } = await readScaffoldTemplate(tempProject);
    expect(location.preExisting).toBe(true);
    expect(location.source).toBe('project');
    expect(content).toContain('project body');
  });

  test('falls back to global template when project missing', async () => {
    const globalPath = join(tempHome, '.claude', 'agents', '_templates', 'default.md');
    await mkdir(join(tempHome, '.claude', 'agents', '_templates'), { recursive: true });
    await writeFile(
      globalPath,
      '---\nname: TEMPLATE_AGENT_NAME\ndescription: g\n---\n\nglobal body\n'
    );
    const { content, location } = await readScaffoldTemplate(tempProject);
    expect(location.preExisting).toBe(true);
    expect(location.source).toBe('global');
    expect(content).toContain('global body');
  });

  test('writeScaffoldTemplate writes to project location', async () => {
    await writeScaffoldTemplate(
      tempProject,
      '---\nname: TEMPLATE_AGENT_NAME\ndescription: d\n---\n\nedited\n'
    );
    const onDisk = await readFile(getProjectTemplatePath(tempProject), 'utf8');
    expect(onDisk).toContain('edited');
  });

  test('renderScaffold replaces TEMPLATE_AGENT_NAME and the description placeholder', async () => {
    const tpl =
      '---\n' +
      'name: TEMPLATE_AGENT_NAME\n' +
      'description: One-line description shown in the registry list and used by the parent agent to decide when to delegate.\n' +
      '---\n\nbody for TEMPLATE_AGENT_NAME\n';
    const out = renderScaffold(tpl, { name: 'foo-bar', description: 'concrete desc' });
    expect(out).toContain('name: foo-bar');
    expect(out).toContain('description: concrete desc');
    expect(out).toContain('body for foo-bar');
    expect(out).not.toContain('TEMPLATE_AGENT_NAME');
  });
});
