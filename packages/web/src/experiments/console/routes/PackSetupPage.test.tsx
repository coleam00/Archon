import { expect, test } from 'bun:test';
import { bindingState } from './PackSetupPage';
import type { PackGraph } from '../skills/items';

type Arrow = PackGraph['arrows'][number];
const declared = (binding: string) => ({ binding, problems: [] });
const file = (name: string, problems: string[] = []) => ({
  file: `/home/triggers/${name}.json`,
  sourceInstanceId: name,
  problems,
});
const arrow = (from: string, to: string, rest: Pick<Arrow, 'active' | 'declared' | 'installed'>) =>
  ({ from: { stage: from, outcome: 'done' }, to, linked: null, ...rest }) as Arrow;

test('setup tells registered bindings from missing and left-over ones, and reports their problems', () => {
  const state = bindingState({
    arrows: [
      arrow('plan', 'build', {
        active: true,
        declared: declared('build'),
        installed: file('build'),
      }),
      arrow('build', 'check', { active: false, declared: declared('check'), installed: null }),
      arrow('plan', 'old', {
        active: true,
        declared: null,
        installed: file('old', ["workflow 'old' was not found"]),
      }),
    ],
  });
  expect([state.declared, state.registered]).toEqual([2, 1]);
  expect(state.missing.map(missing => missing.to)).toEqual(['check']);
  expect(state.leftOver.map(left => left.to)).toEqual(['old']);
  expect(state.problems.map(({ arrow: at, problem }) => [at.to, problem])).toEqual([
    ['old', "workflow 'old' was not found"],
  ]);
});
