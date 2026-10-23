import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
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

import { registerBuiltinProviders } from '@archon/providers/in-process';
import { validateCommandsCommand, validateWorkflowsCommand } from './validate';
import * as validator from '@archon/workflows/validator';
import * as stdout from '../utils/stdout';

// The CLI entrypoint registers providers before any command runs.
registerBuiltinProviders();

describe('validateWorkflowsCommand', () => {
  const originalLog = console.log;
  const originalError = console.error;
  const mockConsoleLog = mock<typeof console.log>(() => {});
  const mockConsoleError = mock<typeof console.error>(() => {});
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
      "skill 'user-only' not found in an enabled skill directory"
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
      "Node 'join': its only dependency 'gate' has a 'when', and 'none_failed_min_one_success' needs a successful dependency. Use 'all_done'.";
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

  test.each([false, true])('missing workflow output, JSON=%s', async json => {
    mockDiscoverWorkflowsWithConfig.mockResolvedValueOnce({ workflows: [], errors: [] });
    const write = spyOn(stdout, 'writeStdout').mockResolvedValue(undefined);
    try {
      expect(await validateWorkflowsCommand(validationCwd, 'missing', json)).toBe(1);
      if (json) {
        expect(write.mock.calls).toEqual([
          ['{"error":"Workflow \'missing\' not found","suggestions":[],"available":[]}\n'],
        ]);
        expect(mockConsoleError.mock.calls).toEqual([]);
      } else {
        expect(mockConsoleError.mock.calls).toEqual([
          ["Workflow 'missing' not found."],
          ['Available workflows: '],
        ]);
        expect(write.mock.calls).toEqual([]);
      }
    } finally {
      write.mockRestore();
    }
  });

  test.each([false, true])('sorted workflow results output, JSON=%s', async json => {
    mockDiscoverWorkflowsWithConfig.mockResolvedValueOnce({
      workflows: [
        {
          ...makeTestWorkflowWithSource({ name: 'alpha', nodes: [{ id: 'run', bash: 'true' }] }),
          parseWarnings: ['Check this workflow'],
        },
      ],
      errors: [{ filename: 'broken.yaml', errorType: 'parse_error', error: 'Bad YAML' }],
    });
    const write = spyOn(stdout, 'writeStdout').mockResolvedValue(undefined);
    try {
      expect(await validateWorkflowsCommand(validationCwd, undefined, json)).toBe(1);
      if (json) {
        expect(write.mock.calls).toEqual([
          [
            `${JSON.stringify({
              results: [
                {
                  workflowName: 'broken',
                  filename: 'broken.yaml',
                  valid: false,
                  issues: [{ level: 'error', field: 'parse_error', message: 'Bad YAML' }],
                },
                {
                  workflowName: 'alpha',
                  valid: true,
                  issues: [
                    { level: 'warning', field: 'parse_warning', message: 'Check this workflow' },
                  ],
                },
              ],
              summary: { total: 2, valid: 1, errors: 1, warnings: 1 },
            })}\n`,
          ],
        ]);
        expect(mockConsoleLog.mock.calls).toEqual([]);
      } else {
        expect(mockConsoleLog.mock.calls).toEqual([
          [`\nValidating workflows in ${validationCwd}\n`],
          [`  ${'broken'.padEnd(40)} ERRORS\n    ERROR [parse_error] Bad YAML`],
          [`  ${'alpha'.padEnd(40)} WARNINGS\n    WARNING [parse_warning] Check this workflow`],
          ['\nResults: 1 valid, 1 with errors, 1 with warnings'],
        ]);
        expect(write.mock.calls).toEqual([]);
      }
    } finally {
      write.mockRestore();
    }
  });

  afterEach(async () => {
    console.log = originalLog;
    console.error = originalError;
    await rm(validationCwd, { recursive: true, force: true });
  });
});

describe('validateCommandsCommand output', () => {
  let logSpy: ReturnType<typeof spyOn<typeof console, 'log'>>;
  const invalid = {
    commandName: 'broken',
    valid: false,
    issues: [{ level: 'error', field: 'content', message: 'Empty command', hint: 'Add content' }],
  } satisfies validator.CommandValidationResult;
  const script = { scriptName: 'check', valid: true, issues: [] };

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    spyOn(stdout, 'writeStdout').mockResolvedValue(undefined);
    spyOn(validator, 'validateCommand').mockResolvedValue(invalid);
    spyOn(validator, 'validateScript').mockResolvedValue(script);
    spyOn(validator, 'discoverAvailableCommands').mockResolvedValue([]);
    spyOn(validator, 'discoverAvailableScripts').mockResolvedValue([]);
  });
  afterEach(() => mock.restore());

  test.each([false, true])('single-command output, JSON=%s', async json => {
    expect(await validateCommandsCommand('/repo', 'broken', json)).toBe(1);
    if (json) {
      expect(stdout.writeStdout).toHaveBeenCalledWith(`${JSON.stringify(invalid)}\n`);
      expect(console.log).not.toHaveBeenCalled();
    } else {
      expect(mockedLogLines()).toEqual([
        `\n  ${'broken'.padEnd(40)} ERRORS`,
        '    ERROR [content] Empty command\n      Add content',
      ]);
      expect(stdout.writeStdout).not.toHaveBeenCalled();
    }
    expect(validator.discoverAvailableCommands).not.toHaveBeenCalled();
    expect(validator.discoverAvailableScripts).not.toHaveBeenCalled();
  });

  test.each([false, true])('empty inventory output, JSON=%s', async json => {
    expect(await validateCommandsCommand('/repo', undefined, json)).toBe(0);
    if (json) {
      expect(stdout.writeStdout).toHaveBeenCalledWith(
        '{"results":[],"scripts":[],"summary":{"total":0,"valid":0,"errors":0}}\n'
      );
    } else expect(mockedLogLines()).toEqual(['\nNo commands or scripts found.']);
  });

  test.each([false, true])('mixed command and script output, JSON=%s', async json => {
    spyOn(validator, 'discoverAvailableCommands').mockResolvedValue(['broken']);
    spyOn(validator, 'discoverAvailableScripts').mockResolvedValue([
      { name: 'check', path: '/repo/.archon/scripts/check.ts', runtime: 'bun' },
    ]);
    expect(await validateCommandsCommand('/repo', undefined, json)).toBe(1);
    if (json) {
      expect(stdout.writeStdout).toHaveBeenCalledWith(
        `${JSON.stringify({ results: [invalid], scripts: [script], summary: { total: 2, valid: 1, errors: 1 } })}\n`
      );
    } else {
      expect(mockedLogLines()).toEqual([
        '\nValidating commands and scripts in /repo\n',
        `  ${'broken'.padEnd(40)} ERRORS`,
        '    ERROR [content] Empty command\n      Add content',
        `  ${'[script] check'.padEnd(40)} ok`,
        '\nResults: 1 valid, 1 with errors',
      ]);
    }
  });

  function mockedLogLines(): unknown[] {
    return logSpy.mock.calls.map(args => args[0]);
  }
});
