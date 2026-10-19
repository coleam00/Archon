// @archon-test-isolated
import { describe, test, expect } from 'bun:test';
import { describeAbandonOwner } from './test-harness';

describe('describeAbandonOwner', () => {
  const noOwner = (recordedOwner: { host: string; pid: number; uid?: number } | undefined) =>
    ({
      kind: 'no_owner_answered',
      detail: 'ENOENT',
      recordedOwner,
      lastActivityAt: new Date('2026-09-20T10:00:00.000Z'),
      thisHost: 'here',
      thisUid: 501,
    }) as const;

  test('shows the recorded host, pid, and last activity', () => {
    expect(describeAbandonOwner(noOwner({ host: 'here', pid: 4242 }))).toEqual([
      'No live owner answered for this run on this host (here; ENOENT).',
      'Recorded owner: host here, pid 4242.',
      'Last activity: 2026-09-20T10:00:00.000Z.',
    ]);
  });

  test('says plainly when the recorded owner is on another host', () => {
    const lines = describeAbandonOwner(noOwner({ host: 'build-box', pid: 4242 }));
    expect(lines).toContain('Recorded owner: host build-box, pid 4242.');
    expect(lines.at(-1)).toBe(
      'The recorded owner is on another host (build-box). Abandon cannot reach or stop a process there; ' +
        'if it is still running, it keeps running after this run is marked cancelled.'
    );
  });

  test('says plainly when the recorded owner ran as another user on this host', () => {
    // The endpoint directory is per-uid, so an owner running as another user is as
    // unreachable as one on another host.
    const lines = describeAbandonOwner(noOwner({ host: 'here', pid: 4242, uid: 1000 }));
    expect(lines.at(-1)).toBe(
      'The recorded owner ran as another user (uid 1000), and abandon runs as uid 501. ' +
        'Abandon can only reach owners running as its own user; ' +
        'if it is still running, it keeps running after this run is marked cancelled.'
    );
    expect(describeAbandonOwner(noOwner({ host: 'here', pid: 4242, uid: 501 }))).toHaveLength(3);
  });

  test('says when no owner was recorded', () => {
    expect(describeAbandonOwner(noOwner(undefined))).toContain(
      'Recorded owner: none (the run predates owner recording).'
    );
  });
});
