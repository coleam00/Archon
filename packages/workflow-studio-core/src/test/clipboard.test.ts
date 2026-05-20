import { describe, it, expect } from 'bun:test';
import { serializeClipboard, parseClipboard } from '../clipboard';

const nodes = [
  { id: 'a', variant: 'bash', data: { cmd: 'echo hi' }, base: {}, unknown: {} },
  { id: 'b', variant: 'bash', data: { cmd: 'ls' }, base: {}, unknown: {} },
] as any[];

describe('serializeClipboard / parseClipboard', () => {
  it('round-trips node array', () => {
    const text = serializeClipboard(nodes);
    const result = parseClipboard(text);
    expect(result).not.toBeNull();
    expect(result!.nodes).toHaveLength(2);
    expect(result!.nodes[0].id).toBe('a');
  });

  it('rejects wrong version', () => {
    const text = JSON.stringify({ version: 'wrong', nodes: [] });
    expect(parseClipboard(text)).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseClipboard('not json')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseClipboard('')).toBeNull();
  });

  it('round-trip preserves variant and data', () => {
    const text = serializeClipboard(nodes);
    const result = parseClipboard(text)!;
    expect(result.nodes[0].variant).toBe('bash');
    expect(result.nodes[0].data).toEqual({ cmd: 'echo hi' });
  });
});
