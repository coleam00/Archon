import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  currentProcessOwner,
  isOwnerProvablyGone,
  parseProcessOwner,
  ProcessOwnerRecordError,
} from './process-owner';

// Zero and negative pids address process groups; -999999 names no group, so a
// probe of it fails with ESRCH and would read as a dead owner.
const invalidPids = [0, -1, -999999, Number.NaN, 1.5];

const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

describe('isOwnerProvablyGone', () => {
  test.each(invalidPids)('pid %p is never proof of death and is never probed', pid => {
    const kill = spyOn(process, 'kill');
    spies.push(kill);
    const owner = { ...currentProcessOwner, pid, instance: crypto.randomUUID() };
    expect(isOwnerProvablyGone(owner)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });
});

describe('parseProcessOwner', () => {
  test('returns exactly the owner fields of a valid record', () => {
    expect(parseProcessOwner({ ...currentProcessOwner, extra: true }, 'test')).toEqual(
      currentProcessOwner
    );
  });

  test.each(invalidPids)('rejects pid %p naming the source', pid => {
    const error = (() => {
      try {
        parseProcessOwner({ ...currentProcessOwner, pid }, 'slot row 7');
      } catch (thrown) {
        return thrown;
      }
      throw new Error('expected a rejection');
    })();
    expect(error).toBeInstanceOf(ProcessOwnerRecordError);
    expect((error as ProcessOwnerRecordError).source).toBe('slot row 7');
    expect((error as Error).message).toContain('slot row 7');
  });

  test.each([null, 'owner', { pid: 1, instance: 'i' }, { host: 'h', pid: '1', instance: 'i' }])(
    'rejects malformed record %p',
    record => {
      expect(() => parseProcessOwner(record, 'test')).toThrow(ProcessOwnerRecordError);
    }
  );
});
