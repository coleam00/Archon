import type { ReactElement } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ProjectTile } from './ProjectTile';
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
 * Thin always-visible left rail: ALL → every project → + Add project.
 * Every slot is aspect-square for a clean grid. Discord-style.
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
      className="flex h-full w-[68px] shrink-0 flex-col items-center gap-2 border-r border-border bg-surface-inset py-3"
    >
      {/* ALL scope pill — shares geometry with project tiles */}
      <button
        type="button"
        onClick={() => {
          navigate('/console');
        }}
        title="All projects"
        aria-label="All projects"
        aria-pressed={allSelected}
        className={`flex aspect-square w-11 items-center justify-center rounded-md border text-[10px] font-semibold uppercase tracking-[0.12em] leading-none transition-colors ${
          allSelected
            ? 'border-accent-bright/60 bg-surface-elevated text-accent-bright ring-2 ring-accent-bright ring-offset-[3px] ring-offset-surface-inset'
            : 'border-border bg-surface text-text-secondary hover:bg-surface-hover hover:text-text-primary'
        }`}
      >
        All
      </button>

      <div aria-hidden className="my-1 h-px w-10 bg-border/60" />

      {/* Project list — scrolls if tall */}
      <div className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto">
        {error !== undefined ? (
          <span
            title={error.message}
            className="rounded border border-error/40 bg-error/10 px-1 py-0.5 font-mono text-[9px] text-error"
          >
            err
          </span>
        ) : null}
        {(projects ?? []).map(p => (
          <ProjectTile
            key={p.id}
            projectId={p.id}
            name={p.name}
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

      {/* Add project — same geometry, dashed to signal "empty slot" */}
      <button
        type="button"
        onClick={onAddProject}
        title="Add project"
        aria-label="Add project"
        className="flex aspect-square w-11 items-center justify-center rounded-md border border-dashed border-border text-text-tertiary transition-colors hover:border-accent-bright/60 hover:bg-surface-hover hover:text-accent-bright"
      >
        <span aria-hidden="true" className="text-lg leading-none">
          +
        </span>
      </button>
    </nav>
  );
}
