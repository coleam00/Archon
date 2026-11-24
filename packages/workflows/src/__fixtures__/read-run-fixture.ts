import { readFileSync } from 'node:fs';
import type { WorkflowEventRow } from '../schemas/workflow-event';

/**
 * A run copied from the live factory database, stored as JSON Lines so a reviewer reads one
 * event per line: line 1 is `{ note, run }` (the note says where the copy came from and what was
 * trimmed), every later line is one event row in `event_order`. The run's fields stay raw; each
 * test hydrates them with its own defaults.
 */
export function readRunFixture(path: string): {
  note: string;
  run: Record<string, unknown>;
  events: WorkflowEventRow[];
} {
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '');
  const [head, ...rows] = lines.map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(`${path}:${index + 1} is not JSON: ${(error as Error).message}`);
    }
  });
  const { note, run } = (head ?? {}) as { note?: unknown; run?: unknown };
  if (typeof note !== 'string' || typeof run !== 'object' || run === null) {
    throw new Error(`${path}: line 1 must be { note, run }`);
  }
  return { note, run: run as Record<string, unknown>, events: rows as WorkflowEventRow[] };
}
