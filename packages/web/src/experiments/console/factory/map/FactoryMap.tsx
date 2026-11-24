import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { errorDetail } from '../../lib/http';
import { useProjectAttention } from '../../components/ProjectAttention';
import type { EntityView } from '../../store/cache';
import type { FactoryItem } from '../../skills/factory';
import { StaleRead } from '../StaleRead';
import { useFactoryItems } from '../useFactoryItems';
import { layoutMap } from '../lib/map-layout';
import { stageReadOf, type MapLive, type Unread } from '../lib/map-live';
import type { FactoryStage } from '../lib/stage-steps';
import { stageModalLink, type FactoryViewListed } from '../lib/views';
import { MapArrows } from './MapArrows';
import { stageShadowLines, stageShadows, type ShadowItems } from '../lib/shadows';
import { MapCard } from './MapCard';
import { MapDetails } from './MapDetails';
import { MapFlow } from './MapFlow';
import { MapLegend } from './MapLegend';
import { MapNotOnMap } from './MapNotOnMap';
import { MapPillTips } from './MapPillTips';
import { StageModal } from './StageModal';
import { useMapCamera } from './useMapCamera';
import { useStageLive } from '../stage/useStageLive';
import { FactoryLoading } from '../FactoryLoading';
import { readFailed, SlowReadError } from '../lib/deadline';

interface FactoryMapProps {
  projectId: string;
  view: FactoryViewListed;
}

/** What the map draws from. */
interface MapInputs {
  projectId: string;
  view: FactoryViewListed['declaration'];
}

/**
 * The Overview's map: the stages and arrows the view file declares, and live chips from the
 * items read.
 */
export function FactoryMap({ projectId, view }: FactoryMapProps): ReactElement {
  const items = useFactoryItems(projectId);
  return (
    <section aria-label="The map" className="flex flex-col gap-2.5">
      <h3 className="text-console-12 font-medium uppercase tracking-console-label text-text-tertiary">
        The map
      </h3>
      <MapBody projectId={projectId} view={view.declaration} items={items} />
    </section>
  );
}

function MapBody({
  items,
  ...inputs
}: MapInputs & { items: EntityView<FactoryItem[]> }): ReactElement {
  // One shape in every state: a notice above one canvas, so the items answering fills the
  // chips in on the cards already drawn rather than mounting a new map.
  return (
    <>
      <ItemsNotice items={items} />
      <MapLiveCanvas
        {...inputs}
        items={items.data}
        unread={readFailed(items.error) === undefined ? 'loading' : 'failed'}
      />
    </>
  );
}

/**
 * What the map says above itself about the items read. Before the first answer the cards show
 * skeleton chips themselves, so there is no page-level "Loading…"; a read past its deadline says so.
 */
function ItemsNotice({ items }: { items: EntityView<FactoryItem[]> }): ReactElement | null {
  if (items.data !== undefined) return <StaleRead error={items.error} />;
  const failed = readFailed(items.error);
  if (failed !== undefined)
    return (
      <p role="alert" className="text-console-14 text-error">
        The factory's items could not be loaded: {errorDetail(failed)}
      </p>
    );
  return items.error instanceof SlowReadError ? <FactoryLoading read={items} /> : null;
}

/**
 * The map over the items, drawn from the declaration before they are read (`items` undefined:
 * every chip a skeleton bar, or none once the read failed), and the stage `?stage=` opens over
 * it, both from one live read. The modal is the canvas's sibling, outside the frame that pans.
 */
function MapLiveCanvas({
  items,
  unread,
  ...inputs
}: MapInputs & { items: FactoryItem[] | undefined; unread: Unread }): ReactElement {
  const attention = useProjectAttention();
  const live = useStageLive(inputs.view, inputs.projectId, items, unread, attention.data?.items);
  return (
    <>
      <MapCanvas {...inputs} live={live} items={items ?? unread} />
      <StageModal projectId={inputs.projectId} view={inputs.view} live={live} />
    </>
  );
}

function MapCanvas({
  projectId,
  view,
  live,
  items,
}: MapInputs & {
  live: MapLive | Unread;
  /** Every item read, for what each shadow step decided lately; why there is none until then. */
  items: ShadowItems;
}): ReactElement {
  const layout = useMemo(() => layoutMap(view), [view]);
  const { cards, bounds } = layout;
  const [selected, setSelected] = useState<string | null>(null);
  const selectedCard = cards.find(card => card.id === selected);
  const camera = useMapCamera(bounds, selectedCard?.box ?? null);

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
  const stageNotes = (stage: string): string[] =>
    (view.map.notes ?? []).filter(note => note.near === stage).map(note => note.text);
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
                shadows={stage => stageShadowLines(stage, view, items)}
                live={stage => stageReadOf(live, stage)}
                selected={card.id === selected}
                stageLink={stage => stageModalLink(projectId, stage)}
                onDetails={id => setSelected(current => (current === id ? null : id))}
              />
            ))}
            <MapFlow
              cards={cards}
              arrows={layout.arrows}
              working={card =>
                typeof live !== 'string' &&
                card.stages.some(stage => (live.stages.get(stage)?.working ?? 0) > 0)
              }
            />
            <MapPillTips cards={cards} arrows={layout.arrows} />
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
              notes: stageNotes(stage.id),
              shadows: stageShadowLines(stage, view, items),
            }))}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
      <MapLegend
        tones={cards.map(card => card.tone)}
        shadow={view.stages.some(stage => stageShadows(stage, view).length > 0)}
      />
      <MapNotOnMap
        projectId={projectId}
        view={view}
        entries={typeof live === 'string' ? [] : live.notOnMap}
      />
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
      // A press on the controls must not start a pan of the map under them.
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
