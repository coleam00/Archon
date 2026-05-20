import { yaml } from '@codemirror/lang-yaml';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, keymap } from '@codemirror/view';
import type { NodeRange } from '../../exporter/serializeYaml';

// ---------- stable factories ----------

export function yamlLanguage(): Extension {
  return yaml();
}

export function yamlSearch(): Extension {
  return [search({ top: true }), keymap.of(searchKeymap)];
}

export function readOnlyExt(): Extension {
  // editable.of(false) blocks typing AND removes the contenteditable focus
  // surface. Restore focusability with an explicit tabindex so clicks land
  // focus on .cm-content — required for Ctrl+F (searchKeymap) to fire.
  return [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.contentAttributes.of({ tabindex: '0' }),
  ];
}

// ---------- pure resolver ----------

export function pickIdAtLine(ranges: readonly NodeRange[], line: number): string | null {
  const found = ranges.find(r => line >= r.startLine && line <= r.endLine);
  return found ? found.id : null;
}

// ---------- ranges field + effect ----------

export const setRanges = StateEffect.define<NodeRange[]>();

export const rangesField = StateField.define<NodeRange[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setRanges)) return e.value;
    }
    return value;
  },
});

// ---------- targets field + effect ----------

export interface HighlightTargets {
  selectedNodeId: string | null;
  hoveredNodeId: string | null;
}

export const setHighlightTargets = StateEffect.define<HighlightTargets>();

export const targetsField = StateField.define<HighlightTargets>({
  create: () => ({ selectedNodeId: null, hoveredNodeId: null }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setHighlightTargets)) return e.value;
    }
    return value;
  },
});

// ---------- decoration field ----------

const selectedDeco = Decoration.line({ class: 'cm-yaml-selected' });
const hoveredDeco = Decoration.line({ class: 'cm-yaml-hovered' });

const buildDecorations = (state: EditorState): DecorationSet => {
  const ranges = state.field(rangesField, false) ?? [];
  const targets = state.field(targetsField, false) ?? {
    selectedNodeId: null,
    hoveredNodeId: null,
  };
  if (ranges.length === 0) return Decoration.none;

  const sorted: { from: number; deco: Decoration }[] = [];
  const addRange = (id: string | null, deco: Decoration): void => {
    if (!id) return;
    for (const r of ranges) {
      if (r.id !== id) continue;
      const maxLine = state.doc.lines;
      for (let line = r.startLine; line <= r.endLine && line <= maxLine; line++) {
        sorted.push({ from: state.doc.line(line).from, deco });
      }
    }
  };
  addRange(targets.hoveredNodeId, hoveredDeco);
  addRange(targets.selectedNodeId, selectedDeco);
  sorted.sort((a, b) => a.from - b.from);
  return Decoration.set(
    sorted.map(({ from, deco }) => deco.range(from)),
    true
  );
};

export const highlightField = StateField.define<DecorationSet>({
  create: state => buildDecorations(state),
  update(value, tr) {
    let recompute = tr.docChanged;
    for (const e of tr.effects) {
      if (e.is(setRanges) || e.is(setHighlightTargets)) recompute = true;
    }
    return recompute ? buildDecorations(tr.state) : value;
  },
  provide: f => EditorView.decorations.from(f),
});

// ---------- DOM event handlers ----------

export type LinePickHandler = Extension & {
  invokeForLine: (view: EditorView, line: number) => void;
};

export function domEventLineHandler(args: {
  onPick: (id: string | null) => void;
  onHover?: (id: string | null) => void;
}): LinePickHandler {
  const { onPick, onHover } = args;
  let lastHover: string | null | undefined = undefined;

  const handlers: Extension = EditorView.domEventHandlers({
    mousedown(event, view) {
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;
      const line = view.state.doc.lineAt(pos).number;
      onPick(pickIdAtLine(view.state.field(rangesField, false) ?? [], line));
      return false;
    },
    mousemove(event, view) {
      if (!onHover) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;
      const line = view.state.doc.lineAt(pos).number;
      const id = pickIdAtLine(view.state.field(rangesField, false) ?? [], line);
      if (id !== lastHover) {
        lastHover = id;
        onHover(id);
      }
      return false;
    },
    mouseleave(_e, _view) {
      if (!onHover) return false;
      if (lastHover !== null) {
        lastHover = null;
        onHover(null);
      }
      return false;
    },
  });

  return Object.assign(handlers, {
    invokeForLine(view: EditorView, line: number) {
      onPick(pickIdAtLine(view.state.field(rangesField, false) ?? [], line));
    },
  }) as LinePickHandler;
}

/** Bundled "install everything" helper. */
export function previewBaseExtensions(): Extension[] {
  return [
    yamlLanguage(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    yamlSearch(),
    readOnlyExt(),
    rangesField,
    targetsField,
    highlightField,
  ];
}
