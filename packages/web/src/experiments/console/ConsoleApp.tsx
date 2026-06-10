import { useMemo, useState, type ReactElement } from 'react';
import { Routes, Route, useNavigate } from 'react-router';
import { ProjectRail } from './components/ProjectRail';
import { AddProjectDialog } from './components/AddProjectDialog';
import { ProjectPalette } from './components/ProjectPalette';
import { KeymapHelp } from './components/KeymapHelp';
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
      <div className="flex min-h-0 flex-1">
        <ProjectRail
          onAddProject={() => {
            setAddOpen(true);
          }}
        />
        <main className="flex min-w-0 flex-1 flex-col">
          <Routes>
            <Route index element={<RunsPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="_preview" element={<PreviewPage />} />
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
