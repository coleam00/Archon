import { useState, type ReactElement } from 'react';
import { Routes, Route, useNavigate } from 'react-router';
import { ProjectRail } from './components/ProjectRail';
import { AddProjectDialog } from './components/AddProjectDialog';
import { RunsPage } from './routes/RunsPage';
import { RunDetailPage } from './routes/RunDetailPage';
import { PreviewPage } from './routes/PreviewPage';
import { invalidate } from './store/cache';
import { K } from './store/keys';
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
  const navigate = useNavigate();

  return (
    <div className="console-root flex h-screen w-screen flex-col bg-surface text-text-primary">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-3">
          <span className="brand-text text-base font-semibold tracking-tight">Archon</span>
          <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-text-tertiary">
            console · spike
          </span>
        </div>
        <div className="flex items-center gap-3 text-text-tertiary">
          <span className="font-mono text-[11px]">m2 populated</span>
        </div>
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
    </div>
  );
}
