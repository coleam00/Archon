import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadAgentFile } from './load-agent';

const AGENT_MD = (name: string, body = '', extra = ''): string =>
  `---
name: ${name}
description: example ${name}
${extra}---

${body || `Body of ${name}`}
`;

describe('loadAgentFile', () => {
  let tempHome: string;
  let tempProject: string;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'load-agent-home-'));
    tempProject = await mkdtemp(join(tmpdir(), 'load-agent-proj-'));
    process.env.HOME = tempHome;
    await mkdir(join(tempHome, '.claude', 'agents'), { recursive: true });
    await mkdir(join(tempProject, '.claude', 'agents'), { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
    await rm(tempProject, { recursive: true, force: true });
  });

  test('returns null when the agent does not exist anywhere', async () => {
    const out = await loadAgentFile('nonesuch', tempProject);
    expect(out).toBeNull();
  });

  test('reads project agent when present', async () => {
    await writeFile(
      join(tempProject, '.claude', 'agents', 'p1.md'),
      AGENT_MD('p1', 'project body', 'model: sonnet\ntools: [Read, Bash]\n'),
      'utf8'
    );
    const out = await loadAgentFile('p1', tempProject);
    expect(out).not.toBeNull();
    expect(out?.source).toBe('project');
    expect(out?.model).toBe('sonnet');
    expect(out?.tools).toEqual(['Read', 'Bash']);
    expect(out?.systemPrompt).toBe('project body');
  });

  test('falls back to global agent when project missing', async () => {
    await writeFile(
      join(tempHome, '.claude', 'agents', 'g1.md'),
      AGENT_MD('g1', 'global body'),
      'utf8'
    );
    const out = await loadAgentFile('g1', tempProject);
    expect(out?.source).toBe('global');
    expect(out?.systemPrompt).toBe('global body');
  });

  test('project overrides global', async () => {
    await writeFile(
      join(tempHome, '.claude', 'agents', 'shared.md'),
      AGENT_MD('shared', 'global'),
      'utf8'
    );
    await writeFile(
      join(tempProject, '.claude', 'agents', 'shared.md'),
      AGENT_MD('shared', 'project'),
      'utf8'
    );
    const out = await loadAgentFile('shared', tempProject);
    expect(out?.source).toBe('project');
    expect(out?.systemPrompt).toBe('project');
  });

  test('throws on malformed frontmatter', async () => {
    await writeFile(
      join(tempProject, '.claude', 'agents', 'bad.md'),
      'not frontmatter, just text\n',
      'utf8'
    );
    await expect(loadAgentFile('bad', tempProject)).rejects.toThrow(/frontmatter/i);
  });
});
