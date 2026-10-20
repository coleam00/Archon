import { expect, test } from 'bun:test';
import { readPreparationFrame, type RunOwnerPreparedStop } from './run-owner-preparation';

const liveGroup: RunOwnerPreparedStop['groups'][number] = {
  pgid: 123,
  leaderReaped: false,
  signalAttempted: true,
};
const reapedGroup: RunOwnerPreparedStop['groups'][number] = {
  pgid: 456,
  leaderReaped: true,
  signalAttempted: false,
};

test.each([
  { warning: 'held output', group: liveGroup },
  { warning: 'held output', group: reapedGroup },
  { warning: 'held output', extra: true },
  { group: liveGroup, extra: true },
  { group: reapedGroup, extra: true },
])('rejects ambiguous or unknown preparation facts without changing the report: %j', frame => {
  const report: RunOwnerPreparedStop = { groups: [], warnings: [] };
  expect(() => readPreparationFrame(JSON.stringify(frame), report)).toThrow();
  expect(report).toEqual({ groups: [], warnings: [] });
});

test('retains each supported preparation fact', () => {
  const report: RunOwnerPreparedStop = { groups: [], warnings: [] };
  for (const frame of [{ warning: 'held output' }, { group: liveGroup }, { group: reapedGroup }]) {
    readPreparationFrame(JSON.stringify(frame), report);
  }
  expect(report).toEqual({ groups: [liveGroup, reapedGroup], warnings: ['held output'] });
});
