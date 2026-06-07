import { useCallback, useMemo, useRef, useState, type ReactElement } from 'react';
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

/** Owner = the part of `owner/repo` before the first slash; bare names group under themselves. */
function ownerOf(name: string): string {
  const idx = name.indexOf('/');
  return idx === -1 ? name : name.slice(0, idx);
}

const RAIL_WIDTH_KEY = 'archon.console.railWidth';
const RAIL_MIN = 232;
const RAIL_MAX = 440;
const RAIL_DEFAULT = 280;

function readRailWidth(): number {
  try {
    const v = parseInt(localStorage.getItem(RAIL_WIDTH_KEY) ?? '', 10);
    return v >= RAIL_MIN && v <= RAIL_MAX ? v : RAIL_DEFAULT;
  } catch {
    return RAIL_DEFAULT;
  }
}

function writeRailWidth(w: number): void {
  try {
    localStorage.setItem(RAIL_WIDTH_KEY, String(w));
  } catch {
    /* ignore */
  }
}

/**
 * Left rail, design v2: header with count pill, filter input, projects
 * grouped by owner with hairline section labels, and a drag handle on the
 * right edge (232–440px, persisted).
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
  const [query, setQuery] = useState('');
  const [width, setWidth] = useState<number>(readRailWidth);
  const [resizing, setResizing] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;

  const { data: projects, error } = useEntity<Project[]>(K.projects, () => skill.listProjects());

  const allSelected = scope === 'all';

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = projects ?? [];
    if (q.length === 0) return list;
    return list.filter(p => `${p.name} ${p.path}`.toLowerCase().includes(q));
  }, [projects, query]);

  const groups = useMemo(() => {
    const out: { owner: string; items: Project[] }[] = [];
    const seen = new Map<string, { owner: string; items: Project[] }>();
    for (const p of filtered) {
      const owner = ownerOf(p.name);
      let g = seen.get(owner);
      if (g === undefined) {
        g = { owner, items: [] };
        seen.set(owner, g);
        out.push(g);
      }
      g.items.push(p);
    }
    return out;
  }, [filtered]);

  // Pointer-driven resize; width clamps to [RAIL_MIN, RAIL_MAX] and persists
  // on release. Pointer capture keeps the drag alive outside the handle.
  const startResize = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = widthRef.current;
    let latest = startW;
    setResizing(true);
    const move = (ev: PointerEvent): void => {
      latest = Math.max(RAIL_MIN, Math.min(RAIL_MAX, startW + (ev.clientX - startX)));
      setWidth(latest);
    };
    const up = (): void => {
      setResizing(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      writeRailWidth(latest);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, []);

  return (
    <nav
      aria-label="Projects"
      style={{ width, flexBasis: width }}
      className="relative flex h-full shrink-0 flex-col border-r border-border bg-surface-inset"
    >
      {/* Header: label + count + filter */}
      <div className="px-3.5 pb-2.5 pt-4">
        <div className="flex items-center gap-2 px-1 pb-3">
          <span className="font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-text-tertiary">
            Projects
          </span>
          <span className="rounded-full border border-border bg-surface-elevated px-2 py-px font-mono text-[10.5px] font-bold text-text-secondary">
            {(projects ?? []).length}
          </span>
        </div>
        <div
          className="flex h-[34px] items-center gap-2 rounded-[9px] border bg-surface px-2.5 text-text-tertiary transition-colors focus-within:text-text-secondary"
          style={{ borderColor: 'var(--border)' }}
        >
          <span aria-hidden className="font-mono text-[12px] leading-none">
            ⌕
          </span>
          <input
            value={query}
            onChange={e => {
              setQuery(e.target.value);
            }}
            placeholder="Filter projects…"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-text-primary outline-none placeholder:text-text-tertiary"
          />
          {query.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                setQuery('');
              }}
              title="Clear"
              aria-label="Clear filter"
              className="rounded p-0.5 text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-primary"
            >
              <span aria-hidden className="text-[11px] leading-none">
                ✕
              </span>
            </button>
          ) : null}
        </div>
      </div>

      {/* ALL scope */}
      <div className="px-2.5">
        <button
          type="button"
          onClick={() => {
            navigate('/console');
          }}
          title="All projects"
          aria-label="All projects"
          aria-pressed={allSelected}
          className={`relative flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-left text-[13px] font-medium transition-colors ${
            allSelected
              ? 'bg-surface-elevated text-text-primary'
              : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
          }`}
        >
          {allSelected ? (
            <span
              aria-hidden
              className="brand-bar pointer-events-none absolute -left-px bottom-[9px] top-[9px] w-[3px] rounded-r-[3px]"
            />
          ) : null}
          <span>All projects</span>
        </button>
      </div>

      {/* Grouped project list */}
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 pb-3 pt-1">
        {error !== undefined ? (
          <span
            title={error.message}
            className="mx-2 rounded border border-error/40 bg-error/10 px-2 py-1 font-mono text-[10px] text-error"
          >
            {error.message}
          </span>
        ) : null}
        {groups.map(g => (
          <div key={g.owner} className="mb-2">
            <div className="flex items-center gap-2 px-2 pb-1 pt-2">
              <span className="max-w-[70%] truncate font-mono text-[10.5px] font-semibold tracking-[0.05em] text-text-tertiary">
                {g.owner}
              </span>
              <span aria-hidden className="h-px flex-1 bg-border/60" />
            </div>
            {g.items.map(p => (
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
        ))}
        {groups.length === 0 && error === undefined ? (
          <div className="px-3 py-6 text-center text-[12.5px] text-text-tertiary">
            No projects match “{query}”.
          </div>
        ) : null}
      </div>

      {/* Add project */}
      <div className="border-t border-border p-3">
        <button
          type="button"
          onClick={onAddProject}
          title="Add project"
          aria-label="Add project"
          className="flex w-full items-center gap-2.5 rounded-[10px] border border-border bg-surface px-3 py-2.5 text-left text-[13px] font-semibold text-text-secondary transition-colors hover:border-accent-bright/50 hover:bg-surface-hover hover:text-text-primary"
        >
          <span aria-hidden="true" className="text-base leading-none text-accent-bright">
            +
          </span>
          <span>Add project</span>
        </button>
      </div>

      {/* Resize handle */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        title="Drag to resize"
        onPointerDown={startResize}
        className="group absolute -right-1 top-0 z-10 flex h-full w-[9px] cursor-col-resize items-center justify-center"
      >
        <span
          aria-hidden
          className={`w-[2px] rounded-sm transition-all ${
            resizing
              ? 'h-full bg-accent-bright'
              : 'h-9 bg-transparent group-hover:h-14 group-hover:bg-accent-bright/60'
          }`}
        />
      </div>

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
