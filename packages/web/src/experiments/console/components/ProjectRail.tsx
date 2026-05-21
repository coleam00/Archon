import type { ReactElement } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ProjectRow } from './ProjectRow';
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

/**
 * Left rail: ALL scope · project list (title + locator) · add slot.
 * Title is editable per-project; right-click any row to remove.
 */
export function ProjectRail({ onAddProject }: ProjectRailProps): ReactElement {
  const navigate = useNavigate();
  const { projectId } = useParams<{ projectId?: string }>();
  const scope = projectId ?? 'all';

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
        className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] font-medium transition-colors ${
          allSelected
            ? 'brand-bar-soft text-text-primary'
            : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
        }`}
      >
        <span
          aria-hidden
          className={`h-2 w-2 shrink-0 rounded-full ${
            allSelected ? 'bg-accent-bright' : 'bg-text-tertiary/40'
          }`}
        />
        <span className="uppercase tracking-[0.12em] text-[11px]">All projects</span>
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
        className="flex items-center gap-2.5 rounded-md border border-dashed border-border px-2.5 py-1.5 text-left text-text-tertiary transition-colors hover:border-accent-bright/60 hover:bg-surface-hover hover:text-accent-bright"
      >
        <span aria-hidden="true" className="text-base leading-none">
          +
        </span>
        <span className="text-[13px]">Add project</span>
      </button>
    </nav>
  );
}
