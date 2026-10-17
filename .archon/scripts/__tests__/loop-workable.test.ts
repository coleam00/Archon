import { describe, expect, it } from 'bun:test';
import {
  closes,
  dependencies,
  workability,
  type BoardItem,
} from '../../workflows/sdlc/.shared/workable';

const now = Date.parse('2026-10-17T12:00:00Z');
const hoursAgo = (h: number): string => new Date(now - h * 3_600_000).toISOString();

function item(number: number, extra: Partial<BoardItem> = {}): BoardItem {
  return { number, title: `item ${number}`, body: '', labels: [], comments: [], ...extra };
}

const claim = (run: string, h = 1): BoardItem['comments'][number] => ({
  body: `Loop claim: run ${run}\n\nRoute: simple\nArea: a`,
  createdAt: hoursAgo(h),
});

describe('loop launch gate', () => {
  it('reads Depends on lines and closing keywords the way pick does', () => {
    expect(dependencies('Intro\nDepends on: #3, #5\n- **Depends on:** #9')).toEqual([3, 5, 9]);
    expect(dependencies('This depends on nothing; see #4')).toEqual([]);
    expect(closes('Closes #12. Also fixes #13 and Resolves #14')).toEqual([12, 13, 14]);
  });

  it('an open issue with no claim, owner label or open dependency is workable', () => {
    const result = workability({ issues: [item(1), item(2, { body: 'Depends on: #9' })], pulls: [] }, 6, now);
    // #9 is not open, so it is closed: #2 is free too.
    expect(result.workable).toEqual([
      { kind: 'issue', number: 1 },
      { kind: 'issue', number: 2 },
    ]);
  });

  it('a serial chain leaves only its head workable', () => {
    const result = workability(
      {
        issues: [item(1), item(2, { body: 'Depends on: #1' }), item(3, { body: 'Depends on: #2' })],
        pulls: [],
      },
      6,
      now
    );
    expect(result.workable).toEqual([{ kind: 'issue', number: 1 }]);
    expect(result.waiting.map(w => w.why)).toEqual(['depends on #1', 'depends on #2']);
  });

  it('live claims take items; released, withdrawn and expired claims do not', () => {
    const result = workability(
      {
        issues: [
          item(1, { comments: [claim('run-a')] }),
          item(2, { comments: [{ body: 'Loop claim released: run run-b ended.', createdAt: hoursAgo(1) }] }),
          item(3, { comments: [{ body: 'Loop claim withdrawn: run run-c', createdAt: hoursAgo(1) }] }),
          item(4, { comments: [claim('run-d', 7)] }),
        ],
        pulls: [],
      },
      6,
      now
    );
    expect(result.claims).toEqual([{ kind: 'issue', number: 1, run: 'run-a' }]);
    expect(result.workable.map(w => w.number)).toEqual([2, 3, 4]);
  });

  it('a claim held by a run the scheduler knows has ended is dead and returned for release', () => {
    const dead = { ...claim('run-gone'), url: 'https://github.com/o/r/issues/1#issuecomment-77' };
    const result = workability(
      { issues: [item(1, { comments: [dead, claim('run-live')] })], pulls: [] },
      6,
      now,
      new Set(['run-gone'])
    );
    // The next live claim holds the item; the dead one is released, not counted.
    expect(result.claims).toEqual([{ kind: 'issue', number: 1, run: 'run-live' }]);
    expect(result.ended).toEqual([{ kind: 'issue', number: 1, run: 'run-gone', url: dead.url }]);
    expect(result.workable).toEqual([]);

    const alone = workability({ issues: [item(2, { comments: [dead] })], pulls: [] }, 6, now, new Set(['run-gone']));
    expect(alone.workable).toEqual([{ kind: 'issue', number: 2 }]);
  });

  it("owner decisions and the manager's records are not work", () => {
    const result = workability(
      {
        issues: [
          item(1, { labels: ['needs-owner'] }),
          item(2, { title: 'Owner decisions needed' }),
          item(3, { title: 'Loop metrics' }),
        ],
        pulls: [],
      },
      6,
      now
    );
    expect(result.workable).toEqual([]);
  });

  it('an open pull request is the work for the issue it closes, and shares its claim', () => {
    const free = workability({ issues: [item(1)], pulls: [item(20, { body: 'Closes #1' })] }, 6, now);
    expect(free.workable).toEqual([{ kind: 'pull', number: 20 }]);

    const held = workability(
      { issues: [item(1, { comments: [claim('run-a')] })], pulls: [item(20, { body: 'Closes #1' })] },
      6,
      now
    );
    expect(held.workable).toEqual([]);

    const parked = workability(
      { issues: [item(1, { labels: ['needs-owner'] })], pulls: [item(20, { body: 'Closes #1' })] },
      6,
      now
    );
    expect(parked.workable).toEqual([]);
  });
});
