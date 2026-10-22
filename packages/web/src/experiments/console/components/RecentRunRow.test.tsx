import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import type { Run } from '../primitives/run';
import { RecentRunRow } from './RecentRunRow';

test.each([
  { costUsd: null, label: 'Cost unavailable (incomplete)' },
  { costUsd: -0.2, label: '≥$-0.2000 (incomplete)' },
])('recent terminal rows show $label', ({ costUsd, label }) => {
  const run: Run = {
    id: 'run-completed',
    projectId: null,
    projectName: 'Archon',
    conversationId: null,
    conversationPlatformId: null,
    workerPlatformId: null,
    workflow: 'implement',
    origin: 'cli',
    status: 'completed',
    attention: null,
    outcome: null,
    terminalRecord: null,
    startedAt: '2026-10-22T10:00:00.000Z',
    finishedAt: '2026-10-22T10:01:00.000Z',
    workingPath: null,
    userMessage: '',
    activeNodes: [],
    lastTool: null,
    costUsd,
    costIncomplete: true,
  };
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <RecentRunRow run={run} />
    </MemoryRouter>
  );
  expect(html).toContain(label);
  if (costUsd === null) expect(html).not.toContain('$');
});
