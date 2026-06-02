import { useMemo, useState, type ReactElement } from 'react';
import { Routes, Route, Link, useNavigate } from 'react-router';
import { ProjectRail } from './components/ProjectRail';
import { AddProjectDialog } from './components/AddProjectDialog';
import { ProjectPalette } from './components/ProjectPalette';
import { KeymapHelp } from './components/KeymapHelp';
import { RunsPage } from './routes/RunsPage';
import { RunDetailPage } from './routes/RunDetailPage';
import { PreviewPage } from './routes/PreviewPage';
import { invalidate } from './store/cache';
import { K } from './store/keys';
import { useKeymap, type Binding } from './lib/keymap';
import { SHORTCUTS } from './lib/shortcuts';
import './theme.css';

/**
 * Console experiment shell.
 *
 * Mounted at `/console/*` outside the production <Layout /> so the existing
 * TopNav does not render over us. Internal <Routes> handle console-specific
 * paths relative to /console.
 */
export function ConsoleApp(): ReactElement {
  const [addOpen, setAddOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const navigate = useNavigate();

  // `n` (new run) is owned by DraftRunCard's own window listener — only
  // mounted when a project is scoped — and stays there.
  const globalBindings = useMemo<readonly Binding[]>(
    () => [
      {
        keys: ['p'],
        label: 'Pick a project',
        run: (): void => {
          setPaletteOpen(true);
        },
      },
      {
        keys: ['?'],
        label: 'Show help',
        run: (): void => {
          setHelpOpen(v => !v);
        },
      },
    ],
    []
  );
  useKeymap({
    bindings: globalBindings,
    enabled: !addOpen && !paletteOpen && !helpOpen,
  });

  return (
    <div className="console-root flex h-screen w-screen flex-col bg-white text-text-primary">
      <header className="flex h-12 shrink-0 items-center justify-between border-b-[3px] border-black bg-white px-4">
        <div className="flex items-center gap-2.5">
          <Link to="/chat" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
            <div className="flex h-7 w-7 items-center justify-center bg-black text-white">
              <span className="text-sm font-semibold">K</span>
            </div>
            <span className="text-sm font-semibold text-black">Kairon</span>
          </Link>
          <span className="border-[3px] border-black bg-[#F0F0F0] px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-[#666666]">
            console
          </span>
        </div>
        <Link
          to="/chat"
          title="Switch back to the classic UI"
          className="inline-flex items-center gap-1.5 border-[3px] border-black bg-white px-2.5 py-1.5 text-[11px] font-semibold text-black transition-colors hover:bg-[#F0F0F0]"
        >
          <span aria-hidden className="font-mono text-[11px] leading-none">
            ←
          </span>
          Classic UI
        </Link>
      </header>

      <div className="flex min-h-0 flex-1">
        <ProjectRail
          onAddProject={() => {
            setAddOpen(true);
          }}
        />
        <main className="flex min-w-0 flex-1 flex-col">
          <Routes>
            <Route index element={<RunsPage />} />
            <Route path="_preview" element={<PreviewPage />} />
            <Route path="p/:projectId" element={<RunsPage />} />
            <Route path="p/:projectId/r/:runId" element={<RunDetailPage />} />
          </Routes>
        </main>
      </div>

      <AddProjectDialog
        open={addOpen}
        onClose={() => {
          setAddOpen(false);
        }}
        onAdded={project => {
          invalidate(K.projects);
          navigate(`/console/p/${project.id}`);
        }}
      />

      <ProjectPalette
        open={paletteOpen}
        onClose={() => {
          setPaletteOpen(false);
        }}
      />

      <KeymapHelp
        open={helpOpen}
        onClose={() => {
          setHelpOpen(false);
        }}
        groups={SHORTCUTS}
      />
    </div>
  );
}
