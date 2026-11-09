import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { toRun } from '../primitives/run';
import { detailFixture } from '../primitives/run.test-fixtures';
import { RecentRunRow } from './RecentRunRow';
import { RunDetailHeader } from './RunDetailHeader';

const originalTimezone = process.env.TZ;
const now = Date.UTC(2026, 5, 14, 0, 22, 53);
let clock: ReturnType<typeof spyOn<typeof Date, 'now'>>;

beforeEach(() => {
  process.env.TZ = 'Pacific/Kiritimati';
  clock = spyOn(Date, 'now').mockReturnValue(now);
});

afterEach(() => {
  clock.mockRestore();
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;
});

test('the list row and header show the local start date and time', () => {
  const run = toRun({
    ...detailFixture.run,
    started_at: '2026-06-12 23:22:53',
    completed_at: '2026-06-12 23:27:05',
  });
  const row = renderToStaticMarkup(
    <MemoryRouter>
      <RecentRunRow run={run} />
    </MemoryRouter>
  );
  expect(row).toContain('1d ago');
  expect(row).toMatch(/title="Started Jun 13, 2026\D+13:22:53/);
  expect(row).toContain('04:12');

  const header = renderToStaticMarkup(
    <MemoryRouter>
      <RunDetailHeader run={run} projectName="Archon" projectId={undefined} />
    </MemoryRouter>
  );
  expect(header).toMatch(/Started[^<]*<time[^>]*>Jun 13, 2026\D+13:22:53/);
  expect(header).toMatch(/Finished[^<]*<time[^>]*>Jun 13, 2026\D+13:27:05/);
  expect(header).toContain('04:12');
});
