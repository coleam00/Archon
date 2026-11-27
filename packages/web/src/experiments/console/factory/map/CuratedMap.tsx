import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { CuratedView } from '../lib/curated-view';
import type { MapArrow } from '../lib/graph-structure';
import { layoutMap } from '../lib/map-layout';
import { stageReadOf, type MapLive, type Unread } from '../lib/map-live';
import type { FactoryStage } from '../lib/stage-steps';
import { stageModalLink } from '../lib/views';
import { GraphSkeleton } from '../GraphSkeleton';
import type { MapStructure } from '../map-structure';
import { ReadFailure } from '../ReadFailure';
import { MapArrows } from './MapArrows';
import { MapCard } from './MapCard';
import { MapDetails } from './MapDetails';
import { MapFlow } from './MapFlow';
import { MapLegend } from './MapLegend';
import { MapNotOnMap } from './MapNotOnMap';
import { MapPillTips, shortPills } from './MapPillTips';
import { MapSendBacks } from './MapSendBacks';
import { StageModal } from './StageModal';
import { LIVE_FITTING, useMapCamera } from './useMapCamera';
import { useShownSendBacks } from './useShownSendBacks';

interface CuratedMapProps {
  projectId: string;
  view: CuratedView;
  /** The pack graph and the arrows projected from it. */
  structure: MapStructure;
  /** Where the pack's items sit, or why that is not known yet. */
  live: MapLive | Unread;
  /** The project's board. */
  board: string;
}

/**
 * The curated map: the pack graph's stages in the pack's columns, the arrows the pack graph draws
 * between them in the pack's words, and live chips from the items read; and the stage
 * `?stage=` opens over it, from the same live read. The modal is the canvas's sibling, outside
 * the frame that pans.
 */
export function CuratedMap({
  projectId,
  view,
  structure,
  live,
  board,
}: CuratedMapProps): ReactElement {
  const { arrows } = structure;
  return (
    <>
      {arrows === undefined ? (
        <GraphPending structure={structure} />
      ) : (
        <MapCanvas projectId={projectId} view={view} arrows={arrows} live={live} />
      )}
      <StageModal
        projectId={projectId}
        view={view}
        structure={structure}
        live={live}
        board={board}
      />
    </>
  );
}

/**
 * The map's place while the pack graph is read: its loading shape, or why it could not be read
 * with a Retry. The map draws only once it has the arrows, since they set the gaps between its
 * cards.
 */
function GraphPending({ structure }: { structure: MapStructure }): ReactElement {
  const { graph } = structure;
  if (graph.error !== undefined)
    return (
      <ReadFailure retry={graph.refetch}>
        The map could not read the pack's graph: {graph.error.message}
      </ReadFailure>
    );
  return <GraphSkeleton label="Loading the map" />;
}

function MapCanvas({
  projectId,
  view,
  arrows,
  live,
}: {
  projectId: string;
  view: CuratedView;
  arrows: readonly MapArrow[];
  live: MapLive | Unread;
}): ReactElement {
  const layout = useMemo(() => layoutMap(view, arrows), [view, arrows]);
  const { cards, bounds } = layout;
  const [selected, setSelected] = useState<string | null>(null);
  const selectedCard = cards.find(card => card.id === selected);
  // While the details panel is open, Escape closes it and keeps a pin.
  const show = useShownSendBacks(selected !== null);
  const shownRoutes = show.shown === null ? undefined : layout.sendBacks.get(show.shown);
  // The frame hugs the cards and grows under them while a card's send-backs show.
  const below =
    shownRoutes === undefined
      ? 0
      : shownRoutes.extent.y + shownRoutes.extent.h - (bounds.y + bounds.h);
  const camera = useMapCamera(bounds, selectedCard?.box ?? null, LIVE_FITTING, below);

  useEffect(() => {
    if (selected === null) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  const stagesOf = (stages: readonly string[]): FactoryStage[] =>
    stages.flatMap(id => view.stages.filter(stage => stage.id === id));
  const { k, x, y } = camera.camera;
  return (
    <div className="flex flex-col gap-2">
      {/* Side by side from md up; on a phone the details stack under the map. */}
      <div className="flex flex-col gap-3 md:flex-row">
        <div
          ref={camera.frameRef}
          style={{ height: camera.height }}
          aria-label="Factory map. Drag to move, scroll to zoom, click a stage to open it; its details button shows what is in it."
          role="group"
          className="relative min-w-0 cursor-grab md:flex-1 touch-none select-none overflow-hidden rounded-console-12 border border-border factory-canvas active:cursor-grabbing"
          {...camera.frameHandlers}
        >
          <div
            className="absolute left-0 top-0"
            style={{
              transform: `translate(${x.toString()}px, ${y.toString()}px) scale(${k.toString()})`,
              transformOrigin: '0 0',
            }}
          >
            <MapArrows layout={layout} />
            {cards.map(card => (
              <MapCard
                key={card.id}
                card={card}
                stages={stagesOf(card.stages)}
                live={stage => stageReadOf(live, stage)}
                selected={card.id === selected}
                stageLink={stage => stageModalLink(projectId, stage)}
                onDetails={id => setSelected(current => (current === id ? null : id))}
                sendBacks={layout.sendBacks.get(card.id)?.routes.length ?? 0}
                show={show}
              />
            ))}
            {shownRoutes === undefined ? null : (
              <MapSendBacks key={show.shown} bounds={bounds} card={shownRoutes} />
            )}
            <MapFlow
              cards={cards}
              arrows={layout.arrows}
              bounds={bounds}
              working={card =>
                typeof live !== 'string' &&
                card.stages.some(stage => (live.stages.get(stage)?.working ?? 0) > 0)
              }
            />
            <MapPillTips
              pills={shortPills(layout, show.shown === show.pinned ? show.pinned : null)}
            />
          </div>
          <MapControls zoomIn={camera.zoomIn} zoomOut={camera.zoomOut} fit={camera.fit} />
        </div>
        {selectedCard === undefined ? null : (
          <MapDetails
            projectId={projectId}
            view={view}
            title={selectedCard.label}
            stages={stagesOf(selectedCard.stages).map(stage => ({
              stage,
              live: stageReadOf(live, stage.id),
            }))}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
      <MapLegend tones={cards.map(card => card.tone)} map="curated" />
      <MapNotOnMap projectId={projectId} entries={typeof live === 'string' ? [] : live.notOnMap} />
    </div>
  );
}

const CONTROL =
  'rounded px-2 py-0.5 text-console-12 text-text-secondary hover:bg-surface-hover hover:text-text-primary';

function MapControls({
  zoomIn,
  zoomOut,
  fit,
}: {
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
}): ReactElement {
  return (
    <div
      // A press on the controls must not start a pan of the map under them, nor unpin a card's
      // send-backs (`useShownSendBacks`).
      data-map-controls=""
      onPointerDown={event => event.stopPropagation()}
      className="absolute bottom-2 right-2 flex items-center gap-0.5 rounded-console-12 border border-border bg-surface px-1 py-0.5"
    >
      <button type="button" aria-label="Zoom out" onClick={zoomOut} className={CONTROL}>
        −
      </button>
      <button type="button" onClick={fit} className={CONTROL}>
        Fit
      </button>
      <button type="button" aria-label="Zoom in" onClick={zoomIn} className={CONTROL}>
        +
      </button>
    </div>
  );
}
