import { expect, test } from 'bun:test';
import { bindingState, providerState, watcherLine } from './PackSetupPage';
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

test('a provider is configured only when the default is one of the registered providers', () => {
  expect(providerState('claude', ['claude', 'codex']).ok).toBe(true);
  expect(providerState(undefined, ['claude']).ok).toBe(false);
  expect(providerState('pi', ['claude']).ok).toBe(false);
});

test('the watcher line says never, a clean pass, a failed pass and an earlier failure apart', () => {
  const now = Date.parse('2026-11-24T12:00:40Z');
  const at = '2026-11-24T12:00:00Z';
  const pass = { at, pid: 1, ok: true, parts: {} };
  const lines = [
    watcherLine(null, now),
    watcherLine(pass, now),
    watcherLine(
      { ...pass, ok: false, parts: { observe: { at, ok: false, errors: ['rate limited'] } } },
      now
    ),
    watcherLine({ ...pass, lastFailure: { at, errors: ['unknown user'] } }, now),
  ];
  expect(new Set(lines).size).toBe(4);
  expect(lines[2]).toContain('rate limited');
  expect(lines[3]).toContain('unknown user');
});
