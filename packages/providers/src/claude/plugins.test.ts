import { describe, test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { removeTempTree } from '@archon/paths/test-utils';
import { ClassifiedProviderError } from '../shared/failure';
import {
  buildPluginListCommand,
  readClaudePluginInventory,
  resolveBundledClaudeBinary,
  withPluginScopeCheck,
} from './plugins';

/** A command that prints `stdout` and exits with `code`, standing in for the CLI. */
function fakeCli(
  stdout: string,
  code = 0,
  stderr = ''
): Parameters<typeof readClaudePluginInventory>[0] {
  return {
    command: 'sh',
    args: ['-c', 'printf "%s" "$OUT"; printf "%s" "$ERR" >&2; exit "$CODE"'],
    cwd: tmpdir(),
    env: { ...process.env, OUT: stdout, ERR: stderr, CODE: String(code) },
  };
}

async function failureOf(promise: Promise<unknown>): Promise<ClassifiedProviderError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ClassifiedProviderError) return error;
    throw error;
  }
  throw new Error('expected a ClassifiedProviderError');
}

describe('readClaudePluginInventory', () => {
  test('returns each installed id once, ignoring fields Archon does not read', async () => {
    // Cut down from a real `claude plugin list --json` (2.1.282): one record per
    // install scope, so an id can repeat.
    const listed = JSON.stringify([
      { id: 'logfire@pydantic-skills', scope: 'user', enabled: true, mcpServers: {} },
      { id: 'plugin-dev@claude-code-plugins', scope: 'local', enabled: false, projectPath: '/x' },
      { id: 'plugin-dev@claude-code-plugins', scope: 'project', enabled: true },
    ]);

    expect(await readClaudePluginInventory(fakeCli(listed))).toEqual({
      installed: ['logfire@pydantic-skills', 'plugin-dev@claude-code-plugins'],
      managed: [],
    });
  });

  test('reports the ids installed at Managed scope, which the node cannot turn off', async () => {
    // Shape from a real `claude plugin list --json` (2.1.331) on a machine whose
    // organization enforces a plugin through managed settings.
    const listed = JSON.stringify([
      { id: 'policy-plugin@org-marketplace', scope: 'managed', enabled: true },
      { id: 'policy-plugin@org-marketplace', scope: 'user', enabled: false },
      { id: 'posthog@official', scope: 'user', enabled: true },
    ]);

    expect(await readClaudePluginInventory(fakeCli(listed))).toEqual({
      installed: ['policy-plugin@org-marketplace', 'posthog@official'],
      managed: ['policy-plugin@org-marketplace'],
    });
  });

  test('a failing command is misconfigured and carries its stderr', async () => {
    const error = await failureOf(readClaudePluginInventory(fakeCli('', 3, 'config unreadable')));
    expect(error.failureClass).toBe('misconfigured');
    expect(error.message).toContain('config unreadable');
  });

  test.each([
    // Windows has no signals: a killed child there reports an exit code, not a signal.
    ...(process.platform === 'win32' ? [] : [['killed by a signal', 'kill -TERM $$']]),
    ['reporting a signal as exit status 128+N', 'exit 143'],
  ])('a listing %s is transient', async (_, script) => {
    const cmd = { ...fakeCli(''), args: ['-c', script] };
    expect((await failureOf(readClaudePluginInventory(cmd))).failureClass).toBe('transient');
  });

  test('a failure without stderr does not echo the command line, which can hold credentials', async () => {
    const cmd = {
      ...fakeCli('', 3),
      args: [...fakeCli('', 3).args, 'sh', '-e', 'TOKEN=sk-secret'],
    };
    const error = await failureOf(readClaudePluginInventory(cmd));
    expect(error.message).toContain('exited with code 3');
    expect(error.message).not.toContain('sk-secret');
  });

  test('output that is not the expected JSON is misconfigured', async () => {
    expect((await failureOf(readClaudePluginInventory(fakeCli('not json')))).failureClass).toBe(
      'misconfigured'
    );
    expect(
      (await failureOf(readClaudePluginInventory(fakeCli('[{"name":"x"}]')))).failureClass
    ).toBe('misconfigured');
  });
});

describe('buildPluginListCommand', () => {
  test('a container run asks the in-container claude with the session env', () => {
    const cmd = buildPluginListCommand({
      cliPath: undefined,
      cwd: '/workspace',
      env: { CLAUDE_CONFIG_DIR: '/home/app/.claude' },
      execContext: { kind: 'container', containerId: 'c1', execUser: 'app' },
    });
    expect(cmd.command).toBe('docker');
    // The cwd goes to `docker exec -w`; the host spawn must not use the container path.
    expect(cmd.cwd).toBeUndefined();
    expect(cmd.args).toEqual([
      'exec',
      '-i',
      '-u',
      'app',
      '-w',
      '/workspace',
      '-e',
      'CLAUDE_CONFIG_DIR=/home/app/.claude',
      'c1',
      'claude',
      'plugin',
      'list',
      '--json',
    ]);
  });

  test('a host run uses the pinned binary', () => {
    const cmd = buildPluginListCommand({
      cliPath: '/opt/claude',
      cwd: '/repo',
      env: {},
      execContext: undefined,
    });
    expect(cmd).toEqual({
      command: '/opt/claude',
      args: ['plugin', 'list', '--json'],
      cwd: '/repo',
      env: {},
    });
  });
});

// Runs the SDK's bundled CLI, at zero spend, in an empty config dir: proves the
// dev-mode binary lookup still finds it and the CLI's JSON still parses, so an
// SDK bump that changes either fails here instead of failing every workflow node.
describe('real bundled Claude CLI', () => {
  test('lists plugins as JSON Archon can parse', async () => {
    expect(resolveBundledClaudeBinary()).toBeDefined();
    const configDir = mkdtempSync(join(tmpdir(), 'archon-plugin-list-'));
    try {
      const inventory = await readClaudePluginInventory(
        buildPluginListCommand({
          cliPath: undefined,
          cwd: configDir,
          env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
          execContext: undefined,
        })
      );
      expect(inventory).toEqual({ installed: [], managed: [] });
    } finally {
      await removeTempTree(configDir);
    }
  });
});

describe('withPluginScopeCheck', () => {
  function init(plugins: unknown[]): SDKMessage {
    return { type: 'system', subtype: 'init', plugins } as unknown as SDKMessage;
  }

  async function drain(
    events: SDKMessage[],
    named: string[],
    managed: string[] = []
  ): Promise<SDKMessage[]> {
    const seen: SDKMessage[] = [];
    async function* source(): AsyncGenerator<SDKMessage> {
      yield* events;
    }
    for await (const event of withPluginScopeCheck(source(), { named, managed })) seen.push(event);
    return seen;
  }

  test('builtins plus the named plugins pass through untouched', async () => {
    const events = [
      init([
        { name: 'agents-md', path: 'builtin', source: 'agents-md@builtin' },
        { name: 'posthog', path: '/p', source: 'posthog@official' },
      ]),
    ];
    expect(await drain(events, ['posthog@official'])).toEqual(events);
  });

  test('a Managed-scope plugin the node does not name passes, like a builtin', async () => {
    const events = [
      init([
        { name: 'agents-md', path: 'builtin', source: 'agents-md@builtin' },
        { name: 'policy-plugin', path: '/m', source: 'policy-plugin@org-marketplace' },
      ]),
    ];
    expect(await drain(events, [], ['policy-plugin@org-marketplace'])).toEqual(events);
  });

  test('a Managed-scope plugin that did not load is not required', async () => {
    const events = [init([{ name: 'agents-md', source: 'agents-md@builtin' }])];
    expect(await drain(events, [], ['policy-plugin@org-marketplace'])).toEqual(events);
  });

  test('a Managed-scope id does not admit the same plugin from another marketplace', async () => {
    const error = await failureOf(
      drain(
        [init([{ name: 'policy-plugin', source: 'policy-plugin@fork' }])],
        [],
        ['policy-plugin@org-marketplace']
      )
    );
    expect(error.message).toContain('policy-plugin@fork');
  });

  test('a named plugin that did not load fails', async () => {
    const error = await failureOf(
      drain([init([{ name: 'agents-md', source: 'agents-md@builtin' }])], ['posthog@official'])
    );
    expect(error.failureClass).toBe('misconfigured');
    expect(error.message).toContain('named plugins did not load: posthog@official');
  });

  test('a result before any init frame fails instead of skipping the check', async () => {
    const result = { type: 'result', subtype: 'success', is_error: false } as unknown as SDKMessage;
    const error = await failureOf(drain([result], []));
    expect(error.failureClass).toBe('misconfigured');
    expect(error.message).toContain('before reporting its loaded plugins');
  });

  test.each(['assistant', 'stream_event'])('%s before any init frame fails', async type => {
    const error = await failureOf(drain([{ type } as unknown as SDKMessage], []));
    expect(error.failureClass).toBe('misconfigured');
    expect(error.message).toContain(`sent a ${type} message before`);
  });

  test('an error result before init passes through with its own cause', async () => {
    const result = {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['No conversation found with session ID: s-1'],
    } as unknown as SDKMessage;
    expect(await drain([result], [])).toEqual([result]);
  });

  test('a hook frame ahead of init passes through', async () => {
    const hook = { type: 'system', subtype: 'hook_started' } as unknown as SDKMessage;
    const events = [hook, init([{ name: 'agents-md', source: 'agents-md@builtin' }])];
    expect(await drain(events, [])).toEqual(events);
  });

  test('a plugin row without its id fails closed', async () => {
    const error = await failureOf(drain([init([{ name: 'mystery', path: '/m' }])], []));
    expect(error.message).toContain('mystery (no source id)');
  });

  test('a plugin with the same name from another marketplace is not the named one', async () => {
    const error = await failureOf(
      drain([init([{ name: 'posthog', source: 'posthog@fork' }])], ['posthog@official'])
    );
    expect(error.message).toContain('posthog@fork');
  });
});
