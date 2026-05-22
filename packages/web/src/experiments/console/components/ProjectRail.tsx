import { useState, type ReactElement } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { ProjectRow } from './ProjectRow';
import { EnvVarsDialog } from './EnvVarsDialog';
import { useEntity, invalidate } from '../store/cache';
import { K } from '../store/keys';
import * as skill from '../skills';
import type { Project } from '../primitives/project';

interface ProjectRailProps {
  onAddProject: () => void;
}

async function handleRemove(projectId: string): Promise<void> {
  await skill.removeProject(projectId);
  invalidate(K.projects);
}

/** Extract the project id from /console/p/:id (and /console/p/:id/r/:runId). */
function extractProjectId(pathname: string): string | null {
  const m = /^\/console\/p\/([^/]+)/.exec(pathname);
  return m === null ? null : m[1];
}

/**
 * Left rail: ALL scope · project list · add slot.
 *
 * Note: ProjectRail mounts outside the inner `<Routes>` (sibling to the
 * <main> that hosts them), so `useParams()` returns `{}` here even on a
 * project URL. We extract the project id from the pathname directly.
 */
export function ProjectRail({ onAddProject }: ProjectRailProps): ReactElement {
  const navigate = useNavigate();
  const location = useLocation();
  const scope = extractProjectId(location.pathname) ?? 'all';
  const [envProject, setEnvProject] = useState<Project | null>(null);

  const { data: projects, error } = useEntity<Project[]>(K.projects, () => skill.listProjects());

  const allSelected = scope === 'all';

  return (
    <nav
      aria-label="Projects"
      className="flex h-full w-[240px] shrink-0 flex-col gap-1 border-r border-border bg-surface-inset p-2"
    >
      {/* ALL scope */}
      <button
        type="button"
        onClick={() => {
          navigate('/console');
        }}
        title="All projects"
        aria-label="All projects"
        aria-pressed={allSelected}
        className={`relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] font-medium transition-colors ${
          allSelected
            ? 'bg-surface-elevated text-text-primary'
            : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
        }`}
      >
        {allSelected ? (
          <span
            aria-hidden
            className="brand-bar pointer-events-none absolute left-0 top-0 bottom-0 w-1 rounded-l-md"
          />
        ) : null}
        <span>All projects</span>
      </button>

      <div aria-hidden className="my-1 h-px w-full bg-border/60" />

      {/* Project list */}
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        {error !== undefined ? (
          <span
            title={error.message}
            className="mx-2 rounded border border-error/40 bg-error/10 px-2 py-1 font-mono text-[10px] text-error"
          >
            {error.message}
          </span>
        ) : null}
        {(projects ?? []).map(p => (
          <ProjectRow
            key={p.id}
            project={p}
            selected={scope === p.id}
            onClick={() => {
              navigate(`/console/p/${p.id}`);
            }}
            onRemove={() => {
              void handleRemove(p.id);
              if (scope === p.id) navigate('/console');
            }}
            onEditEnv={() => {
              setEnvProject(p);
            }}
          />
        ))}
      </div>

      <div aria-hidden className="my-1 h-px w-full bg-border/60" />

      {/* Add project */}
      <button
        type="button"
        onClick={onAddProject}
        title="Add project"
        aria-label="Add project"
        className="flex items-center gap-2.5 rounded-md border border-dashed border-border px-2.5 py-1.5 text-left text-text-tertiary transition-colors hover:border-border-bright hover:bg-surface-hover hover:text-text-primary"
      >
        <span aria-hidden="true" className="text-base leading-none">
          +
        </span>
        <span className="text-[13px]">Add project</span>
      </button>

      <EnvVarsDialog
        projectId={envProject?.id ?? ''}
        projectName={envProject?.name ?? ''}
        open={envProject !== null}
        onClose={() => {
          setEnvProject(null);
        }}
      />
    </nav>
  );
}
