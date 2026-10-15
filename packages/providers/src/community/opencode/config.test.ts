import { describe, expect, test } from 'bun:test';
import { InvalidProviderRunConfigError } from '@archon/provider-contract';

import { parseOpencodeConfig, parseOpencodeConfigStrict } from './config';

const model = 'anthropic/claude-3-5-sonnet';

function strictFieldPath(raw: Record<string, unknown>): string | undefined {
  try {
    parseOpencodeConfigStrict(raw);
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidProviderRunConfigError);
    return (error as InvalidProviderRunConfigError).fieldPath;
  }
}

describe('OpenCode config: lenient and strict agree', () => {
  test('a nested opencode.agent is refused by strict and ignored by lenient', () => {
    const raw = { model, opencode: { agent: 'build' } };
    expect(strictFieldPath(raw)).toBe('opencode');
    expect(parseOpencodeConfig(raw)).toEqual(parseOpencodeConfigStrict({ model }));
  });

  test('flat agent and baseUrl are refused by strict and ignored by lenient', () => {
    expect(strictFieldPath({ model, agent: 'build' })).toBe('agent');
    expect(strictFieldPath({ model, baseUrl: 'http://localhost:4096' })).toBe('baseUrl');
    expect(
      parseOpencodeConfig({ model, agent: 'build', baseUrl: 'http://localhost:4096' })
    ).toEqual(parseOpencodeConfigStrict({ model }));
  });
});
