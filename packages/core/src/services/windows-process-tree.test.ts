import { describe, expect, it } from 'bun:test';
import {
  parseWindowsProcessListing,
  WindowsProcessTree,
  type WindowsProcessListing,
  type WindowsProcessRow,
} from './windows-process-tree';

/*
 * The tree logic is pure, so it runs on every platform. The Windows integration spec
 * (`detached-run-control.integration.spec.ts`) proves the real listing and kill.
 */

function row(pid: number, parentPid: number, created: number): WindowsProcessRow {
  return { pid, parentPid, created: BigInt(created) };
}

function listing(takenAt: number, rows: WindowsProcessRow[]): WindowsProcessListing {
  return { takenAt: BigInt(takenAt), rows };
}

function treeFrom(rootPid: number, first: WindowsProcessListing): WindowsProcessTree {
  const tree = WindowsProcessTree.fromRoot(rootPid, first);
  if (!tree) throw new Error('Expected the root to be listed');
  return tree;
}

describe('WindowsProcessTree', () => {
  it('is undefined when the root is not listed, since nothing pins its identity', () => {
    expect(WindowsProcessTree.fromRoot(10, listing(100, [row(11, 10, 50)]))).toBeUndefined();
  });

  it('tracks descendants at any depth and ignores unrelated processes', () => {
    const tree = treeFrom(
      10,
      listing(100, [row(10, 1, 10), row(11, 10, 20), row(12, 11, 30), row(99, 1, 5)])
    );
    expect(
      tree.observe(listing(200, [row(10, 1, 10), row(11, 10, 20), row(12, 11, 30), row(99, 1, 5)]))
    ).toEqual([10, 11, 12]);
  });

  it('finds a child spawned after the first listing whose parent has since exited', () => {
    // The case `taskkill /T` misses: the root spawned 13 during the kill, then died.
    // Windows keeps 13's ParentProcessId, so the tree still owns it.
    const tree = treeFrom(10, listing(100, [row(10, 1, 10), row(11, 10, 20)]));
    expect(tree.observe(listing(200, [row(13, 10, 150)]))).toEqual([13]);
  });

  it('keeps a member found through a parent that later exits', () => {
    const tree = treeFrom(10, listing(100, [row(10, 1, 10)]));
    expect(tree.observe(listing(200, [row(11, 10, 150), row(12, 11, 160)]))).toEqual([11, 12]);
    // 11 is killed; 14 was spawned by 11 before it died and is still found.
    expect(tree.observe(listing(300, [row(12, 11, 160), row(14, 11, 250)]))).toEqual([12, 14]);
    expect(tree.observe(listing(400, []))).toEqual([]);
  });

  it('does not adopt the child of a process that reused a member PID', () => {
    const tree = treeFrom(10, listing(100, [row(10, 1, 10), row(11, 10, 20)]));
    // 11 exits and is seen gone at 200. PID 11 is reused at 250 by an unrelated process,
    // whose child 30 appears at 260: created after 11 was seen gone, so not ours.
    expect(tree.observe(listing(200, [row(10, 1, 10)]))).toEqual([10]);
    expect(tree.observe(listing(300, [row(10, 1, 10), row(11, 1, 250), row(30, 11, 260)]))).toEqual(
      [10]
    );
  });

  it('does not adopt a process older than the parent PID it names', () => {
    // 20 names 10 as parent but predates this 10: its parent was an earlier holder of PID 10.
    const tree = treeFrom(10, listing(100, [row(10, 1, 50), row(20, 10, 40)]));
    expect(tree.observe(listing(200, [row(10, 1, 50), row(20, 10, 40)]))).toEqual([10]);
  });

  it('treats a reused root PID as the root being gone', () => {
    const tree = treeFrom(10, listing(100, [row(10, 1, 10)]));
    expect(tree.observe(listing(200, [row(10, 1, 150)]))).toEqual([]);
  });
});

describe('parseWindowsProcessListing', () => {
  it('reads the listing script output, keeping tick precision beyond 2^53', () => {
    const parsed = parseWindowsProcessListing(
      '{"takenAt":"639251234567890123","rows":[{"pid":10,"parentPid":4,"created":"639251234000000001"}]}'
    );
    expect(parsed.takenAt).toBe(639251234567890123n);
    expect(parsed.rows).toEqual([{ pid: 10, parentPid: 4, created: 639251234000000001n }]);
  });

  it('accepts an empty table', () => {
    expect(parseWindowsProcessListing('{"takenAt":"1","rows":[]}').rows).toEqual([]);
  });

  it.each([
    ['not an object', '"text"'],
    ['missing rows', '{"takenAt":"1"}'],
    ['a numeric takenAt', '{"takenAt":1,"rows":[]}'],
    ['a row without a creation time', '{"takenAt":"1","rows":[{"pid":1,"parentPid":0}]}'],
    ['a non-integer pid', '{"takenAt":"1","rows":[{"pid":"1","parentPid":0,"created":"1"}]}'],
    ['a signed creation time', '{"takenAt":"1","rows":[{"pid":1,"parentPid":0,"created":"-1"}]}'],
  ])('rejects %s', (_label, json) => {
    expect(() => parseWindowsProcessListing(json)).toThrow('unexpected shape');
  });
});
