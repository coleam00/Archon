import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrokProvider } from './provider';
import type { GrokCommandRunner } from './transport';

const SESSION = '11111111-1111-4111-8111-111111111111';
const previousBin = process.env.GROK_BIN_PATH;

function fakeGrok(): string {
  const dir = mkdtempSync(join(tmpdir(), 'grok-bin-'));
  const bin = join(dir, 'grok');
  writeFileSync(bin, '#!/bin/sh\n');
  chmodSync(bin, 0o755);
  return bin;
}

afterEach(() => {
  if (previousBin === undefined) delete process.env.GROK_BIN_PATH;
  else process.env.GROK_BIN_PATH = previousBin;
});

function withBin(): void {
  process.env.GROK_BIN_PATH = fakeGrok();
}

function runnerFromLines(lines: string[], exitCode = 0): GrokCommandRunner {
  return async input => {
    for (const line of lines) input.onLine(line);
    return { exitCode, stderr: '', nativeClosed: true };
  };
}

async function collect(provider: GrokProvider, prompt = 'hi', resume?: string) {
  const chunks = [];
  for await (const chunk of provider.sendQuery(prompt, '/tmp', resume, { model: 'grok-4.6' })) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('GrokProvider', () => {
  test('streams text, tools, and terminal result', async () => {
    withBin();
    const provider = new GrokProvider(
      runnerFromLines([
        '{"type":"text","data":"hello"}',
        '{"type":"tool_call","toolCallId":"c1","toolName":"read_file"}',
        `{"type":"end","sessionId":"${SESSION}","stopReason":"end_turn","usage":{"input_tokens":1,"output_tokens":2}}`,
      ])
    );
    const chunks = await collect(provider);
    expect(chunks).toEqual([
      { type: 'assistant', content: 'hello' },
      { type: 'tool', toolName: 'read_file', toolCallId: 'c1' },
      {
        type: 'result',
        sessionId: SESSION,
        stopReason: 'end_turn',
        tokens: { input: 1, output: 2 },
      },
    ]);
  });

  test('invalid json fails the node', async () => {
    withBin();
    const provider = new GrokProvider(runnerFromLines(['{']));
    const chunks = await collect(provider);
    expect(chunks[0]).toMatchObject({
      type: 'result',
      isError: true,
      errorSubtype: 'grok_stream_json_invalid',
    });
  });

  test('missing end synthesizes an error', async () => {
    withBin();
    const provider = new GrokProvider(runnerFromLines(['{"type":"text","data":"hi"}'], 1));
    const chunks = await collect(provider);
    expect(chunks.at(-1)).toMatchObject({
      type: 'result',
      isError: true,
      errorSubtype: 'grok_stream_incomplete',
    });
  });

  test('stamps resumed true when resume succeeds', async () => {
    withBin();
    const provider = new GrokProvider(runnerFromLines([`{"type":"end","sessionId":"${SESSION}"}`]));
    const chunks = await collect(provider, 'hi', SESSION);
    expect(chunks.at(-1)).toMatchObject({ type: 'result', sessionId: SESSION, resumed: true });
  });

  test('records argv for oauth headless spawn', async () => {
    withBin();
    let argv: readonly string[] = [];
    let env: NodeJS.ProcessEnv = {};
    const provider = new GrokProvider(async input => {
      argv = input.argv;
      env = input.env;
      input.onLine(`{"type":"end","sessionId":"${SESSION}"}`);
      return { exitCode: 0, stderr: '', nativeClosed: true };
    });
    await collect(provider);
    expect(argv).toContain('--oauth');
    expect(argv).toContain('--permission-mode');
    expect(argv).toContain('bypassPermissions');
    expect(argv).not.toContain('--yolo');
    expect(env.GROK_DISABLE_API_KEY_AUTH).toBe('1');
    expect(env.XAI_API_KEY).toBeUndefined();
  });

  test('passes systemPrompt as --rules and schema as --json-schema', async () => {
    withBin();
    let argv: readonly string[] = [];
    const provider = new GrokProvider(async input => {
      argv = input.argv;
      input.onLine(`{"type":"end","sessionId":"${SESSION}"}`);
      return { exitCode: 0, stderr: '', nativeClosed: true };
    });
    const chunks = [];
    for await (const chunk of provider.sendQuery('hi', '/tmp', undefined, {
      model: 'grok-4.6',
      systemPrompt: 'be terse',
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
    })) {
      chunks.push(chunk);
    }
    expect(argv[argv.indexOf('--rules') + 1]).toBe('be terse');
    expect(argv[argv.indexOf('--json-schema') + 1]).toBe('{"type":"object"}');
    expect(chunks.at(-1)).toMatchObject({ type: 'result', sessionId: SESSION });
  });
});
