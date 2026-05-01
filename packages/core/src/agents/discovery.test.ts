import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { discoverAgents } from './discovery';

const AGENT_MD = (name: string, desc: string, extra = ''): string =>
  `---
name: ${name}
description: ${desc}
${extra}---

Body of ${name}.
`;

async function writeAgent(dir: string, name: string, desc: string, extra = ''): Promise<string> {
  const filePath = join(dir, `${name}.md`);
  await writeFile(filePath, AGENT_MD(name, desc, extra), 'utf8');
  return filePath;
}

describe('discoverAgents', () => {
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

  test('returns empty result when no agents exist', async () => {
    const result = await discoverAgents(tempProject);
    expect(result.agents).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test('discovers global agents', async () => {
    const globalDir = join(tempHome, '.claude', 'agents');
    await writeAgent(globalDir, 'foo', 'first global');
    await writeAgent(globalDir, 'bar', 'second global');
    const result = await discoverAgents(tempProject);
    expect(result.agents.map(a => a.name).sort()).toEqual(['bar', 'foo']);
    expect(result.agents.every(a => a.source === 'global')).toBe(true);
  });

  test('project entries override global by name', async () => {
    await writeAgent(join(tempHome, '.claude', 'agents'), 'shared', 'global version');
    await writeAgent(join(tempProject, '.claude', 'agents'), 'shared', 'project version');
    const result = await discoverAgents(tempProject);
    const shared = result.agents.find(a => a.name === 'shared');
    expect(shared?.source).toBe('project');
    expect(shared?.description).toBe('project version');
  });

  test('captures malformed frontmatter as parseError without aborting', async () => {
    const dir = join(tempHome, '.claude', 'agents');
    await writeAgent(dir, 'good', 'fine');
    await writeFile(join(dir, 'broken.md'), 'no frontmatter here, just text\n', 'utf8');
    const result = await discoverAgents(tempProject);
    const broken = result.agents.find(a => a.name === 'broken');
    expect(broken?.parseError).not.toBe(null);
    const good = result.agents.find(a => a.name === 'good');
    expect(good?.parseError).toBe(null);
  });

  test('detects symlinked agents', async () => {
    const target = await mkdtemp(join(tmpdir(), 'agents-target-'));
    try {
      const filePath = await writeAgent(target, 'linked', 'target agent');
      const link = join(tempHome, '.claude', 'agents', 'linked.md');
      await symlink(filePath, link);
      const result = await discoverAgents(tempProject);
      const linked = result.agents.find(a => a.name === 'linked');
      expect(linked?.isSymlink).toBe(true);
      expect(linked?.realPath).toBe(await realpath(filePath));
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  test('skips files starting with underscore (reserved for templates)', async () => {
    const dir = join(tempProject, '.claude', 'agents');
    await mkdir(join(dir, '_templates'), { recursive: true });
    await writeFile(
      join(dir, '_templates', 'default.md'),
      AGENT_MD('default', 'a template'),
      'utf8'
    );
    await writeAgent(dir, 'real', 'a real agent');
    const result = await discoverAgents(tempProject);
    expect(result.agents.map(a => a.name)).toEqual(['real']);
  });

  test('skips non-.md files', async () => {
    const dir = join(tempProject, '.claude', 'agents');
    await writeFile(join(dir, 'README.txt'), 'noise\n', 'utf8');
    await writeAgent(dir, 'real', 'a real agent');
    const result = await discoverAgents(tempProject);
    expect(result.agents.map(a => a.name)).toEqual(['real']);
  });

  test('extracts status, model, skill/tool counts from frontmatter', async () => {
    await writeAgent(
      join(tempProject, '.claude', 'agents'),
      'configured',
      'rich frontmatter',
      'status: draft\nmodel: opus\ntools: [Read, Bash]\nskills: [doc-search, summarize, runbook]\n'
    );
    const result = await discoverAgents(tempProject);
    const a = result.agents.find(x => x.name === 'configured');
    expect(a?.status).toBe('draft');
    expect(a?.model).toBe('opus');
    expect(a?.toolCount).toBe(2);
    expect(a?.skillCount).toBe(3);
  });

  test('defaults status to "active" when frontmatter omits it', async () => {
    await writeAgent(join(tempProject, '.claude', 'agents'), 'plain', 'no status field');
    const result = await discoverAgents(tempProject);
    expect(result.agents.find(a => a.name === 'plain')?.status).toBe('active');
  });
});
