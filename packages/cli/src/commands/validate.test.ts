import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { makeTestWorkflowWithSource } from '@archon/workflows/test-utils';

const mockDiscoverWorkflowsWithConfig = mock<typeof discoverWorkflowsWithConfig>(() =>
  Promise.resolve({ workflows: [], errors: [] })
);

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
        makeTestWorkflowWithSource(
          {
            name: 'custom-skill-workflow',
            provider: 'claude',
            nodes: [{ id: 'step1', prompt: 'hello', skills: ['custom-skill'] }],
          },
          'project'
        ),
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
        makeTestWorkflowWithSource(
          {
            name: 'excluded-user-skill',
            provider: 'claude',
            nodes: [{ id: 'step1', prompt: 'hello', skills: ['user-only'] }],
          },
          'project'
        ),
      ],
      errors: [],
    });

    const exitCode = await validateWorkflowsCommand(validationCwd);

    expect(exitCode).toBe(1);
    expect(JSON.stringify(mockConsoleLog.mock.calls)).toContain(
      "Claude skill 'user-only' not found"
    );
  });

  test('loose output schema warns and exits successfully', async () => {
    mockDiscoverWorkflowsWithConfig.mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource(
          {
            name: 'loose-output',
            provider: 'claude',
            nodes: [
              {
                id: 'classify',
                prompt: 'decide',
                output_format: {
                  type: 'object',
                  properties: { verdict: { type: 'string', enum: ['review', 'skip'] } },
                },
              },
            ],
          },
          'project'
        ),
      ],
      errors: [],
    });

    expect(await validateWorkflowsCommand(validationCwd)).toBe(0);
    const output = JSON.stringify(mockConsoleLog.mock.calls);
    expect(output).toContain("Node 'classify'");
    expect(output).toContain('required');
    expect(output).toContain('additionalProperties: false');
    expect(output).toContain('1 valid, 0 with errors');
  });

  test('renders conditional-join load warnings and exits successfully', async () => {
    const warning =
      "Node 'join': 'none_failed_min_one_success' requires at least one successful dependency, but every dependency has a 'when'. Use 'all_done'.";
    mockDiscoverWorkflowsWithConfig.mockResolvedValueOnce({
      workflows: [
        {
          ...makeTestWorkflowWithSource(
            {
              name: 'conditional-join',
              nodes: [{ id: 'join', bash: 'echo joined' }],
            },
            'project'
          ),
          parseWarnings: [warning],
        },
      ],
      errors: [],
    });

    expect(await validateWorkflowsCommand(validationCwd)).toBe(0);
    const output = JSON.stringify(mockConsoleLog.mock.calls);
    expect(output).toContain(warning);
    expect(output).toContain('WARNINGS');
    expect(output).toContain('WARNING');
    expect(output).toContain('1 valid, 0 with errors, 1 with warnings');
  });

  test('rejects bundled @custom model refs via discovered source', async () => {
    mockDiscoverWorkflowsWithConfig.mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource(
          {
            name: 'bad-bundled',
            model: '@custom',
            nodes: [{ id: 'step1', prompt: 'hello' }],
          },
          'bundled'
        ),
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
