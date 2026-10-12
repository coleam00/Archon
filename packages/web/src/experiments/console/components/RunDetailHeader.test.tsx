import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { detailFixture, terminalRecord } from '../primitives/run.test-fixtures';
import { toRun } from '../primitives/run';
import { RunDetailHeader } from './RunDetailHeader';

test('the shared detail header shows succeeded terminal output', () => {
  const run = toRun({
    ...detailFixture.run,
    outcome: 'succeeded',
    terminal_record: terminalRecord(
      {
        availability: 'available',
        node_id: 'result',
        value: { rationale: 'The change is delivered.' },
      },
      'succeeded'
    ),
  });
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <RunDetailHeader run={run} projectName="Archon" projectId={undefined} />
    </MemoryRouter>
  );
  expect(html).toContain('Completed');
  expect(html).toContain('Outcome: succeeded');
  expect(html).toContain('rationale');
  expect(html).toContain('The change is delivered.');
});

test('the detail header displays live tool attention', () => {
  const run = toRun({
    ...detailFixture.run,
    status: 'running',
    metadata: {
      tool_call_attention: [
        {
          streamId: 's',
          nodeId: 'implement',
          provider: 'pi',
          toolCallId: 'tool',
          name: 'bash',
          title: 'bun test [REDACTED]',
          startedAt: new Date(Date.now() - 1800000).toISOString(),
          lastProgressAt: new Date(Date.now() - 1800000).toISOString(),
          raisedAt: new Date().toISOString(),
          thresholdMs: 1800000,
        },
      ],
    },
  });
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <RunDetailHeader run={run} projectName="Archon" projectId={undefined} />
    </MemoryRouter>
  );
  expect(html).toContain('Work remains running');
  expect(html).toContain('implement');
  expect(html).toContain('bun test [REDACTED]');
  expect(html).toContain('no progress');
});
