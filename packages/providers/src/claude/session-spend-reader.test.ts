import { expect, test, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import * as os from 'node:os';
import { dirname, join } from 'node:path';
import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { trackTempRoots } from '@archon/paths/test-utils';
import { buildDockerExecTranscriptReadArgs } from './container-spawn';
import { parseSessionSpend, readSessionSpendBaseline } from './session-spend-reader';

const track = trackTempRoots();
const sessionId = '15a9997d-9290-4413-b04b-fe34df088586';
// Captured from a real SDK error_max_turns turn; error and graceful abort durability
// were checked on this version. An upgrade must recapture this private SDK format.
const fixture = readFileSync(
  join(import.meta.dir, 'fixtures/cost-state.sdk-0.3.289.jsonl'),
  'utf8'
);
const record = JSON.parse(fixture) as Record<string, unknown>;
const known = {
  kind: 'known' as const,
  spend: {
    costUsd: 0.01558,
    modelUsage: { 'claude-haiku-4-5-20251001': { outputTokens: 280 } },
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
    '0.3.289'
  );
  expect(parseSessionSpend(fixture, sessionId)).toEqual(known);
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
    spend: { costUsd: 0.01558, modelUsage: {} },
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

test.skipIf(process.platform === 'win32')(
  'container shell reads a unique native transcript and rejects missing/duplicate files',
  () => {
    const { root } = tree();
    const args = buildDockerExecTranscriptReadArgs(
      { kind: 'container', containerId: 'container' },
      '/work',
      {},
      sessionId
    );
    const shellArgs = args.slice(args.indexOf('sh') + 1);
    const run = (configRoot: string) =>
      execFileSync('sh', shellArgs, {
        env: { ...process.env, CLAUDE_CONFIG_DIR: configRoot },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    expect(parseSessionSpend(run(root), sessionId)).toEqual(known);
    expect(() => run(join(root, 'missing'))).toThrow();
    mkdirSync(join(root, 'projects', 'duplicate'));
    writeFileSync(join(root, 'projects', 'duplicate', sessionId + '.jsonl'), fixture);
    expect(() => run(root)).toThrow();
  }
);

test('a relative request config directory is resolved where the SDK process runs', async () => {
  const { root } = tree();
  expect(
    await readSessionSpendBaseline(sessionId, {
      cwd: root,
      env: { CLAUDE_CONFIG_DIR: '.' },
    })
  ).toEqual(known);
});
