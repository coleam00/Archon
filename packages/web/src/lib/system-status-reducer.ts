import type { ChatMessage } from './types';

/**
 * Append a system-status line to the chat while coalescing consecutive status updates.
 *
 * Continuity goal: when multiple transient status updates arrive back-to-back,
 * keep a single evolving system row instead of stacking flickery one-line rows.
 */
export function applySystemStatus(
  prev: ChatMessage[],
  content: string,
  makeId: () => string = () => `msg-${String(Date.now())}`,
  now: number = Date.now()
): ChatMessage[] {
  const last = prev[prev.length - 1];

  if (last?.role === 'system') {
    return [
      ...prev.slice(0, -1),
      {
        ...last,
        content,
        timestamp: now,
      },
    ];
  }

  return [
    ...prev,
    {
      id: makeId(),
      role: 'system',
      content,
      timestamp: now,
    },
  ];
}
