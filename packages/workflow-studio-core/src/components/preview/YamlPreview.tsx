import { useEffect, useMemo, useRef } from 'react';
import { EditorView } from '@codemirror/view';
import { CmEditor } from '../inspector/shared/CmEditor';
import {
  previewBaseExtensions,
  domEventLineHandler,
  setRanges,
  setHighlightTargets,
} from './yamlPreviewExtensions';
import type { NodeRange } from '../../exporter/serializeYaml';
import './YamlPreview.module.css';

export interface YamlPreviewProps {
  yaml: string;
  sourceMap: NodeRange[];
  selectedNodeId: string | null;
  hoveredNodeId: string | null;
  onLinePick: (id: string | null) => void;
  onLineHover?: (id: string | null) => void;
}

export function YamlPreview(props: YamlPreviewProps): JSX.Element {
  const { yaml, sourceMap, selectedNodeId, hoveredNodeId, onLinePick, onLineHover } = props;
  const viewRef = useRef<EditorView | null>(null);

  const onPickRef = useRef(onLinePick);
  onPickRef.current = onLinePick;
  const onHoverRef = useRef(onLineHover);
  onHoverRef.current = onLineHover;

  const extensions = useMemo(
    () => [
      ...previewBaseExtensions(),
      domEventLineHandler({
        onPick: id => {
          onPickRef.current(id);
        },
        onHover: id => onHoverRef.current?.(id),
      }),
    ],
    []
  );

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setRanges.of(sourceMap) });
  }, [sourceMap]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setHighlightTargets.of({ selectedNodeId, hoveredNodeId }) });
  }, [selectedNodeId, hoveredNodeId]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !selectedNodeId) return;
    const range = sourceMap.find(r => r.id === selectedNodeId);
    if (!range) return;
    const lineIdx = Math.min(range.startLine, view.state.doc.lines);
    const line = view.state.doc.line(lineIdx);
    view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
  }, [selectedNodeId, sourceMap]);

  return (
    <CmEditor
      value={yaml}
      onChange={(): void => {
        /* read-only preview */
      }}
      extensions={extensions}
      onCreate={v => {
        viewRef.current = v;
        v.dispatch({ effects: setRanges.of(sourceMap) });
        v.dispatch({ effects: setHighlightTargets.of({ selectedNodeId, hoveredNodeId }) });
      }}
    />
  );
}
