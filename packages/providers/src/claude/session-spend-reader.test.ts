import { expect, test, spyOn } from 'bun:test';
import * as childProcess from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import * as os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { trackTempRoots } from '@archon/paths/test-utils';
import { buildDockerExecTranscriptReadArgs } from './container-spawn';
import { parseSessionSpend, readSessionSpendBaseline } from './session-spend-reader';

const track = trackTempRoots();
const sessionId = '55a9a375-ec0a-40b3-a92d-177efa7a763b';
// Captured from a real SDK error_max_turns turn; error and graceful abort durability
// were checked on this version. An upgrade must recapture this private SDK format.
const capturedSdkVersion = '0.3.302';
const fixture = readFileSync(
  join(import.meta.dir, `fixtures/cost-state.sdk-${capturedSdkVersion}.jsonl`),
  'utf8'
);
const record = JSON.parse(fixture) as Record<string, unknown>;
const known = {
  kind: 'known' as const,
  spend: {
    costUsd: 0.0024422000000000003,
    modelUsage: {
      'claude-haiku-5-5': {
        inputTokens: 1193,
        outputTokens: 17,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      'claude-haiku-4-5': {
        inputTokens: 10,
        outputTokens: 142,
        cacheReadInputTokens: 15944,
        cacheCreationInputTokens: 0,
      },
    },
  },
};
function tree(): { root: string; path: string } {
  const root = track(mkdtempSync(join(tmpdir(), 'claude-cost-state-')));
  const project = join(root, 'projects', 'custom-slug');
  mkdirSync(project, { recursive: true });
  const path = join(project, sessionId + '.jsonl');
  writeFileSync(path, fixture);
  return { root, path };
}
function read(root: string, id = sessionId) {
  return readSessionSpendBaseline(id, { cwd: tmpdir(), env: { CLAUDE_CONFIG_DIR: root } });
}

test('real cost-state fixture conforms to the installed SDK version', () => {
  const sdk = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
  expect(JSON.parse(readFileSync(join(dirname(sdk), 'package.json'), 'utf8')).version).toBe(
    capturedSdkVersion
  );
  expect(parseSessionSpend(fixture, sessionId)).toEqual(known);
});

test('old output-only records remain usable for cost and model selection', () => {
  expect(
    parseSessionSpend(
      JSON.stringify({ ...record, modelUsage: { main: { outputTokens: 280 } } }),
      sessionId
    )
  ).toEqual({
    kind: 'known',
    spend: { costUsd: 0.0024422000000000003, modelUsage: { main: { outputTokens: 280 } } },
  });
});

test('only the final cost record counts, with unrelated trailing events allowed', () => {
  expect(
    parseSessionSpend(
      JSON.stringify({ ...record, totalCostUSD: 0 }) + '\n' + fixture + '{"type":"system"}\n',
      sessionId
    )
  ).toEqual(known);
  expect(
    parseSessionSpend(fixture + JSON.stringify({ ...record, totalCostUSD: 'bad' }), sessionId)
  ).toEqual({ kind: 'unknown' });
  expect(parseSessionSpend(fixture + '{"type":"cost-state"', sessionId)).toEqual({
    kind: 'unknown',
  });
});

test.each([
  { totalCostUSD: undefined },
  { totalCostUSD: '0.1' },
  { totalCostUSD: -1 },
  { totalCostUSD: Infinity },
  { modelUsage: undefined },
  { modelUsage: { model: {} } },
  { modelUsage: { model: { outputTokens: '1' } } },
  { modelUsage: { model: { outputTokens: -1 } } },
  { modelUsage: { model: { outputTokens: 1.5 } } },
  { hasUnknownModelCost: true },
  { sessionId: 'other' },
])('unusable native record leaves cost unknown: %j', patch => {
  expect(parseSessionSpend(JSON.stringify({ ...record, ...patch }), sessionId)).toEqual({
    kind: 'unknown',
  });
});

test('an empty model record is valid, while a missing cost record is unknown', () => {
  expect(parseSessionSpend(JSON.stringify({ ...record, modelUsage: {} }), sessionId)).toEqual({
    kind: 'known',
    spend: { costUsd: 0.0024422000000000003, modelUsage: {} },
  });
  expect(parseSessionSpend('{"type":"user"}\n', sessionId)).toEqual({ kind: 'unknown' });
});

test('request config lookup agrees with SDK getSessionInfo for an arbitrary project slug', async () => {
  const { root, path } = tree();
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  try {
    writeFileSync(
      path,
      JSON.stringify({
        type: 'user',
        sessionId,
        uuid: 'test-message',
        cwd: tmpdir(),
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'fixture' },
      }) +
        '\n' +
        fixture
    );
    expect((await getSessionInfo(sessionId))?.sessionId).toBe(sessionId);
    expect(await read(root)).toEqual(known);
    process.env.CLAUDE_CONFIG_DIR = join(root, 'ambient-canary');
    expect(await read(root)).toEqual(known);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

test('missing, ambiguous, damaged, and invalid-id lookups remain unknown', async () => {
  const { root, path } = tree();
  expect(await read(root, '20000000-0000-4000-8000-000000000001')).toEqual({ kind: 'unknown' });
  expect(await read(root, '../escape')).toEqual({ kind: 'unknown' });
  writeFileSync(path, 'broken');
  expect(await read(root)).toEqual({ kind: 'unknown' });
  writeFileSync(path, fixture);
  expect(await read(root)).toEqual(known);
  mkdirSync(join(root, 'projects', 'duplicate'));
  writeFileSync(join(root, 'projects', 'duplicate', sessionId + '.jsonl'), fixture);
  expect(await read(root)).toEqual({ kind: 'unknown' });
  expect(await read(join(root, 'missing'))).toEqual({ kind: 'unknown' });
});

test('container reader uses the session user/env and passes the UUID as an argument', () => {
  const { root } = tree();
  const args = buildDockerExecTranscriptReadArgs(
    { kind: 'container', containerId: 'container', execUser: 'operator' },
    '/work',
    { CLAUDE_CONFIG_DIR: root, HOME: '/host', PATH: '/host/bin' },
    sessionId
  );
  expect(args.slice(0, 6)).toEqual(['exec', '-i', '-u', 'operator', '-w', '/work']);
  expect(args).toContain('CLAUDE_CONFIG_DIR=' + root);
  expect(args).not.toContain('HOME=/host');
  expect(args).not.toContain('PATH=/host/bin');
});

test('cancellation prevents transcript lookup and query startup', async () => {
  const signal = AbortSignal.abort();
  await expect(
    readSessionSpendBaseline(sessionId, {
      cwd: tmpdir(),
      env: {},
      execContext: { kind: 'container', containerId: 'unused' },
      signal,
    })
  ).rejects.toThrow();
  expect(await readSessionSpendBaseline(undefined, { cwd: tmpdir(), env: {} })).toEqual({
    kind: 'fresh',
  });
});

test('native default config root uses the home directory', async () => {
  const home = track(mkdtempSync(join(tmpdir(), 'claude-default-home-')));
  const project = join(home, '.claude', 'projects', 'arbitrary');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, sessionId + '.jsonl'), fixture);
  const homedir = spyOn(os, 'homedir').mockReturnValue(home);
  try {
    expect(await readSessionSpendBaseline(sessionId, { cwd: tmpdir(), env: {} })).toEqual(known);
  } finally {
    homedir.mockRestore();
  }
});

// Host and container locators cannot share filesystem code; this matrix binds their
// native-path and ambiguity rules while executing the production container branch.
test.skipIf(process.platform === 'win32').each([
  { name: 'default', config: undefined, known: true },
  { name: 'empty', config: '', known: true },
  { name: 'relative', config: 'relative', known: true },
  { name: 'absolute', config: 'absolute', known: true },
  { name: 'NFC', config: 'cafe\u0301', known: true },
  { name: 'missing', config: 'missing', known: false },
  { name: 'duplicate', config: 'duplicate', known: false },
])('host/container native locator conformance: $name', async scenario => {
  const cwd = track(mkdtempSync(join(tmpdir(), 'claude-locator-')));
  const home = join(cwd, 'home');
  const config = scenario.config === 'absolute' ? join(cwd, 'absolute') : scenario.config;
  const root = config === undefined ? join(home, '.claude') : resolve(cwd, config.normalize('NFC'));
  const project = join(root, 'projects', 'arbitrary-slug');
  mkdirSync(project, { recursive: true });
  if (scenario.name !== 'missing') writeFileSync(join(project, sessionId + '.jsonl'), fixture);
  if (scenario.name === 'duplicate') {
    const duplicate = join(root, 'projects', 'second-slug');
    mkdirSync(duplicate);
    writeFileSync(join(duplicate, sessionId + '.jsonl'), fixture);
  }
  const env = { HOME: home, CLAUDE_CONFIG_DIR: config };
  const expected = scenario.known ? known : { kind: 'unknown' as const };
  expect(await readSessionSpendBaseline(sessionId, { cwd, env })).toEqual(expected);

  const runner: {
    execFile: (
      command: string,
      args: string[],
      options: childProcess.ExecFileOptionsWithStringEncoding,
      callback: (
        error: childProcess.ExecFileException | null,
        stdout: string,
        stderr: string
      ) => void
    ) => childProcess.ChildProcess;
  } = childProcess;
  const execFile = runner.execFile;
  const docker = spyOn(runner, 'execFile').mockImplementation(
    (command, args, options, callback) => {
      expect(command).toBe('docker');
      expect(args.slice(0, 6)).toEqual(['exec', '-i', '-u', 'operator', '-w', cwd]);
      const shell = args.indexOf('sh');
      expect(args[shell - 1]).toBe('cost-container');
      expect(args.at(-1)).toBe(sessionId);
      expect(args).not.toContain('HOME=' + home);
      const containerEnv: NodeJS.ProcessEnv = { HOME: home };
      for (let index = 0; index < shell; index++) {
        if (args[index] !== '-e') continue;
        const assignment = args[index + 1];
        if (assignment === undefined) throw new Error('missing docker environment value');
        const equals = assignment.indexOf('=');
        containerEnv[assignment.slice(0, equals)] = assignment.slice(equals + 1);
      }
      return execFile(
        'sh',
        args.slice(shell + 1),
        { ...options, cwd, env: containerEnv },
        callback
      );
    }
  );
  try {
    expect(
      await readSessionSpendBaseline(sessionId, {
        cwd,
        env,
        execContext: { kind: 'container', containerId: 'cost-container', execUser: 'operator' },
      })
    ).toEqual(expected);
    expect(docker).toHaveBeenCalledTimes(1);
  } finally {
    docker.mockRestore();
  }
});

test('a relative request config directory is resolved where the SDK process runs', async () => {
  const { root } = tree();
  expect(
    await readSessionSpendBaseline(sessionId, {
      cwd: root,
      env: { CLAUDE_CONFIG_DIR: '.' },
    })
  ).toEqual(known);
});
