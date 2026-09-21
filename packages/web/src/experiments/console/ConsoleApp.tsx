import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { Navigate, Routes, Route, useLocation, useNavigate } from 'react-router';
import { ProjectRail } from './components/ProjectRail';
import { AddProjectDialog } from './components/AddProjectDialog';
import { ProjectPalette } from './components/ProjectPalette';
import { KeymapHelp } from './components/KeymapHelp';
import { BuilderConnected } from './builder/BuilderConnected';
import { RunsPage } from './routes/RunsPage';
import { RunDetailPage } from './routes/RunDetailPage';
import { ChatPage } from './routes/ChatPage';
import { PreviewPage } from './routes/PreviewPage';
import { SettingsPage } from './routes/SettingsPage';
import { invalidate } from './store/cache';
import { K } from './store/keys';
import { useKeymap, type Binding } from './lib/keymap';
import { SHORTCUTS } from './lib/shortcuts';
import './theme.css';

export function ConsoleApp(): ReactElement {
  const [addOpen, setAddOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [railOpen, setRailOpen] = useState(false);
  useEffect(() => {
    setRailOpen(false);
  }, [pathname]);

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
      {
        keys: [','],
        label: 'Open settings',
        run: (): void => {
          navigate('/console/settings');
        },
      },
    ],
    [navigate]
  );
  useKeymap({
    bindings: globalBindings,
    enabled: !addOpen && !paletteOpen && !helpOpen,
  });

  return (
    <div className="console-root flex h-screen w-screen flex-col bg-surface text-text-primary">
      <header className="flex items-center gap-3 border-b border-border px-3 py-2 md:hidden">
        <button
          type="button"
          aria-controls="project-navigation"
          aria-expanded={railOpen}
          onClick={() => {
            setRailOpen(open => !open);
          }}
          className="rounded border border-border px-3 py-2"
        >
          {railOpen ? 'Close navigation' : 'Projects and settings'}
        </button>
        <span className="font-semibold">Archon</span>
      </header>
      <div className="flex min-h-0 flex-1">
        {railOpen ? (
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => {
              setRailOpen(false);
            }}
            className="fixed inset-0 z-20 bg-black/60 md:hidden"
          />
        ) : null}
        <div
          id="project-navigation"
          className={`${railOpen ? 'fixed inset-y-0 left-0 z-30 flex max-w-[calc(100vw-3rem)] shadow-xl' : 'hidden'} md:static md:z-auto md:flex md:max-w-none md:shadow-none`}
        >
          <ProjectRail
            onAddProject={() => {
              setAddOpen(true);
              setRailOpen(false);
            }}
          />
        </div>
        <main className="flex min-w-0 flex-1 flex-col">
          <Routes>
            <Route index element={<RunsPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="builder" element={<BuilderConnected />} />
            <Route path="builder/:name" element={<BuilderConnected />} />
            <Route path="_preview" element={<PreviewPage />} />
            <Route path="r/:runId" element={<RunDetailPage />} />
            <Route path="*" element={<Navigate to="/console" replace />} />
            <Route path="p/:projectId" element={<RunsPage />} />
            <Route path="p/:projectId/chat" element={<ChatPage />} />
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
