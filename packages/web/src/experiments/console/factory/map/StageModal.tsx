import {
  useEffect,
  useId,
  useRef,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { stageReadOf, type MapLive, type Unread } from '../lib/map-live';
import type { FactoryStage } from '../lib/stage-steps';
import type { StageModalLink, StageTab } from '../lib/views';
import type { CuratedView } from '../lib/curated-view';
import { StageView, useStageTab, type StageFrame } from '../stage/StageView';
import type { MapStructure } from '../map-structure';
import type { FactoryDrilldown } from '../lib/curated-view';
import { PHASE_COLUMN_REM, PHASE_GAP_REM } from '../stage/StageDrilldown';

/**
 * The stage `?stage=<id>` names, opened as a modal over the Overview (owner change of
 * 2026-11-19, point 5). The Overview stays mounted under it, so the page keeps its scroll and
 * the map its pan and zoom. Esc, the close button and a press on the backdrop close it, and so
 * does Back: a map link pushed the entry (`stageModalLink`), and closing goes back to the
 * entry before it. A modal opened from a pasted link has no entry of ours before it, so closing
 * that one drops `stage` from the URL in place. Mounted beside the map's frame, never inside
 * it: React events bubble through a portal along the component tree, and the frame pans on a
 * pointer drag.
 */
export function StageModal({
  projectId,
  view,
  structure,
  live,
  board,
}: {
  projectId: string;
  view: CuratedView;
  /** The pack graph the map draws from: the stage's steps and where items go from it. */
  structure: MapStructure;
  /** The map's own live read, so the modal's items and the card's chips agree. */
  live: MapLive | Unread;
  /** The project's board, where every item is listed. */
  board: string;
}): ReactElement | null {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const titleId = useId();
  const stageId = params.get('stage');
  if (stageId === null) return null;
  const linked = location.state as Partial<StageModalLink['state']> | null;
  const pushed = linked?.stageModal === true;
  const close = (): void => {
    if (pushed) {
      void navigate(-1);
      return;
    }
    setParams(
      current => {
        const next = new URLSearchParams(current);
        next.delete('stage');
        return next;
      },
      { replace: true }
    );
  };
  const stage = view.stages.find(candidate => candidate.id === stageId);
  if (stage === undefined)
    return (
      <ModalShell titleId={titleId} close={close} drilldown={undefined} tab="does">
        {frame =>
          frame({
            head: (
              <h3 id={titleId} className="text-console-17 font-semibold text-text-primary">
                No such stage
              </h3>
            ),
            body: (
              <p className="text-console-14 text-text-secondary">
                This factory has no stage <span className="font-mono">{stageId}</span>.
              </p>
            ),
          })
        }
      </ModalShell>
    );
  return (
    <OpenStage
      key={stage.id}
      projectId={projectId}
      view={view}
      structure={structure}
      stage={stage}
      live={live}
      titleId={titleId}
      close={close}
      initialTab={linked?.tab}
      board={board}
    />
  );
}

/** A stage in the modal, sized by its open tab. Keyed by stage, so each opens on its own tab. */
function OpenStage({
  projectId,
  view,
  structure,
  stage,
  live,
  titleId,
  close,
  initialTab,
  board,
}: {
  projectId: string;
  view: CuratedView;
  structure: MapStructure;
  stage: FactoryStage;
  live: MapLive | Unread;
  titleId: string;
  close: () => void;
  initialTab: StageTab | undefined;
  board: string;
}): ReactElement {
  const [tab, setTab] = useStageTab(stage, initialTab);
  return (
    <ModalShell titleId={titleId} close={close} drilldown={stage.drilldown} tab={tab}>
      {frame => (
        <StageView
          projectId={projectId}
          view={view}
          structure={structure}
          stage={stage}
          live={stageReadOf(live, stage.id)}
          titleId={titleId}
          tab={tab}
          onTab={setTab}
          frame={frame}
          board={board}
        />
      )}
    </ModalShell>
  );
}

// console-token-exception md:min-w-[max(40rem,min(calc(var(--phases-w,0rem)+6rem),90vw))] -- The stage modal's own rule (DESIGN.md, The map, Click): at least 40rem, else its phases, padding and scrollbar, at most 90vw.
const PANEL_MIN_WIDTH = 'md:min-w-[max(40rem,min(calc(var(--phases-w,0rem)+6rem),90vw))]';

/** What Tab can reach inside the panel. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The dialog: a backdrop and a panel, portalled to the body (it carries `console-root` itself,
 * as the body is outside the console's theme). From md up the panel is centred and as big as
 * its content, by CSS: at least 40rem wide, at most 90% of the window each way. The head and
 * any prose are contained (`contain: inline-size`), so only the drill-down's phase columns
 * (the summary and items tabs) or the graphs drawn ("The real workflow") set the width. A size
 * change snaps: the panel's width is its content's, which CSS does not transition. Under md the
 * panel is the whole screen. The head (title and tabs) stays put while the body scrolls on its
 * own, and `overscroll-contain` keeps a scroll that reaches its end from scrolling the Overview
 * under it.
 */
function ModalShell({
  titleId,
  close,
  drilldown,
  tab,
  children,
}: {
  titleId: string;
  close: () => void;
  drilldown: FactoryDrilldown | undefined;
  tab: StageTab;
  children: (frame: StageFrame) => ReactNode;
}): ReactElement {
  const panel = useRef<HTMLDivElement>(null);
  const phases = tab === 'workflow' ? 0 : (drilldown?.phases.length ?? 0);
  const phasesWidth: (CSSProperties & { '--phases-w': string }) | undefined =
    phases === 0
      ? undefined
      : {
          '--phases-w': `${String(phases * (PHASE_COLUMN_REM + PHASE_GAP_REM) - PHASE_GAP_REM)}rem`,
        };
  const closeButton = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const opener =
      document.activeElement instanceof window.HTMLElement ? document.activeElement : null;
    closeButton.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // Captured on the window and stopped, so the map's own Esc (which closes its details
        // panel, and with it moves the camera) never sees it.
        event.stopPropagation();
        event.preventDefault();
        closeRef.current();
      } else if (event.key === 'Tab' && panel.current !== null) {
        keepTabInside(event, panel.current);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return (): void => {
      window.removeEventListener('keydown', onKey, true);
      opener?.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <div className="console-root fixed inset-0 z-50 text-text-primary md:flex md:items-center md:justify-center">
      <div
        data-backdrop=""
        aria-hidden="true"
        onMouseDown={close}
        className="absolute inset-0 bg-black/60"
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        // The summary and the items keep the phases' width (the columns, the body's padding and
        // close-button gutter, and 0.5rem for the scrollbar's), so moving between them does not
        // resize the panel; nothing else in them widens it.
        style={phasesWidth}
        className={`absolute inset-0 flex flex-col overflow-hidden bg-surface md:relative md:inset-auto md:max-h-[90vh] md:w-fit ${PANEL_MIN_WIDTH} md:max-w-[90vw] md:rounded-console-12 md:shadow-2xl md:ring-1 md:ring-border`}
      >
        <button
          ref={closeButton}
          type="button"
          aria-label="Close"
          onClick={close}
          className="absolute right-3 top-3 z-10 rounded-md p-1.5 text-text-tertiary transition-colors duration-150 ease-out hover:bg-surface-hover hover:text-text-primary"
        >
          <X aria-hidden="true" className="size-5" />
        </button>
        <div className="flex min-h-0 flex-1 flex-col p-4 pr-14 md:p-6 md:pr-16">
          {children(({ head, body }) => (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
              <div className="flex flex-col gap-4 [contain:inline-size]">{head}</div>
              {/* Its content's padding gives a card's focus ring and glow room inside the clip. */}
              <div
                data-modal-body=""
                className="-mx-1 min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
              >
                <div
                  className={`flex flex-col gap-4 p-1 ${tab === 'workflow' ? '' : '[contain:inline-size]'}`}
                >
                  {body}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}

/** Tab from the last focusable element of `panel` goes to its first, Shift+Tab the other way. */
function keepTabInside(event: KeyboardEvent, panel: HTMLElement): void {
  const reachable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const first = reachable[0];
  const last = reachable.at(-1);
  if (first === undefined || last === undefined) return;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !panel.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}
