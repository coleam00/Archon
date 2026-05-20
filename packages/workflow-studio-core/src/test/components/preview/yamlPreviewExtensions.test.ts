import { describe, it, expect } from 'bun:test';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  yamlLanguage,
  yamlSearch,
  readOnlyExt,
  highlightField,
  setHighlightTargets,
  rangesField,
  setRanges,
  pickIdAtLine,
  domEventLineHandler,
  targetsField,
} from '../../../components/preview/yamlPreviewExtensions';
import type { NodeRange } from '../../../exporter/serializeYaml';

const ranges: NodeRange[] = [
  { id: 'a', startLine: 3, endLine: 5 },
  { id: 'b', startLine: 7, endLine: 9 },
];

const mountView = (doc: string, extensions: Extension[]) => {
  const state = EditorState.create({ doc, extensions });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const view = new EditorView({ state, parent: host });
  return {
    view,
    host,
    cleanup: () => {
      view.destroy();
      host.remove();
    },
  };
};

describe('yamlPreviewExtensions', () => {
  it('yamlLanguage() returns a non-empty extension', () => {
    expect(yamlLanguage()).toBeTruthy();
  });

  it('readOnlyExt() makes the editor read-only', () => {
    const state = EditorState.create({ doc: 'hello', extensions: [readOnlyExt()] });
    expect(state.readOnly).toBe(true);
  });

  it('yamlSearch() returns an installable extension', () => {
    const ext = yamlSearch();
    const { cleanup } = mountView('hi', [ext]);
    cleanup();
  });

  it('pickIdAtLine resolves a line within a range', () => {
    expect(pickIdAtLine(ranges, 4)).toBe('a');
    expect(pickIdAtLine(ranges, 8)).toBe('b');
    expect(pickIdAtLine(ranges, 99)).toBeNull();
  });

  it('rangesField + setRanges round-trip the source map into editor state', () => {
    const { view, cleanup } = mountView('a\nb\nc\n', [rangesField]);
    expect(view.state.field(rangesField)).toEqual([]);
    view.dispatch({ effects: setRanges.of(ranges) });
    expect(view.state.field(rangesField)).toEqual(ranges);
    cleanup();
  });

  it('highlightField produces decorations for selected and hovered ids', () => {
    const doc = 'L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\nL9\n';
    const { view, cleanup } = mountView(doc, [rangesField, targetsField, highlightField]);
    view.dispatch({ effects: setRanges.of(ranges) });
    view.dispatch({
      effects: setHighlightTargets.of({ selectedNodeId: 'a', hoveredNodeId: 'b' }),
    });
    const decos = view.state.field(highlightField);
    let count = 0;
    decos.between(0, doc.length, () => {
      count++;
    });
    expect(count).toBe(6);
    cleanup();
  });

  it('domEventLineHandler routes click coords to the resolved node id', () => {
    let picked: string | null | undefined;
    const ext = domEventLineHandler({
      onPick: id => {
        picked = id;
      },
    });
    const { view, cleanup } = mountView('L1\nL2\nL3\nL4\nL5\n', [rangesField, ext]);
    view.dispatch({ effects: setRanges.of([{ id: 'x', startLine: 2, endLine: 4 }]) });
    const id = pickIdAtLine(view.state.field(rangesField), 3);
    expect(id).toBe('x');
    ext.invokeForLine(view, 3);
    expect(picked).toBe('x');
    cleanup();
  });
});
