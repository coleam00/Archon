import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveGrokBinaryPath } from './binary-resolver';

const previousBin = process.env.GROK_BIN_PATH;

afterEach(() => {
  if (previousBin === undefined) delete process.env.GROK_BIN_PATH;
  else process.env.GROK_BIN_PATH = previousBin;
});

function fakeGrok(): string {
  const dir = mkdtempSync(join(tmpdir(), 'grok-bin-'));
  const bin = join(dir, 'grok');
  writeFileSync(bin, '#!/bin/sh\n');
  chmodSync(bin, 0o755);
  return bin;
}

describe('resolveGrokBinaryPath', () => {
  test('uses GROK_BIN_PATH when executable', () => {
    const bin = fakeGrok();
    process.env.GROK_BIN_PATH = bin;
    expect(resolveGrokBinaryPath()).toBe(bin);
  });

  test('throws when GROK_BIN_PATH is not executable', () => {
    process.env.GROK_BIN_PATH = '/no/such/grok';
    expect(() => resolveGrokBinaryPath()).toThrow(/not an executable file/);
  });

  test('uses config path when env is unset', () => {
    delete process.env.GROK_BIN_PATH;
    const bin = fakeGrok();
    expect(resolveGrokBinaryPath(bin)).toBe(bin);
  });
});
