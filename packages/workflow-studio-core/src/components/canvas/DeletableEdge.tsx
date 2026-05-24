import { useCallback, type MouseEvent, type CSSProperties } from 'react';
import { EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from '@xyflow/react';
import { useBuilderStore } from '../../store/builder-store';
import type { DeletableEdgeData } from './deriveFlow';

/**
 * Custom edge with two affordances for deletion:
 *   1. Click anywhere on the path → selects the edge (Canvas wires onEdgeClick).
 *   2. Hover or selection → reveals an "×" button at the midpoint that calls disconnect.
 *
 * Implementation notes:
 *   - Renders two <path> elements directly (no BaseEdge): the visible stroke and a
 *     wider invisible hit-path. Bypassing BaseEdge gives us explicit attribute control
 *     and avoids a prop-spread surprise where the visible path was not painting.
 *   - The visible path carries className 'react-flow__edge-path' so RF's built-in
 *     styling (focus ring, animation) still works.
 *   - The hit-path uses className 'react-flow__edge-interaction' so RF treats it as
 *     a click target (it has pointer-events: stroke via the base CSS).
 *   - Hover state is driven by Canvas-level `onEdgeMouseEnter` / `onEdgeMouseLeave`
 *     which write `hoveredEdgeId` into the builder store.
 */
export function DeletableEdge(props: EdgeProps): JSX.Element {
  const {
    id,
    source,
    target,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    style,
    selected,
    data,
  } = props;

  const disconnect = useBuilderStore(s => s.disconnect);
  const setSelectedEdge = useBuilderStore(s => s.setSelectedEdge);
  const isHovered = useBuilderStore(s => s.hoveredEdgeId === id);

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const dashed = (data as DeletableEdgeData | undefined)?.dashed ?? false;
  const showButton = selected === true || isHovered;

  // Hardcoded fallback paint values — used as SVG attributes so the path is
  // visible even if `style` from deriveFlow is missing or its CSS variables
  // (e.g. var(--studio-muted)) fail to resolve in the host page's theme.
  const fallbackStroke = selected === true ? '#3b82f6' : dashed ? '#a855f7' : '#94a3b8';
  const fallbackStrokeWidth = selected === true ? 2.5 : 1.5;

  const mergedStyle: CSSProperties = {
    ...style,
    ...(dashed && style?.strokeDasharray === undefined ? { strokeDasharray: '6 4' } : {}),
  };

  const handleDelete = useCallback(
    (event: MouseEvent): void => {
      event.stopPropagation();
      // disconnect mutates the store; deriveFlow regenerates rfEdges on the
      // next render, dropping this edge. setSelectedEdge clears the now-stale
      // selection that pointed at this edge.
      setSelectedEdge(null);
      disconnect(source, target);
    },
    [disconnect, source, target, setSelectedEdge]
  );

  return (
    <>
      {/* Visible stroke. SVG `fill="none"` is critical — default fill is black,
          which would paint a giant blob between the endpoints. */}
      <path
        id={id}
        className="react-flow__edge-path"
        d={edgePath}
        fill="none"
        stroke={fallbackStroke}
        strokeWidth={fallbackStrokeWidth}
        style={mergedStyle}
      />
      {/* 20px-wide invisible hit-path. RF's base.css sets pointer-events: stroke
          on .react-flow__edge-interaction, so this is the click/hover target. */}
      <path
        className="react-flow__edge-interaction"
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
      />
      {showButton && (
        <EdgeLabelRenderer>
          <button
            type="button"
            onClick={handleDelete}
            aria-label={`Remove connection from ${source} to ${target}`}
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'all',
              width: 18,
              height: 18,
              borderRadius: 9,
              border: '1px solid var(--studio-border, #94a3b8)',
              background: 'var(--studio-bg, #ffffff)',
              color: 'var(--studio-fg, #475569)',
              cursor: 'pointer',
              fontSize: 12,
              lineHeight: '14px',
              padding: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 1px 2px rgba(0, 0, 0, 0.1)',
            }}
          >
            ×
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
