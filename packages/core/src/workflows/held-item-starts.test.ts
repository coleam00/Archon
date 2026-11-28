import { describe, expect, test } from 'bun:test';
import { CheckoutCodebaseAmbiguousError } from '../services/codebase-checkout-resolver';
import { heldStartReads } from './held-item-starts';

describe('heldStartReads', () => {
  const start = (receiptId: string, cwd: string) => ({
    kind: 'trigger' as const,
    receiptId,
    bindingId: 'b',
    hostId: null,
    workflow: 'w',
    cwd,
    itemKey: `item-${receiptId}`,
    receivedAt: '2026-11-26T00:00:00.000Z',
  });
  const starts = [start('1', '/clear'), start('2', '/ambiguous'), start('3', '/clear')];
  const readsWith = (fail: (cwd: string) => Error) =>
    heldStartReads({
      listHeldStarts: async () => starts,
      projectKeyOf: async cwd => {
        if (cwd === '/ambiguous') throw fail(cwd);
        return 'project';
      },
    });
  const ambiguous = (cwd: string) =>
    new CheckoutCodebaseAmbiguousError(cwd, '/repo/.git', '/a, /b');

  test('the read of every item lists a start whose checkout is ambiguous unplaced, with why', async () => {
    const held = await readsWith(ambiguous).all();
    expect(held.map(each => [each.receiptId, each.projectKey])).toEqual([
      ['1', 'project'],
      ['2', null],
      ['3', 'project'],
    ]);
    const unplaced = held[1];
    expect(unplaced && 'unplaced' in unplaced ? unplaced.unplaced : undefined).toBe(
      ambiguous('/ambiguous').message
    );
  });

  test("one item's read still fails on the ambiguity, and any other failure fails both", async () => {
    await expect(readsWith(ambiguous).naming('item-2')).rejects.toBeInstanceOf(
      CheckoutCodebaseAmbiguousError
    );
    const other = (cwd: string) => new Error(`cannot read ${cwd}`);
    await expect(readsWith(other).all()).rejects.toThrow('cannot read /ambiguous');
    // Only the item's own starts are resolved, so another item's ambiguity does not fail it.
    expect((await readsWith(ambiguous).naming('item-1')).map(each => each.receiptId)).toEqual([
      '1',
    ]);
  });
});
