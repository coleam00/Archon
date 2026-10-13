import { expect, test } from 'bun:test';
import { runLintTargets } from './lint';

test('two lint workers drain every target and return the first failure in target order', async () => {
  const targets = [['a'], ['b'], ['c'], ['d']];
  const started: string[] = [];
  const finish = new Map<string, (code: number) => void>();
  let active = 0;
  let maximum = 0;
  let settled = false;
  const result = runLintTargets(targets, async ([target]) => {
    started.push(target);
    maximum = Math.max(maximum, ++active);
    const code = await new Promise<number>(resolve => finish.set(target, resolve));
    active--;
    return code;
  }).then(code => {
    settled = true;
    return code;
  });
  expect(started).toEqual(['a', 'b']);
  finish.get('b')?.(9);
  await Promise.resolve();
  await Promise.resolve();
  expect(started).toEqual(['a', 'b', 'c']);
  finish.get('c')?.(0);
  await Promise.resolve();
  await Promise.resolve();
  expect(started).toEqual(['a', 'b', 'c', 'd']);
  finish.get('d')?.(0);
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  finish.get('a')?.(7);
  expect(await result).toBe(7);
  expect(maximum).toBe(2);
  expect(active).toBe(0);
});

test('a runner exception fails lint while the workers finish the remaining targets', async () => {
  const started: string[] = [];
  const code = await runLintTargets([['a'], ['b'], ['c']], ([target]) => {
    started.push(target);
    if (target === 'a') throw new Error('spawn failed');
    return Promise.resolve(0);
  });
  expect(code).toBe(1);
  expect(started).toEqual(['a', 'b', 'c']);
  expect(await runLintTargets([['a']], () => Promise.resolve(0))).toBe(0);
});
