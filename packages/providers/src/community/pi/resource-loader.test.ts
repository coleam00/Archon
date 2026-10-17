import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'bun:test';

import {
  getOrCreateReloadedExtensionLoader,
  resetReloadedExtensionLoaderCache,
} from './resource-loader';

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let scratchDir: string | undefined;

afterEach(() => {
  resetReloadedExtensionLoaderCache();
  if (originalAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
  if (scratchDir) {
    rmSync(scratchDir, { recursive: true, force: true });
    scratchDir = undefined;
  }
});

test("loads native guidance and only the workflow node's declared skill", async () => {
  scratchDir = mkdtempSync(join(tmpdir(), 'archon-pi-context-'));
  const agentDir = join(scratchDir, 'agent');
  const projectRoot = join(scratchDir, 'project');
  const cwd = join(projectRoot, 'nested');
  const globalContextPath = join(agentDir, 'AGENTS.md');
  const projectContextPath = join(projectRoot, 'CLAUDE.md');
  const ambientSkillPath = join(agentDir, 'skills', 'ambient-skill');
  const declaredSkillPath = join(scratchDir, 'declared-skill');

  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(globalContextPath, '# User rules\n');
  writeFileSync(projectContextPath, '# Project rules\n');
  mkdirSync(ambientSkillPath, { recursive: true });
  mkdirSync(declaredSkillPath, { recursive: true });
  writeFileSync(
    join(ambientSkillPath, 'SKILL.md'),
    '---\nname: ambient-skill\ndescription: must stay hidden\n---\n'
  );
  writeFileSync(
    join(declaredSkillPath, 'SKILL.md'),
    '---\nname: declared-skill\ndescription: selected by the node\n---\n'
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const { loader } = await getOrCreateReloadedExtensionLoader(cwd, {
    additionalSkillPaths: [declaredSkillPath],
  });

  expect(loader.getAgentsFiles().agentsFiles).toEqual(
    expect.arrayContaining([
      { path: globalContextPath, content: '# User rules\n' },
      { path: projectContextPath, content: '# Project rules\n' },
    ])
  );
  expect(loader.getSkills().skills.map(skill => skill.name)).toEqual(['declared-skill']);
});

// An extension factory that never settles wedges the one shared reload (issue #3769).
// The watchdog abort must end the caller's wait without touching the shared reload.
test('an abort ends the wait on a pending extension reload', async () => {
  scratchDir = mkdtempSync(join(tmpdir(), 'archon-pi-hung-'));
  const agentDir = join(scratchDir, 'agent');
  const cwd = join(scratchDir, 'project');
  mkdirSync(join(agentDir, 'extensions'), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(agentDir, 'extensions', 'hang.ts'),
    'export default async function () { await new Promise(() => {}); }\n'
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const watchdog = new AbortController();
  const attempt = getOrCreateReloadedExtensionLoader(cwd, {}, watchdog.signal);
  await new Promise(resolve => setTimeout(resolve, 50));
  watchdog.abort();
  await expect(attempt).rejects.toThrow('Query aborted');
});
