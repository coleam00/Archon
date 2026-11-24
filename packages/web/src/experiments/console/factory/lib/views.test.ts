import { describe, expect, test } from 'bun:test';
import type { FactoryViews } from '../../skills/factory';
import { currentView, factoryTabShown, stageSwitchLink } from './views';

const view = (pack: string, source: FactoryViews['views'][number]['source']) =>
  ({
    pack,
    source,
    path: `/${pack}`,
    declaration: { title: pack },
  }) as FactoryViews['views'][number];
const error = (source: FactoryViews['errors'][number]['source']) => ({
  pack: 'p',
  source,
  path: '/p',
  error: 'is invalid',
});

describe('factoryTabShown', () => {
  test('shown when a view applies', () => {
    expect(factoryTabShown({ views: [view('a', 'installed')], errors: [] })).toBe(true);
  });

  test("shown for a broken project file, so its error is seen; not for another pack's", () => {
    expect(factoryTabShown({ views: [], errors: [error('project-file')] })).toBe(true);
    expect(factoryTabShown({ views: [], errors: [error('installed')] })).toBe(false);
  });

  test('hidden with no views, and while the listing loads', () => {
    expect(factoryTabShown({ views: [], errors: [] })).toBe(false);
    expect(factoryTabShown(undefined)).toBe(false);
  });
});

test('the current view is the first listed', () => {
  const listing = { views: [view('mine', 'project-file'), view('pack', 'project')], errors: [] };
  expect(currentView(listing)?.pack).toBe('mine');
  expect(currentView({ views: [], errors: [] })).toBeUndefined();
});

describe("a step's tag opening another stage", () => {
  const to = { pathname: '/console/p/p1/factory', search: '?stage=checks' };

  test('in a pushed modal it replaces the entry and keeps its state, so Close still goes back', () => {
    expect(
      stageSwitchLink('p1', 'checks', { search: '?stage=build', state: { stageModal: true } })
    ).toEqual({ to, replace: true, state: { stageModal: true, tab: 'workflow' } });
  });

  test("in a pasted link's modal it stays a modal Close drops in place", () => {
    expect(stageSwitchLink('p1', 'checks', { search: '?stage=build', state: null })).toEqual({
      to,
      replace: true,
      state: { tab: 'workflow' },
    });
  });

  test('from outside a modal it pushes the modal, as a map link does', () => {
    expect(stageSwitchLink('p1', 'checks', { search: '', state: null })).toEqual({
      to,
      replace: false,
      state: { stageModal: true, tab: 'workflow' },
    });
  });
});
