import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { clearConfigCache } from '@archon/core';
import { validateWorkflowsCommand } from './validate';

const tempDirs: string[] = [];
let consoleLogSpy: ReturnType<typeof spyOn>;
let originalArchonHome: string | undefined;
let originalDefaultAssistant: string | undefined;

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(async () => {
  originalArchonHome = process.env.ARCHON_HOME;
  originalDefaultAssistant = process.env.DEFAULT_AI_ASSISTANT;
  process.env.ARCHON_HOME = await makeTempDir('archon-cli-home-');
  delete process.env.DEFAULT_AI_ASSISTANT;
  clearConfigCache();
  consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  consoleLogSpy.mockRestore();
  if (originalArchonHome === undefined) {
    delete process.env.ARCHON_HOME;
  } else {
    process.env.ARCHON_HOME = originalArchonHome;
  }
  if (originalDefaultAssistant === undefined) {
    delete process.env.DEFAULT_AI_ASSISTANT;
  } else {
    process.env.DEFAULT_AI_ASSISTANT = originalDefaultAssistant;
  }
  clearConfigCache();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('validateWorkflowsCommand', () => {
  test('uses configured Codex skillRoots for workflows that rely on the default provider', async () => {
    const repo = await makeTempDir('archon-validate-skills-');
    const skillRoot = join(repo, 'custom-skills');
    await mkdir(join(skillRoot, 'alpha'), { recursive: true });
    await writeFile(join(skillRoot, 'alpha', 'SKILL.md'), '# Alpha\n');
    await mkdir(join(repo, '.archon', 'workflows'), { recursive: true });
    await writeFile(
      join(repo, '.archon', 'workflows', 'codex-skills.yaml'),
      `
name: codex-skills
description: test
nodes:
  - id: review
    prompt: Review
    skills: [alpha]
`
    );
    await writeFile(
      join(repo, '.archon', 'config.yaml'),
      `
assistant: codex
assistants:
  codex:
    skillRoots:
      - ${skillRoot}
defaults:
  loadDefaultCommands: false
  loadDefaultWorkflows: false
`
    );

    const exitCode = await validateWorkflowsCommand(repo, undefined, true);

    expect(exitCode).toBe(0);
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse(consoleLogSpy.mock.calls[0]?.[0] as string) as {
      summary: { errors: number };
    };
    expect(output.summary.errors).toBe(0);
  });
});
