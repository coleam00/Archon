import { expect, test } from 'bun:test';
import type { ProviderEvent } from '@archon/provider-contract';
import { readProviderEventRows } from './provider-event-reader';
import { providerEventEnvelopeSchema } from './schemas/provider-event';

test('the current reader retains paths, empty observations and unobserved heartbeats', () => {
  const events: ProviderEvent[] = [
    {
      type: 'heartbeat',
      instructionSources: ['/remote/user/AGENTS.md', '/remote/project/AGENTS.md'],
    },
    { type: 'heartbeat', instructionSources: [] },
    { type: 'heartbeat' },
  ];
  const rows = events.map((event, seq) => ({
    id: String(seq),
    workflow_run_id: 'run',
    event_type: 'provider_event',
    step_name: 'build',
    step_index: null,
    data: { attemptId: 'attempt', seq, observedAt: '2026-11-25T00:00:00.000Z', event },
    created_at: '2026-11-25T00:00:00.000Z',
  }));
  expect(rows.map(row => providerEventEnvelopeSchema.parse(row.data).event)).toEqual(events);
  expect(readProviderEventRows('run', rows).map(record => record.event)).toEqual(events);
});
