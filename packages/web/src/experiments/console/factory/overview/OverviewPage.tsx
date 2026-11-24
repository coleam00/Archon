import { useEffect, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router';
import { openView, viewList, viewTrail, type OverviewDeclaration } from '../lib/overview-nav';
import { OverviewBreadcrumb } from './OverviewBreadcrumb';
import { OverviewLegend } from './OverviewLegend';
import { type FlowControl, OverviewMap } from './OverviewMap';
import { OverviewSidebar } from './OverviewSidebar';

/**
 * The hand-written explainer of how a pack's factory runs, for presenting it, as the pack's
 * page in the sidebar shows it (`packs/PackPage.tsx`). The open view is `?view=<id>`, so the
 * browser's back goes up a level; on the page, or full screen over the whole console until
 * Esc or Exit.
 */
export function OverviewBody({ overview }: { overview: OverviewDeclaration }): ReactElement {
  const [params, setParams] = useSearchParams();
  const [fullScreen, setFullScreen] = useState(false);
  // Here, above the map, so a pause holds across full screen (a remount) and between views.
  const [flowPaused, setFlowPaused] = useState(false);
  const { id: viewId, unknown } = openView(overview, params.get('view'));
  const open = (id: string): void => {
    setParams(id === overview.root ? {} : { view: id });
  };

  useEffect(() => {
    if (!fullScreen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setFullScreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullScreen]);

  const explorer = (
    <OverviewExplorer
      overview={overview}
      viewId={viewId}
      unknown={unknown}
      fullScreen={fullScreen}
      onOpen={open}
      onToggleFullScreen={() => setFullScreen(!fullScreen)}
      flowControl={
        viewId === overview.root
          ? { paused: flowPaused, onToggle: () => setFlowPaused(!flowPaused) }
          : undefined
      }
    />
  );
  if (!fullScreen) return explorer;
  // Portalled to the body, so no ancestor's layout or transform can hold the overlay in; it
  // carries `console-root` itself, as the body is outside the console's theme.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${overview.title}, full screen`}
      className="console-root fixed inset-0 z-50 bg-surface-inset text-text-primary"
    >
      {explorer}
    </div>,
    document.body
  );
}

interface ExplorerProps {
  overview: OverviewDeclaration;
  viewId: string;
  unknown: string | undefined;
  fullScreen: boolean;
  onOpen: (view: string) => void;
  onToggleFullScreen: () => void;
  /** The flow's pause state, at the root view only: the drill-downs do not animate. */
  flowControl: FlowControl | undefined;
}

/** The open view's map, with Up one level wired to the view above it, under its header. */
function ExplorerMap({
  overview,
  viewId,
  unknown,
  fullScreen,
  onOpen,
  onToggleFullScreen,
  flowControl,
}: ExplorerProps): ReactElement | null {
  const view = overview.views[viewId];
  const trail = viewTrail(overview, viewId);
  const parent = trail.at(-2);
  if (view === undefined) return null;
  return (
    <OverviewMap
      // A new view opens fitted, whatever the last one's camera did.
      key={viewId}
      view={view}
      fullScreen={fullScreen}
      onOpen={onOpen}
      onUp={parent === undefined ? undefined : () => onOpen(parent.id)}
      onToggleFullScreen={onToggleFullScreen}
      flowControl={flowControl}
      header={
        <div className="flex flex-col gap-1">
          <OverviewBreadcrumb trail={trail} onOpen={onOpen} />
          {unknown === undefined ? null : (
            <p className="text-console-12 text-text-tertiary">
              This overview has no view "{unknown}", so it opened at the top.
            </p>
          )}
        </div>
      }
    />
  );
}

function OverviewExplorer(props: ExplorerProps): ReactElement {
  const { overview, viewId, fullScreen, onOpen } = props;
  if (fullScreen)
    // The map fills the screen; its header (the breadcrumb, which also moves between views)
    // and its controls float over its top corners, the legend over the bottom-left one. The
    // presenter says what the caption says.
    return (
      <>
        <ExplorerMap {...props} />
        <div className="absolute bottom-4 left-4 max-w-5xl rounded-console-12 border border-border bg-surface px-3 py-2 shadow-lg">
          <OverviewLegend overview={overview} />
        </div>
      </>
    );
  const caption = viewId === overview.root ? overview.caption : overview.views[viewId]?.caption;
  return (
    <div className="flex flex-col gap-4 md:flex-row">
      <OverviewSidebar views={viewList(overview)} current={viewId} onOpen={onOpen} />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <ExplorerMap {...props} />
        <OverviewLegend overview={overview} />
        {/* Under the map, so the whole root view is in the first screen at 1440x900. */}
        {caption === undefined ? null : (
          <p className="max-w-4xl text-console-14 leading-relaxed text-text-secondary">{caption}</p>
        )}
      </div>
    </div>
  );
}
