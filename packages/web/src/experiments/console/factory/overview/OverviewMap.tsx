import { useMemo, type ReactElement, type ReactNode } from 'react';
import type { Box } from '../lib/map-layout';
import {
  groupLabelBox,
  layoutOverview,
  OVERVIEW_FIT_PAD,
  OVERVIEW_FULL_FIT_PAD,
  OVERVIEW_FULL_LEGEND_H,
  OVERVIEW_MAX_K,
  OVERVIEW_MIN_K,
  OVERVIEW_PAGE_MAX_H,
  OVERVIEW_SMALL_TEXT,
} from '../lib/overview-layout';
import type { OverviewView } from '../lib/overview-nav';
import { useMapCamera } from '../map/useMapCamera';
import { OverviewCard } from './OverviewCard';
import { OverviewEdges } from './OverviewEdges';
import { OverviewFlow, useOverviewFlow } from './OverviewFlow';

interface OverviewMapProps {
  view: OverviewView;
  /** Full screen the frame fills the screen; on the page it is as tall as the fitted view. */
  fullScreen: boolean;
  onOpen: (view: string) => void;
  /** Up one level; undefined at the root. */
  onUp: (() => void) | undefined;
  /** Enters full screen, or leaves it when in it. */
  onToggleFullScreen: () => void;
  /** Where the view sits (the breadcrumb): beside the controls above the frame, or full screen over its top-left corner. */
  header: ReactNode;
  /** The flow's pause state, for the view that animates its flow (the root); undefined for the rest. */
  flowControl: FlowControl | undefined;
}

export interface FlowControl {
  paused: boolean;
  onToggle: () => void;
}

/**
 * One view of the overview on a pannable, zoomable canvas: its groups as dashed boxes, its
 * edges and fans, then its cards. It opens fitted, never under the zoom at which its smallest
 * text draws at the type floor: a view wider than its frame there opens at its start and pans.
 * The page keys it by view, so every view opens fitted. On the page the header and the
 * controls share the row above the frame, so neither covers a line nor falls under the first
 * screen; full screen they float over the frame's top corners (the legend over a bottom one),
 * so the fit keeps a wider margin.
 */
export function OverviewMap({
  view,
  fullScreen,
  onOpen,
  onUp,
  onToggleFullScreen,
  header,
  flowControl,
}: OverviewMapProps): ReactElement {
  const layout = useMemo(() => layoutOverview(view), [view]);
  const { cards, groups, edges, bounds, fans } = layout;
  const flow = useOverviewFlow(view, layout, flowControl !== undefined);
  const pad = fullScreen ? OVERVIEW_FULL_FIT_PAD : OVERVIEW_FIT_PAD;
  const camera = useMapCamera(bounds, null, {
    pad,
    minK: OVERVIEW_MIN_K,
    maxK: OVERVIEW_MAX_K,
    reserveBottom: fullScreen ? OVERVIEW_FULL_LEGEND_H : 0,
  });
  const { k, x, y } = camera.camera;
  const controls = (
    <OverviewControls
      camera={camera}
      onUp={onUp}
      fullScreen={fullScreen}
      onToggleFullScreen={onToggleFullScreen}
      flow={flow === undefined ? undefined : flowControl}
    />
  );
  return (
    <div className={fullScreen ? 'absolute inset-0' : 'flex flex-col gap-3'}>
      {fullScreen ? null : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {header}
          {controls}
        </div>
      )}
      <div
        ref={camera.frameRef}
        style={fullScreen ? undefined : { height: Math.min(camera.height, OVERVIEW_PAGE_MAX_H) }}
        aria-label="How the factory works. Drag to move, scroll to zoom, click a card marked ⤢ to open it."
        role="group"
        className={`relative min-w-0 cursor-grab touch-none select-none overflow-hidden factory-canvas active:cursor-grabbing ${
          fullScreen ? 'size-full' : 'rounded-console-12 border border-border'
        }`}
        {...camera.frameHandlers}
      >
        <div
          className="absolute left-0 top-0"
          style={{
            transform: `translate(${x.toString()}px, ${y.toString()}px) scale(${k.toString()})`,
            transformOrigin: '0 0',
          }}
        >
          {(view.groups ?? []).map(group => {
            const box = groups.get(group.id);
            return box === undefined ? null : (
              <OverviewGroup key={group.id} id={group.id} label={group.label} box={box} />
            );
          })}
          <OverviewEdges edges={edges} fans={fans} bounds={bounds} />
          {flow === undefined ? null : (
            <OverviewFlow
              flow={flow}
              view={view}
              cards={cards}
              bounds={bounds}
              paused={flowControl?.paused ?? false}
            />
          )}
          {view.cards.map(card => {
            const box = cards.get(card.id);
            if (box === undefined) return null;
            return <OverviewCard key={card.id} card={card} box={box} onOpen={onOpen} />;
          })}
        </div>
      </div>
      {fullScreen ? (
        <>
          <div className="absolute left-4 top-4 flex flex-col gap-1 rounded-console-12 border border-border bg-surface px-3 py-2 shadow-lg">
            {header}
          </div>
          {controls}
        </>
      ) : null}
    </div>
  );
}

/** A group's dashed box, its label on the top border where `groupLabelBox` puts it. */
function OverviewGroup({ id, label, box }: { id: string; label: string; box: Box }): ReactElement {
  const at = groupLabelBox(box, label);
  return (
    <>
      <div
        data-group={id}
        className="absolute rounded-console-16 border border-dashed border-border-bright"
        style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
      />
      <span
        className={`absolute flex items-center whitespace-nowrap bg-surface-inset px-2 ${OVERVIEW_SMALL_TEXT} font-medium uppercase tracking-console-label text-text-tertiary`}
        style={{ left: at.x, top: at.y, height: at.h }}
      >
        {label}
      </span>
    </>
  );
}

const CONTROL =
  'rounded px-2 py-0.5 text-console-12 text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:opacity-40 disabled:hover:bg-transparent';

function OverviewControls({
  camera,
  onUp,
  fullScreen,
  onToggleFullScreen,
  flow,
}: {
  camera: ReturnType<typeof useMapCamera>;
  onUp: (() => void) | undefined;
  fullScreen: boolean;
  onToggleFullScreen: () => void;
  /** Shown only while the view's flow is drawn. */
  flow: FlowControl | undefined;
}): ReactElement {
  // Full screen they float in the top-right corner, which the fit's wider margin keeps clear.
  const place = fullScreen ? 'absolute right-4 top-4 shadow-lg' : '';
  return (
    <div
      className={`flex items-center gap-0.5 rounded-console-12 border border-border bg-surface px-1 py-0.5 ${place}`}
    >
      <button type="button" disabled={onUp === undefined} onClick={onUp} className={CONTROL}>
        ↑ Up one level
      </button>
      <button type="button" aria-label="Zoom out" onClick={camera.zoomOut} className={CONTROL}>
        −
      </button>
      <button type="button" onClick={camera.fit} className={CONTROL}>
        Fit
      </button>
      <button type="button" aria-label="Zoom in" onClick={camera.zoomIn} className={CONTROL}>
        +
      </button>
      <button type="button" onClick={onToggleFullScreen} className={CONTROL}>
        {fullScreen ? 'Exit full screen (Esc)' : '⛶ Full screen'}
      </button>
      {flow === undefined ? null : (
        <button
          type="button"
          aria-pressed={flow.paused}
          onClick={flow.onToggle}
          className={CONTROL}
        >
          {flow.paused ? '▶ Play flow' : '❚❚ Pause flow'}
        </button>
      )}
    </div>
  );
}
