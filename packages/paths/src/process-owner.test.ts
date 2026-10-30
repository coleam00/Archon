import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  currentProcessOwner,
  isOwnerProvablyGone,
  isPidProvablyGone,
  probePidLiveness,
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

describe('probePidLiveness', () => {
  // Node types promise only true; retain false too if a runtime returns it.
  test.each([true, false])('retains a normal %p return without proving death', value => {
    const kill = spyOn(process, 'kill').mockImplementation((() => value) as typeof process.kill);
    spies.push(kill);
    expect(probePidLiveness(123)).toEqual({ status: 'returned', value });
    expect(kill.mock.calls).toEqual([[123, 0]]);
    expect(isPidProvablyGone(123)).toBe(false);
  });

  test.each(['ESRCH', 'EPERM', 'EOTHER', undefined])('retains thrown code %p', code => {
    const kill = spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('probe'), { code, errno: -42 });
    });
    spies.push(kill);
    expect(probePidLiveness(123)).toEqual({
      status: 'threw',
      code: code ?? null,
      errno: -42,
    });
    expect(kill.mock.calls).toEqual([[123, 0]]);
    expect(isPidProvablyGone(123)).toBe(code === 'ESRCH');
  });

  test('represents missing error metadata explicitly', () => {
    spies.push(
      spyOn(process, 'kill').mockImplementation(() => {
        throw new Error('probe');
      })
    );
    expect(probePidLiveness(123)).toEqual({
      status: 'threw',
      code: null,
      errno: null,
    });
  });
});
