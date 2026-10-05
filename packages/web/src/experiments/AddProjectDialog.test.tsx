import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BaseBranchInspection } from './console/skills/projects';
import type { Project } from './console/primitives/project';

const states: unknown[] = [];
let cursor = 0;
const effects: React.EffectCallback[] = [];
const cleanups: (() => void)[] = [];
const react = { ...React };
mock.module('react', () => ({
  ...react,
  useState: <T,>(initial: T): [T, (value: T) => void] => {
    const index = cursor++;
    if (!(index in states)) states[index] = initial;
    return [
      states[index] as T,
      (value): void => {
        states[index] = value;
      },
    ];
  },
  useEffect: (effect: React.EffectCallback): void => {
    effects.push(effect);
  },
}));
const inspect = mock(
  async (): Promise<BaseBranchInspection> => ({
    kind: 'repo',
    defaultBranch: 'dev',
    reason: null,
  })
);
const addUrl = mock(async (): Promise<Project> => {
  throw new Error('stop after submission');
});
const addPath = mock(async (): Promise<Project> => {
  throw new Error('stop after submission');
});
mock.module('./console/skills', () => ({
  inspectProjectBaseBranch: inspect,
  addProjectByUrl: addUrl,
  addProjectByPath: addPath,
}));
const addProjectDialogComponent = (await import('./console/components/AddProjectDialog'))
  .AddProjectDialog;
const noop = mock(() => undefined);
const originalWindow = globalThis.window;
const timers: (() => void)[] = [];
globalThis.window = {
  setTimeout: (callback: () => void) => {
    timers.push(callback);
    return timers.length;
  },
  clearTimeout: noop,
  addEventListener: noop,
  removeEventListener: noop,
} as unknown as Window & typeof globalThis;

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  states.length = 0;
  effects.length = 0;
  timers.length = 0;
  addUrl.mockClear();
  addPath.mockClear();
});

function render(): React.ReactElement | null {
  cursor = 0;
  return addProjectDialogComponent({ open: true, onClose: noop, onAdded: noop });
}
interface ControlProps {
  children?: React.ReactNode;
  placeholder?: string;
  'aria-label'?: string;
  onChange?: (event: { target: { value: string } }) => void;
  onClick?: () => void;
  onSubmit?: (event: { preventDefault: () => void }) => void;
}
function findControl(
  tree: React.ReactNode,
  match: (element: React.ReactElement<ControlProps>) => boolean
): ControlProps | undefined {
  if (React.isValidElement<ControlProps>(tree)) {
    if (match(tree)) return tree.props;
    for (const child of React.Children.toArray(tree.props.children)) {
      const found = findControl(child, match);
      if (found) return found;
    }
  }
  return undefined;
}
function control(
  tree: React.ReactNode,
  match: (element: React.ReactElement<ControlProps>) => boolean
): ControlProps {
  const found = findControl(tree, match);
  if (!found) throw new Error('Control not found');
  return found;
}

for (const mode of ['url', 'path'] as const) {
  for (const edited of [null, 'release', 'dev']) {
    test(`${mode}: displayed dev submits ${edited === 'release' ? 'an explicit choice' : 'null'} after editing ${String(edited)}`, async () => {
      let tree = render();
      if (mode === 'path') {
        control(
          tree,
          el =>
            el.type === 'button' && React.Children.toArray(el.props.children).includes('Local path')
        ).onClick?.();
        tree = render();
      }
      const source = mode === 'url' ? 'https://example.com/repo' : '/repo';
      control(tree, el => el.type === 'input' && el.props.placeholder !== undefined).onChange?.({
        target: { value: source },
      });
      tree = render();
      for (const effect of effects.splice(0)) {
        const cleanup = effect();
        if (cleanup) cleanups.push(cleanup);
      }
      for (const timer of timers.splice(0)) timer();
      await Promise.resolve();
      tree = render();
      expect(renderToStaticMarkup(tree)).toContain('value="dev"');
      const branch = control(tree, el => el.props['aria-label'] === 'Base branch');
      if (edited !== null) {
        branch.onChange?.({ target: { value: 'release' } });
        branch.onChange?.({ target: { value: edited } });
        tree = render();
      }
      control(tree, el => el.type === 'form').onSubmit?.({ preventDefault: noop });
      await Promise.resolve();
      expect(mode === 'url' ? addUrl : addPath).toHaveBeenCalledWith(
        source,
        edited === 'release' ? 'release' : null
      );
    });
  }
}

afterAll(() => {
  globalThis.window = originalWindow;
});
