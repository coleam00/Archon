/**
 * Builder keymap — a `Binding[]` table for the console's `useKeymap` plus the
 * matching `KeymapGroup[]` for the `KeymapHelp` overlay, built from one entry
 * list so the documented chords cannot drift from the wired ones.
 *
 * The console keymap is deliberately modifier-free (Cmd/Ctrl combos bypass it
 * so browser shortcuts keep working), so the bindings are vim-flavored single
 * keys and `g`-chords. Prefix contract (see lib/keymap.ts header): `p` / `?`
 * / `,` are owned by the ConsoleApp-level keymap (palette / help / settings)
 * and must not be bound here — both keymaps listen on the same window. The
 * builder owns the `g` chord prefix on this route; ConsoleApp must not add a
 * `g*` binding without first unifying the chord buffers.
 */
import type { Binding } from '../../lib/keymap';
import type { KeymapGroup } from '../../components/KeymapHelp';
import type { AlignMode } from './align';

/** Everything the keymap can ask the builder to do. */
export interface BuilderKeymapActions {
  undo: () => void;
  redo: () => void;
  copy: () => void;
  cut: () => void;
  paste: () => void;
  removeSelection: () => void;
  selectAll: () => void;
  align: (mode: AlignMode) => void;
  distribute: (axis: 'h' | 'v') => void;
  autoArrange: () => void;
  fitView: () => void;
}

interface BuilderKeyEntry {
  keys: readonly [string, ...string[]];
  label: string;
  group: 'Edit' | 'Arrange';
  run: (actions: BuilderKeymapActions) => void;
}

const ENTRIES: readonly BuilderKeyEntry[] = [
  {
    keys: ['u'],
    label: 'Undo',
    group: 'Edit',
    run: (a): void => {
      a.undo();
    },
  },
  {
    keys: ['U'],
    label: 'Redo',
    group: 'Edit',
    run: (a): void => {
      a.redo();
    },
  },
  {
    keys: ['y'],
    label: 'Copy selection',
    group: 'Edit',
    run: (a): void => {
      a.copy();
    },
  },
  {
    keys: ['x'],
    label: 'Cut selection',
    group: 'Edit',
    run: (a): void => {
      a.cut();
    },
  },
  {
    keys: ['P'],
    label: 'Paste',
    group: 'Edit',
    run: (a): void => {
      a.paste();
    },
  },
  {
    keys: ['Delete'],
    label: 'Delete selection',
    group: 'Edit',
    run: (a): void => {
      a.removeSelection();
    },
  },
  {
    keys: ['Backspace'],
    label: 'Delete selection',
    group: 'Edit',
    run: (a): void => {
      a.removeSelection();
    },
  },
  {
    keys: ['a'],
    label: 'Select all nodes',
    group: 'Edit',
    run: (a): void => {
      a.selectAll();
    },
  },
  {
    keys: ['A'],
    label: 'Auto-arrange (dagre)',
    group: 'Arrange',
    run: (a): void => {
      a.autoArrange();
    },
  },
  {
    keys: ['f'],
    label: 'Fit view',
    group: 'Arrange',
    run: (a): void => {
      a.fitView();
    },
  },
  {
    keys: ['g', 'l'],
    label: 'Align left',
    group: 'Arrange',
    run: (a): void => {
      a.align('left');
    },
  },
  {
    keys: ['g', 'r'],
    label: 'Align right',
    group: 'Arrange',
    run: (a): void => {
      a.align('right');
    },
  },
  {
    keys: ['g', 't'],
    label: 'Align top',
    group: 'Arrange',
    run: (a): void => {
      a.align('top');
    },
  },
  {
    keys: ['g', 'b'],
    label: 'Align bottom',
    group: 'Arrange',
    run: (a): void => {
      a.align('bottom');
    },
  },
  {
    keys: ['g', 'c'],
    label: 'Align horizontal centers',
    group: 'Arrange',
    run: (a): void => {
      a.align('centerV');
    },
  },
  {
    keys: ['g', 'm'],
    label: 'Align vertical centers',
    group: 'Arrange',
    run: (a): void => {
      a.align('centerH');
    },
  },
  {
    keys: ['g', 'h'],
    label: 'Distribute horizontally',
    group: 'Arrange',
    run: (a): void => {
      a.distribute('h');
    },
  },
  {
    keys: ['g', 'v'],
    label: 'Distribute vertically',
    group: 'Arrange',
    run: (a): void => {
      a.distribute('v');
    },
  },
];

/** Dispatcher-side bindings for `useKeymap({ bindings })`. */
export function buildBuilderBindings(actions: BuilderKeymapActions): Binding[] {
  return ENTRIES.map(entry => ({
    keys: entry.keys,
    label: entry.label,
    run: (): void => {
      entry.run(actions);
    },
  }));
}

/**
 * Canvas pointer gestures — documented in the `?` overlay so they're
 * discoverable, but NOT bound here: xyflow owns Space-to-pan
 * (`panActivationKeyCode`), Shift-marquee, and middle/right-drag panning.
 */
const CANVAS_GESTURES: readonly { keys: readonly [string, ...string[]]; label: string }[] = [
  { keys: ['Space', 'drag'], label: 'Pan the canvas' },
  { keys: ['drag'], label: 'Marquee-select nodes' },
  { keys: ['Shift', 'click'], label: 'Add to selection' },
  { keys: ['click', 'edge'], label: 'Select a connector (then Delete)' },
];

/** Docs-side groups for the `KeymapHelp` overlay (same source table). */
export function builderKeymapGroups(): KeymapGroup[] {
  const groups: KeymapGroup[] = [{ title: 'Builder · canvas', entries: CANVAS_GESTURES }];
  for (const title of ['Edit', 'Arrange'] as const) {
    groups.push({
      title: `Builder · ${title.toLowerCase()}`,
      entries: ENTRIES.filter(e => e.group === title).map(e => ({
        keys: e.keys,
        label: e.label,
      })),
    });
  }
  return groups;
}
