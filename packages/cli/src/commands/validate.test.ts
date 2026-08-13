import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const mockDiscoverWorkflowsWithConfig = mock(() => Promise.resolve({ workflows: [], errors: [] }));

mock.module('@archon/workflows/workflow-discovery', () => ({
  discoverWorkflowsWithConfig: mockDiscoverWorkflowsWithConfig,
}));

const mockLoadRepoConfig = mock(() => Promise.resolve(null));
const mockLoadConfig = mock(() =>
  Promise.resolve({
    assistant: 'claude',
    aliases: {},
    tiers: {},
    assistants: { claude: {} },
    envVars: undefined as Record<string, string> | undefined,
  })
);

mock.module('@archon/core', () => ({
  loadConfig: mockLoadConfig,
  loadRepoConfig: mockLoadRepoConfig,
}));

import { validateWorkflowsCommand } from './validate';

describe('validateWorkflowsCommand', () => {
  const originalLog = console.log;
  const originalError = console.error;
  const mockConsoleLog = mock(() => {});
  const mockConsoleError = mock(() => {});
  let validationCwd: string;

  beforeEach(async () => {
    validationCwd = await mkdtemp(join(tmpdir(), 'archon-cli-validate-'));
    mockDiscoverWorkflowsWithConfig.mockClear();
    mockLoadRepoConfig.mockClear();
    mockLoadConfig.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    console.log = mockConsoleLog;
    console.error = mockConsoleError;
    mockLoadRepoConfig.mockResolvedValue(null);
    mockLoadConfig.mockResolvedValue({
      assistant: 'claude',
      aliases: {},
      tiers: {},
      assistants: { claude: {} },
      envVars: undefined,
    });
  });

  test('passes effective Claude config dir and user setting source into resource validation', async () => {
    const configDir = join(validationCwd, 'custom-claude');
    const skillDir = join(configDir, 'skills', 'custom-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# custom\n');
    mockLoadConfig.mockResolvedValue({
      assistant: 'claude',
      aliases: {},
      tiers: {},
      assistants: { claude: { settingSources: ['user'] } },
      envVars: { CLAUDE_CONFIG_DIR: configDir },
    });
    mockDiscoverWorkflowsWithConfig.mockResolvedValue({
      workflows: [
        {
          source: 'project',
          workflow: {
            name: 'custom-skill-workflow',
            provider: 'claude',
            nodes: [{ id: 'step1', prompt: 'hello', skills: ['custom-skill'] }],
          },
        },
      ],
      errors: [],
    });

    const exitCode = await validateWorkflowsCommand(validationCwd);

    expect(exitCode).toBe(0);
    expect(JSON.stringify(mockConsoleLog.mock.calls)).toContain('1 valid, 0 with errors');
  });

  test('passes project-only Claude setting source so a custom user skill is rejected', async () => {
    const configDir = join(validationCwd, 'custom-claude');
    const skillDir = join(configDir, 'skills', 'user-only');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# user only\n');
    mockLoadConfig.mockResolvedValue({
      assistant: 'claude',
      aliases: {},
      tiers: {},
      assistants: { claude: { settingSources: ['project'] } },
      envVars: { CLAUDE_CONFIG_DIR: configDir },
    });
    mockDiscoverWorkflowsWithConfig.mockResolvedValue({
      workflows: [
        {
          source: 'project',
          workflow: {
            name: 'excluded-user-skill',
            provider: 'claude',
            nodes: [{ id: 'step1', prompt: 'hello', skills: ['user-only'] }],
          },
        },
      ],
      errors: [],
    });

    const exitCode = await validateWorkflowsCommand(validationCwd);

    expect(exitCode).toBe(1);
    expect(JSON.stringify(mockConsoleLog.mock.calls)).toContain(
      "Claude skill 'user-only' not found"
    );
  });

  test('rejects bundled @custom model refs via discovered source', async () => {
    mockDiscoverWorkflowsWithConfig.mockResolvedValueOnce({
      workflows: [
        {
          source: 'bundled',
          workflow: {
            name: 'bad-bundled',
            model: '@custom',
            nodes: [{ id: 'step1', prompt: 'hello' }],
          },
        },
      ],
      errors: [],
    });

    const exitCode = await validateWorkflowsCommand('/tmp/repo');

    expect(exitCode).toBe(1);
    expect(JSON.stringify(mockConsoleLog.mock.calls)).toContain('@custom');
  });

  afterEach(async () => {
    console.log = originalLog;
    console.error = originalError;
    await rm(validationCwd, { recursive: true, force: true });
  });
});
