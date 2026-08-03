import { describe, expect, test } from 'bun:test';
import { applySystemStatus } from './system-status-reducer';
import type { ChatMessage } from './types';

let idCounter = 0;
function makeId(): string {
  idCounter++;
  return `msg-${String(idCounter)}`;
}

const NOW = 1000;

describe('applySystemStatus', () => {
  test('appends a new system message when previous message is not system', () => {
    const prev: ChatMessage[] = [{ id: 'u1', role: 'user', content: 'hi', timestamp: NOW }];
    const result = applySystemStatus(prev, 'Connecting…', makeId, NOW + 1);

    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({
      id: 'msg-1',
      role: 'system',
      content: 'Connecting…',
      timestamp: NOW + 1,
    });
  });

  test('coalesces consecutive system status updates into one row', () => {
    const prev: ChatMessage[] = [
      { id: 'sys-1', role: 'system', content: 'Connecting…', timestamp: NOW },
    ];
    const result = applySystemStatus(prev, 'Waiting for tools…', makeId, NOW + 2);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: 'sys-1',
      role: 'system',
      content: 'Waiting for tools…',
      timestamp: NOW + 2,
    });
  });

  test('preserves earlier non-system history when coalescing', () => {
    const prev: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'run it', timestamp: NOW },
      { id: 'sys-1', role: 'system', content: 'Starting…', timestamp: NOW + 1 },
    ];
    const result = applySystemStatus(prev, 'Streaming…', makeId, NOW + 3);

    expect(result).toHaveLength(2);
    expect(result[0]).toBe(prev[0]);
    expect(result[1].content).toBe('Streaming…');
    expect(result[1].timestamp).toBe(NOW + 3);
  });
});
