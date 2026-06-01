import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import type { MessageChunk } from '../../types';

import { KiroProvider } from './provider';

async function collect(chunks: AsyncGenerator<MessageChunk>): Promise<MessageChunk[]> {
  const result: MessageChunk[] = [];
  for await (const chunk of chunks) result.push(chunk);
  return result;
}

function makeFakeCli(): { cwd: string; bin: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'archon-kiro-provider-'));
  const bin = join(cwd, 'fake-kiro');
  writeFileSync(
    bin,
    `#!/usr/bin/env bun
console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
`,
    'utf8'
  );
  chmodSync(bin, 0o755);
  return { cwd, bin };
}

describe('KiroProvider', () => {
  test('runs kiro-cli chat in non-interactive arg-prompt mode', async () => {
    const { cwd, bin } = makeFakeCli();
    const provider = new KiroProvider();
    const chunks = await collect(
      provider.sendQuery('hello kiro', cwd, 'session-123', {
        assistantConfig: {
          binaryPath: bin,
          model: 'auto',
          agent: 'architect',
          trustTools: ['fs_read', 'fs_write'],
          requireMcpStartup: true,
          additionalArgs: ['--verbose'],
        },
      })
    );

    const assistant = chunks.find(c => c.type === 'assistant');
    expect(assistant?.content).toContain('"hello kiro"');
    const payload = JSON.parse(assistant?.content ?? '{}') as { args: string[]; cwd: string };
    expect(payload.cwd).toBe(cwd);
    expect(payload.args).toEqual([
      'chat',
      '--no-interactive',
      '--wrap',
      'never',
      '--resume-id',
      'session-123',
      '--model',
      'auto',
      '--agent',
      'architect',
      '--trust-tools=fs_read,fs_write',
      '--require-mcp-startup',
      '--verbose',
      'hello kiro',
    ]);
    expect(chunks[chunks.length - 1]).toMatchObject({ type: 'result' });
  });
});
