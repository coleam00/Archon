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

test('the watcher line says never, unreadable, a clean pass, a failed pass and an earlier failure apart', () => {
  const now = Date.parse('2026-11-24T12:00:40Z');
  const at = '2026-11-24T12:00:00Z';
  const pass = { at, pid: 1, ok: true, parts: {} };
  type LastPass = Parameters<typeof watcherLine>[0]['lastPass'];
  const read = (lastPass: LastPass, lastPassUnreadable: string | null = null) =>
    watcherLine({ lastPass, lastPassUnreadable }, now);
  const lines = [
    read(null),
    read(null, 'ok: expected boolean'),
    read(pass),
    read({ ...pass, ok: false, parts: { observe: { at, ok: false, errors: ['rate limited'] } } }),
    read({ ...pass, lastFailure: { at, errors: ['unknown user'] } }),
  ];
  expect(new Set(lines).size).toBe(5);
  expect(lines[1]).toContain('ok: expected boolean');
  expect(lines[3]).toContain('rate limited');
  expect(lines[4]).toContain('unknown user');
});
