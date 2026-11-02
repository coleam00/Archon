import { describe, expect, test } from 'bun:test';
import { releaseRunVerificationImages } from './verification-images';
import type { DockerRunner } from './docker-exec';

const id = (name: string): string => `sha256:${name}`;
function fixture() {
  const images = new Map<string, { id: string; parent: string; owner: string; tags: string[] }>();
  const used = new Set<string>();
  const failures = new Set<string>();
  const removalFailures = new Set<string>();
  const calls: string[][] = [];
  let containerPresent = false;
  const add = (name: string, owner = 'run-a', tags = [`${name}:test`], parent = '') => {
    const image = { id: id(name), parent, owner, tags };
    images.set(image.id, image);
    return image;
  };
  const find = (ref: string) => {
    const image = images.get(ref) ?? [...images.values()].find(image => image.tags.includes(ref));
    if (!image) throw new Error('missing image');
    return image;
  };
  const inspect = (ref: string): string => {
    if (failures.has(ref) && ref.startsWith('sha256:')) throw new Error('inspection unavailable');
    return JSON.stringify(find(ref));
  };
  const remove = (ref: string): string => {
    if (removalFailures.has(ref)) throw new Error('removal failed');
    const image = find(ref);
    if (ref === image.id) {
      if (image.tags.length > 1) throw new Error('multiple repository references');
      images.delete(image.id);
      return '';
    }
    image.tags = image.tags.filter(tag => tag !== ref);
    if (!image.tags.length) images.delete(image.id);
    return '';
  };
  const containerList = (args: string[]): string => {
    const ancestor = args.find(arg => arg.startsWith('ancestor='));
    const present = ancestor
      ? used.has(ancestor.slice(9))
      : containerPresent && args.includes('--all');
    return present ? 'container' : '';
  };
  const runner: DockerRunner = async args => {
    calls.push(args);
    let stdout: string;
    if (args[0] === 'container') stdout = containerList(args);
    else if (args[1] === 'ls') {
      // Include unexpected candidates to exercise inspection's independent ownership check.
      stdout = [...images.keys(), ...images.keys()].join('\n');
    } else if (args[1] === 'inspect') stdout = inspect(args.at(-1)!);
    else if (args[1] === 'rm') stdout = remove(args.at(-1)!);
    else throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    return { stdout, stderr: '' };
  };
  return {
    add,
    images,
    used,
    failures,
    removalFailures,
    calls,
    runner,
    container: (present = true) => {
      containerPresent = present;
    },
  };
}

describe('run verification images', () => {
  test('exact label selection, single tags, dangling images and child-before-parent deletion', async () => {
    const f = fixture();
    const parent = f.add('owned-parent');
    f.add('child', 'run-a', ['child:a'], parent.id);
    f.add('dangling', 'run-a', []);
    f.add('base', '', ['alpine:latest']);
    f.add('bun', '', ['oven/bun:latest']);
    f.add('other', 'run-b');
    await releaseRunVerificationImages('run-a', undefined, f.runner);
    expect([...f.images.keys()].sort()).toEqual([id('base'), id('bun'), id('other')]);
    expect(f.calls[0]).toEqual([
      'image',
      'ls',
      '--all',
      '--quiet',
      '--no-trunc',
      '--filter',
      'label=archon.run_id=run-a',
    ]);
    const removals = f.calls.filter(args => args[1] === 'rm');
    expect(removals.every(args => args[2] === '--no-prune' && !args.includes('--force'))).toBe(
      true
    );
    expect(removals.findIndex(args => args.at(-1) === id('child'))).toBeLessThan(
      removals.findIndex(args => args.at(-1) === id('owned-parent'))
    );
    expect(f.calls.some(args => args.includes('prune'))).toBe(false);
  });

  test.each(['running', 'stopped'])('retains images used by a %s container', async () => {
    const f = fixture();
    f.used.add(f.add('used').id);
    await releaseRunVerificationImages('run-a', undefined, f.runner);
    expect(f.calls.filter(args => args[1] === 'rm')).toEqual([]);
    expect(f.calls.find(args => args[0] === 'container')).toContain('--all');
  });

  test('retains all images until the isolation container has gone', async () => {
    const f = fixture();
    f.add('verification');
    f.container();
    await releaseRunVerificationImages('run-a', 'env-a', f.runner);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toContain('label=diy.archon.env-id=env-a');
    expect(f.images.has(id('verification'))).toBe(true);
    f.container(false);
    await releaseRunVerificationImages('run-a', 'env-a', f.runner);
    expect(f.images.size).toBe(0);
  });

  test('failed inspections and removals retain candidates and allow independent cleanup', async () => {
    const f = fixture();
    f.add('unreadable');
    f.add('blocked');
    f.add('independent');
    f.failures.add(id('unreadable'));
    f.removalFailures.add(id('blocked'));
    await expect(releaseRunVerificationImages('run-a', undefined, f.runner)).rejects.toThrow(
      'cleanup failed'
    );
    expect([...f.images.keys()].sort()).toEqual([id('blocked'), id('unreadable')]);
  });

  test('malformed inspections cannot authorize removal', async () => {
    const calls: string[][] = [];
    await expect(
      releaseRunVerificationImages('run-a', undefined, async args => {
        calls.push(args);
        return { stdout: args[1] === 'ls' ? id('broken') : '{}', stderr: '' };
      })
    ).rejects.toThrow('cleanup failed');
    expect(calls.some(args => args[1] === 'rm')).toBe(false);
  });

  test.each(['inventory', 'container-lookup', 'missing-docker'] as const)(
    '%s failure retains images',
    async failure => {
      const f = fixture();
      f.add('verification');
      const cleanup = releaseRunVerificationImages('run-a', undefined, async (args, opts) => {
        if (
          (failure === 'inventory' && args[1] === 'ls') ||
          (failure === 'container-lookup' && args[0] === 'container')
        )
          throw new Error('Docker unavailable');
        if (failure === 'missing-docker')
          throw Object.assign(new Error('spawn failed'), { code: 'ENOENT' });
        return f.runner(args, opts);
      });
      await expect(cleanup).rejects.toThrow('cleanup failed');
      expect(f.calls.some(args => args[1] === 'rm')).toBe(false);
      expect(f.images.has(id('verification'))).toBe(true);
    }
  );

  test.each(['isolation-container', 'inventory', 'inspect', 'container-lookup', 'removal'])(
    'missing Docker at %s reports the run and original cause',
    async boundary => {
      const f = fixture();
      f.add('verification');
      const cause = Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
      const failure = new Error('Docker command failed', { cause });
      const cleanup = releaseRunVerificationImages(
        'run-a',
        boundary === 'isolation-container' ? 'env-a' : undefined,
        async (args, opts) => {
          if (
            (boundary === 'isolation-container' && args[0] === 'container') ||
            (boundary === 'inventory' && args[0] === 'image' && args[1] === 'ls') ||
            (boundary === 'inspect' && args[1] === 'inspect') ||
            (boundary === 'container-lookup' && args[0] === 'container') ||
            (boundary === 'removal' && args[1] === 'rm')
          )
            throw failure;
          return f.runner(args, opts);
        }
      );
      const error = await cleanup.catch((error: unknown) => error);
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) throw new Error('Expected cleanup failure');
      expect(error.message).toContain('run-a');
      expect(error.errors).toEqual([failure]);
      expect(f.images.has(id('verification'))).toBe(true);
    }
  );

  test('Docker disappearing after inspection errors preserves all failure evidence', async () => {
    const f = fixture();
    f.add('unreadable');
    f.add('verification');
    f.failures.add(id('unreadable'));
    const missing = Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
    const error = await releaseRunVerificationImages('run-a', undefined, async (args, opts) => {
      if (args[0] === 'container') throw missing;
      return f.runner(args, opts);
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error('Expected cleanup failure');
    expect(error.errors).toHaveLength(2);
    expect(String(error.errors[0])).toContain('inspection unavailable');
    expect(error.errors[1]).toBe(missing);
    expect(error.message).toContain('run-a');
    expect(f.images.size).toBe(2);
  });

  test.each([1, 2])(
    'a tag reassigned immediately before deletion is preserved (%s tags)',
    async count => {
      const f = fixture();
      const image = f.add(
        'old',
        'run-a',
        Array.from({ length: count }, (_, i) => `old:${i}`)
      );
      const runner: DockerRunner = async (args, opts) => {
        if (args[1] === 'rm') {
          const tags = image.tags;
          image.tags = [];
          f.add('operator', '', tags);
        }
        return f.runner(args, opts);
      };
      await releaseRunVerificationImages('run-a', undefined, runner);
      expect(f.images.has(id('operator'))).toBe(true);
      expect(f.images.has(image.id)).toBe(false);
    }
  );

  test('multiply tagged images are retained and reported without unsafe tag deletion', async () => {
    const f = fixture();
    f.add('multi', 'run-a', ['multi:a', 'multi:b']);
    f.add('independent');
    await expect(releaseRunVerificationImages('run-a', undefined, f.runner)).rejects.toThrow(
      'cleanup failed'
    );
    expect([...f.images.keys()]).toEqual([id('multi')]);
    expect(
      f.calls.filter(args => args[1] === 'rm').every(args => args.at(-1)?.startsWith('sha256:'))
    ).toBe(true);
  });

  test('empty identity is rejected before Docker is called', async () => {
    const f = fixture();
    await expect(releaseRunVerificationImages('', undefined, f.runner)).rejects.toThrow('run ID');
    expect(f.calls).toEqual([]);
  });
});
