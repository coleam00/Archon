import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { terminateTree } from '@archon/paths/plugin-process';
import { descriptor } from '@archon/providers/codex/descriptor';
import { ProcessAgentProvider } from './process-provider';

function pids(directory: string): number[] {
  const path = join(directory, 'pids');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map(Number) : [];
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function expectStopped(directory: string): Promise<void> {
  const recorded = pids(directory);
  expect(recorded.length).toBeGreaterThan(0);
  for (let i = 0; i < 100 && recorded.some(alive); i++) await Bun.sleep(10);
  expect(recorded.filter(alive)).toEqual([]);
}

const modes = ['credential', 'query', 'split', 'complete'] as const;
const env = {
  CODEX_BIN_PATH: process.execPath,
  CODEX_API_KEY: '',
  ARCHON_CODEX_CHATGPT_ACCESS_TOKEN: '',
  ARCHON_CODEX_CHATGPT_ACCOUNT_ID: '',
};

async function cancelCredential(
  provider: ProcessAgentProvider,
  directory: string,
  abort: AbortController
): Promise<void> {
  const pending = provider.checkCredential({ env, signal: abort.signal }).catch(error => error);
  for (let i = 0; i < 300 && pids(directory).length === 0; i++) await Bun.sleep(10);
  expect(pids(directory)).toHaveLength(2);
  expect(pids(directory).every(alive)).toBe(true);
  abort.abort(new Error('cancel native initialization'));
  expect(await pending).toBeInstanceOf(Error);
}

async function endQuery(
  provider: ProcessAgentProvider,
  directory: string,
  mode: Exclude<(typeof modes)[number], 'credential'>,
  signal: AbortSignal
): Promise<void> {
  const turn = provider.sendQuery('test', directory, undefined, {
    env,
    abortSignal: signal,
    ...(mode === 'split'
      ? {
          assistantConfig: { model: 'fixture', toolFreeStructuredOutputModels: ['fixture'] },
          outputFormat: { type: 'json_schema', schema: { type: 'object', properties: {} } },
        }
      : {}),
  });
  const types: string[] = [];
  for await (const chunk of turn) {
    types.push(chunk.type);
    if (
      mode !== 'complete' &&
      chunk.type === 'agent_message_chunk' &&
      chunk.text === `ready-${mode === 'split' ? '2' : '1'}`
    )
      break;
  }
  expect(pids(directory)).toHaveLength(mode === 'split' ? 4 : 2);
  expect(types).toContain('agent_message_chunk');
  expect(types.includes('settled')).toBe(mode === 'complete');
}

async function cleanup(directory: string): Promise<void> {
  const plugin = join(directory, 'plugin');
  const recorded = pids(directory);
  if (existsSync(plugin)) {
    const pid = Number(readFileSync(plugin, 'utf8'));
    if (alive(pid) || recorded.some(alive)) await terminateTree(pid);
  }
  // Also clean detached native groups if the ownership regression returns.
  for (let i = 0; i < recorded.length; i += 2) {
    if (recorded.slice(i, i + 2).some(alive)) await terminateTree(recorded[i]);
  }
  for (const pid of recorded) if (alive(pid)) process.kill(pid, 'SIGKILL');
  await removeTempTree(directory);
}

test.skipIf(process.platform === 'win32').each([...modes])(
  'the process host owns Codex native children through %s disposal',
  async mode => {
    const directory = mkdtempSync(join(tmpdir(), 'archon-codex-process-'));
    const abort = new AbortController();
    const provider = new ProcessAgentProvider(
      descriptor,
      [
        process.execPath,
        join(import.meta.dir, 'fixtures/codex-process.ts'),
        'plugin',
        mode,
        directory,
      ],
      'source'
    );
    try {
      if (mode === 'credential') await cancelCredential(provider, directory, abort);
      else await endQuery(provider, directory, mode, abort.signal);
      await expectStopped(directory);
    } finally {
      abort.abort();
      await cleanup(directory);
    }
  },
  10_000
);
