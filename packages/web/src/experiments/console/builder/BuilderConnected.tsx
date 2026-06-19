/**
 * Connected workflow builder route (PR-3). Replaces the fixture-backed
 * `BuilderRoute`: it resolves a `:name` param + the selected project (`cwd`),
 * loads a real workflow via the `loadWorkflow` skill verb, renders the
 * controlled `BuilderPage`, and persists edits through `saveWorkflow` with full
 * create / rename / delete. Bundled workflows open read-only and Save-as writes
 * a project override.
 *
 * Nav guard: the app is a non-data `<BrowserRouter>`, so `useBlocker` is
 * unavailable (Spike #1). We use `beforeunload` (reload/close) plus a
 * `confirmIfDirty` wrapper around this header's OWN navigation controls. The
 * browser Back button and `ProjectRail` clicks are NOT intercepted — a known
 * limitation; a data-router migration is out of scope for PR-3.
 *
 * House rules: no `console.*`; all failures surface as `Issue[]` in the panel.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useNavigate, useParams, useLocation, useSearchParams } from 'react-router';
import { BuilderPage } from './BuilderPage';
import { fromWorkflowDefinition, toWorkflowDefinition } from './model';
import { runValidation } from './validation';
import { makeIssue } from './validation/make-issue';
import { useBuilderProject } from './connect/use-builder-project';
import {
  blockingErrors,
  isReadOnlySource,
  saveTargetFor,
  serverErrorToIssues,
  serverValidationToIssues,
  planRename,
  isValidWorkflowName,
} from './connect/save-logic';
import type { BuilderWorkflow, Issue, WireWorkflowDefinition } from './types';
import {
  loadWorkflow,
  saveWorkflow,
  deleteWorkflow,
  validateWorkflow,
  type LoadedWorkflow,
  type WorkflowSource,
} from '../skills/workflows';
import { listProjects, type WorkflowListResult } from '../skills';
import { listWorkflows } from '../skills/workflows';
import { useEntity, invalidate } from '../store/cache';
import { K } from '../store/keys';
import { HttpError } from '../lib/http';
import type { Project } from '../primitives/project';

/** Router navigation state carried into the connected route. */
interface BuilderNavState {
  /** A freshly-seeded workflow for create mode (no server load). */
  createSeed?: BuilderWorkflow;
  /** Non-fatal notices to seed the panel after a navigation (e.g. rename delete-failed). */
  notices?: Issue[];
}

const IDLE_LIST_KEY = 'workflows:idle';

/** Human-readable reason for a blocked rename. */
function renameReasonMessage(reason: 'collision' | 'invalid-name' | 'noop', to: string): string {
  switch (reason) {
    case 'collision':
      return `A workflow named "${to}" already exists in this project.`;
    case 'invalid-name':
      return `"${to}" is not a valid workflow name (no "/", "\\", "..", leading dot, or empty).`;
    case 'noop':
      return 'The new name is the same as the current one.';
  }
}

/** Map a thrown error to panel issues: HttpError → server detail, else a fallback. */
function errorToIssues(e: unknown, rule: string, fallback: string): Issue[] {
  if (e instanceof HttpError) return serverErrorToIssues(e);
  return [
    makeIssue({
      rule,
      severity: 'error',
      source: 'server',
      message: e instanceof Error ? e.message : fallback,
      path: {},
    }),
  ];
}

function EmptyState({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center text-[12.5px] text-text-tertiary">
      <div className="max-w-md">{children}</div>
    </div>
  );
}

export function BuilderConnected(): ReactElement {
  const { name } = useParams<{ name?: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { projectId, setProjectId } = useBuilderProject();

  const navState = location.state as BuilderNavState | null;
  const createSeed =
    navState?.createSeed !== undefined && navState.createSeed.name === name
      ? navState.createSeed
      : undefined;
  const isCreateMode = createSeed !== undefined && name !== undefined;

  const projectsView = useEntity<Project[]>(K.projects, () => listProjects());
  const projects = projectsView.data ?? [];
  const selectedProject = projects.find(p => p.id === projectId);
  const cwd = selectedProject?.path;

  // Keep `?project=` in sync with the selected project so a deep-link reload
  // restores the cwd. Guarded to only write when it actually differs (no loop).
  useEffect(() => {
    if (projectId !== undefined && searchParams.get('project') !== projectId) {
      const next = new URLSearchParams(searchParams);
      next.set('project', projectId);
      setSearchParams(next, { replace: true });
    }
  }, [projectId, searchParams, setSearchParams]);

  // Workflow list for the open-picker + rename collision checks.
  const listKey = cwd !== undefined ? K.workflows(cwd) : IDLE_LIST_KEY;
  const listView = useEntity<WorkflowListResult>(listKey, () =>
    cwd !== undefined ? listWorkflows(cwd) : Promise.resolve({ workflows: [], recommended: [] })
  );
  const existingNames = useMemo(
    () => (listView.data?.workflows ?? []).map(w => w.name),
    [listView.data]
  );

  // Single-workflow load (skipped in create mode — the seed is authoritative).
  const idle = name === undefined || cwd === undefined || isCreateMode;
  const loadKey =
    idle || cwd === undefined || name === undefined ? 'builder:idle' : K.workflow(cwd, name);
  const loadView = useEntity<LoadedWorkflow | null>(loadKey, () =>
    idle || cwd === undefined || name === undefined
      ? Promise.resolve<LoadedWorkflow | null>(null)
      : loadWorkflow(name, cwd)
  );

  // Resolve the workflow under edit (seed in create mode, else the server load).
  // Memoized on stable inputs (location-state seed, cache object) so it does NOT
  // produce a fresh identity every render — that would thrash the reset effect.
  const loadedSource: WorkflowSource = isCreateMode
    ? 'project'
    : (loadView.data?.source ?? 'project');

  const imported = useMemo<{ workflow: BuilderWorkflow; issues: Issue[] } | null>(() => {
    if (isCreateMode && createSeed !== undefined) return { workflow: createSeed, issues: [] };
    if (loadView.data?.definition !== undefined) {
      return fromWorkflowDefinition(loadView.data.definition);
    }
    return null;
  }, [isCreateMode, createSeed, loadView.data]);

  // Editing state — reset whenever the imported workflow changes (workflow switch).
  const [currentWorkflow, setCurrentWorkflow] = useState<BuilderWorkflow | null>(null);
  const [dirty, setDirty] = useState(false);
  const [serverIssues, setServerIssues] = useState<Issue[]>([]);
  // Source can flip after a bundled Save-as (bundled → project override).
  const [sourceOverride, setSourceOverride] = useState<WorkflowSource | null>(null);
  const [busy, setBusy] = useState(false);

  const effectiveSource = sourceOverride ?? loadedSource;
  const readOnly = isReadOnlySource(effectiveSource);

  // Initialize editing state ONCE per editor identity (cwd + name + mode), not on
  // every `imported` identity change. A successful Save invalidates the workflow
  // cache, which re-runs the loader and yields a fresh `imported` for the SAME
  // workflow; resetting on that refetch would clobber live edits and silently
  // clear `dirty` in the window between Save resolving and the refetch landing.
  // BuilderPage is keyed by the same identity, so it remounts in lockstep.
  const editorKey = `${cwd ?? ''}:${name ?? ''}:${String(isCreateMode)}`;
  const initedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (imported === null) {
      // No workflow open (picker view, or still loading) — return to a clean
      // closed state so the dirty flag / beforeunload guard don't linger.
      initedKeyRef.current = null;
      setCurrentWorkflow(null);
      setDirty(false);
      setSourceOverride(null);
      return;
    }
    if (initedKeyRef.current === editorKey) return; // same workflow refetched — keep edits
    initedKeyRef.current = editorKey;
    setCurrentWorkflow(imported.workflow);
    setDirty(isCreateMode);
    setSourceOverride(null);
    setServerIssues(navState?.notices ?? []);
  }, [imported, editorKey, isCreateMode, navState?.notices]);

  // beforeunload guard (reload/tab-close) — armed only while dirty.
  useEffect(() => {
    if (!dirty) return undefined;
    const handler = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return (): void => {
      window.removeEventListener('beforeunload', handler);
    };
  }, [dirty]);

  const confirmIfDirty = useCallback(
    (action: () => void): void => {
      if (dirty && !window.confirm('You have unsaved changes. Discard them?')) return;
      action();
    },
    [dirty]
  );

  const handleChange = useCallback((bw: BuilderWorkflow): void => {
    setCurrentWorkflow(bw);
    setDirty(true);
  }, []);

  const extraIssues = useMemo(
    () => [...(imported?.issues ?? []), ...serverIssues],
    [imported, serverIssues]
  );

  const pid = projectId ?? '';
  const projectQuery = `?project=${encodeURIComponent(pid)}`;

  // --- Save ----------------------------------------------------------------
  const doSave = useCallback(async (): Promise<void> => {
    if (currentWorkflow === null || cwd === undefined || name === undefined) return;
    // Force the in-YAML name to match the route name so filename and `name:` stay in sync.
    const definition: WireWorkflowDefinition = { ...toWorkflowDefinition(currentWorkflow), name };

    const blocking = blockingErrors(runValidation(currentWorkflow));
    if (blocking.length > 0) {
      setServerIssues([
        makeIssue({
          rule: 'save.blocked',
          severity: 'error',
          source: 'client-instant',
          message: `Cannot save: fix ${String(blocking.length)} blocking error(s) first.`,
          path: {},
        }),
      ]);
      return;
    }

    setBusy(true);
    try {
      const validation = await validateWorkflow(definition);
      if (!validation.valid) {
        setServerIssues(serverValidationToIssues(validation.errors ?? []));
        return;
      }
      const saved = await saveWorkflow(name, definition, {
        cwd,
        source: saveTargetFor(effectiveSource),
      });
      setServerIssues([]);
      setDirty(false);
      setSourceOverride(saved.source);
      invalidate(K.workflows(cwd));
      invalidate(K.workflow(cwd, name));
      // A just-created workflow now exists on disk — drop the create-mode seed
      // from the route so it reloads as a normal project workflow (enabling
      // Rename/Delete). `replace` keeps history clean.
      if (isCreateMode) {
        navigate(`/console/builder/${encodeURIComponent(name)}${projectQuery}`, { replace: true });
      }
    } catch (e) {
      setServerIssues(errorToIssues(e, 'save.failed', 'Save failed (unknown error).'));
    } finally {
      setBusy(false);
    }
  }, [currentWorkflow, cwd, name, effectiveSource, isCreateMode, navigate, projectQuery]);

  // --- Delete --------------------------------------------------------------
  const doDelete = useCallback(async (): Promise<void> => {
    if (name === undefined || cwd === undefined) return;
    if (!window.confirm(`Delete workflow "${name}"? This removes the YAML file.`)) return;
    setBusy(true);
    try {
      await deleteWorkflow(name, { cwd, source: saveTargetFor(effectiveSource) });
      invalidate(K.workflows(cwd));
      invalidate(K.workflow(cwd, name));
      navigate(`/console/builder${projectQuery}`);
    } catch (e) {
      setServerIssues(errorToIssues(e, 'delete.failed', 'Delete failed (unknown error).'));
      setBusy(false);
    }
  }, [name, cwd, effectiveSource, navigate, projectQuery]);

  // --- Rename --------------------------------------------------------------
  const doRename = useCallback(async (): Promise<void> => {
    if (name === undefined || cwd === undefined || currentWorkflow === null) return;
    const raw = window.prompt('Rename workflow to:', name);
    if (raw === null) return;
    const to = raw.trim();
    const plan = planRename({ from: name, to, existingNames });
    if (!plan.ok) {
      setServerIssues([
        makeIssue({
          rule: 'rename.blocked',
          severity: 'error',
          source: 'client-instant',
          message: renameReasonMessage(plan.reason, to),
          path: {},
        }),
      ]);
      return;
    }

    setBusy(true);
    try {
      const definition: WireWorkflowDefinition = {
        ...toWorkflowDefinition(currentWorkflow),
        name: to,
      };
      const validation = await validateWorkflow(definition);
      if (!validation.valid) {
        setServerIssues(serverValidationToIssues(validation.errors ?? []));
        return;
      }
      // New-then-old: the new file is authoritative even if the old delete fails.
      await saveWorkflow(to, definition, { cwd, source: saveTargetFor(effectiveSource) });
      let notices: Issue[] = [];
      try {
        await deleteWorkflow(name, { cwd, source: saveTargetFor(effectiveSource) });
      } catch (delErr) {
        const detail = delErr instanceof Error ? delErr.message : String(delErr);
        notices = [
          makeIssue({
            rule: 'rename.delete.failed',
            severity: 'warning',
            source: 'server',
            message: `Renamed to "${to}", but removing the old file "${name}" failed (${detail}). Delete it manually.`,
            path: {},
          }),
        ];
      }
      invalidate(K.workflows(cwd));
      invalidate(K.workflow(cwd, name));
      invalidate(K.workflow(cwd, to));
      setDirty(false);
      navigate(`/console/builder/${encodeURIComponent(to)}${projectQuery}`, {
        state: notices.length > 0 ? ({ notices } satisfies BuilderNavState) : undefined,
      });
    } catch (e) {
      setServerIssues(errorToIssues(e, 'rename.failed', 'Rename failed (unknown error).'));
    } finally {
      setBusy(false);
    }
  }, [name, cwd, currentWorkflow, existingNames, effectiveSource, navigate, projectQuery]);

  // --- New -----------------------------------------------------------------
  const doNew = useCallback((): void => {
    if (cwd === undefined) return;
    const raw = window.prompt('New workflow name:', '');
    if (raw === null) return;
    const nm = raw.trim();
    if (!isValidWorkflowName(nm)) {
      setServerIssues([
        makeIssue({
          rule: 'new.invalid-name',
          severity: 'error',
          source: 'client-instant',
          message: renameReasonMessage('invalid-name', nm),
          path: {},
        }),
      ]);
      return;
    }
    if (existingNames.includes(nm)) {
      setServerIssues([
        makeIssue({
          rule: 'new.collision',
          severity: 'error',
          source: 'client-instant',
          message: renameReasonMessage('collision', nm),
          path: {},
        }),
      ]);
      return;
    }
    const seed: BuilderWorkflow = {
      name: nm,
      description: 'New workflow.',
      meta: {},
      nodes: [
        {
          id: 'step-1',
          variant: 'prompt',
          base: {},
          data: { prompt: 'Describe what this step should do.' },
        },
      ],
    };
    navigate(`/console/builder/${encodeURIComponent(nm)}${projectQuery}`, {
      state: { createSeed: seed } satisfies BuilderNavState,
    });
  }, [cwd, existingNames, navigate, projectQuery]);

  // --- Navigation controls (dirty-guarded) ---------------------------------
  const onPickProject = useCallback(
    (id: string): void => {
      confirmIfDirty(() => {
        setProjectId(id);
        navigate(`/console/builder?project=${encodeURIComponent(id)}`);
      });
    },
    [confirmIfDirty, setProjectId, navigate]
  );

  const onOpenWorkflow = useCallback(
    (wf: string): void => {
      if (wf === '' || wf === name) return;
      confirmIfDirty(() => {
        navigate(`/console/builder/${encodeURIComponent(wf)}${projectQuery}`);
      });
    },
    [confirmIfDirty, navigate, projectQuery, name]
  );

  // Ensure the currently-open name is selectable even if not in the list (e.g. a
  // bundled workflow opened by direct GET that the list also surfaces, or a
  // subfoldered one). Dedupe.
  const openOptions = useMemo(() => {
    const names = new Set(existingNames);
    if (name !== undefined) names.add(name);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [existingNames, name]);

  const saveLabel = readOnly ? 'Save as' : 'Save';
  const canSave = !busy && (readOnly || dirty || isCreateMode);
  const workflowOpen = name !== undefined && imported !== null;
  const notFound = name !== undefined && !isCreateMode && loadView.error !== undefined;
  // Surface list-load failures instead of masking them as empty states — a
  // transient backend error otherwise reads as "no projects / no workflows".
  const listFetchError = projectsView.error ?? listView.error;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2">
        <h1 className="text-[14px] font-semibold text-text-primary">Workflow Builder</h1>
        <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-text-tertiary">
          beta
        </span>

        <label className="flex items-center gap-2 text-[11.5px] text-text-tertiary">
          Project
          <select
            value={projectId ?? ''}
            onChange={(e): void => {
              onPickProject(e.target.value);
            }}
            className="max-w-[220px] rounded-[8px] border border-border bg-surface px-2 py-1 font-mono text-[12px] text-text-primary outline-none focus:border-accent-bright/60"
          >
            <option value="">Select a project…</option>
            {projects.map(p => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        {cwd !== undefined ? (
          <label className="flex items-center gap-2 text-[11.5px] text-text-tertiary">
            Workflow
            <select
              value={name ?? ''}
              onChange={(e): void => {
                onOpenWorkflow(e.target.value);
              }}
              className="max-w-[220px] rounded-[8px] border border-border bg-surface px-2 py-1 font-mono text-[12px] text-text-primary outline-none focus:border-accent-bright/60"
            >
              <option value="">Open a workflow…</option>
              {openOptions.map(n => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {cwd !== undefined ? (
          <button
            type="button"
            onClick={(): void => {
              confirmIfDirty(doNew);
            }}
            className="rounded-[8px] border border-border bg-surface px-2.5 py-1 text-[12px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
          >
            New
          </button>
        ) : null}

        <div className="flex-1" />

        {workflowOpen ? (
          <div className="flex items-center gap-2">
            {dirty ? (
              <span
                title="Unsaved changes"
                aria-label="Unsaved changes"
                className="h-2 w-2 rounded-full bg-warning"
              />
            ) : null}
            <button
              type="button"
              disabled={!canSave}
              onClick={(): void => {
                void doSave();
              }}
              className="rounded-[8px] bg-accent-bright px-3 py-1 text-[12px] font-semibold text-white/95 transition-opacity hover:brightness-110 disabled:pointer-events-none disabled:opacity-40"
            >
              {saveLabel}
            </button>
            {!isCreateMode ? (
              <button
                type="button"
                disabled={busy}
                onClick={(): void => {
                  void doRename();
                }}
                className="rounded-[8px] border border-border bg-surface px-2.5 py-1 text-[12px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:opacity-40"
              >
                Rename
              </button>
            ) : null}
            {!readOnly && !isCreateMode ? (
              <button
                type="button"
                disabled={busy}
                onClick={(): void => {
                  void doDelete();
                }}
                className="rounded-[8px] px-2.5 py-1 text-[12px] text-error transition-colors hover:bg-error/10 disabled:opacity-40"
              >
                Delete
              </button>
            ) : null}
          </div>
        ) : null}
      </header>

      {listFetchError !== undefined ? (
        <div
          title={listFetchError.message}
          className="border-b border-error/30 bg-error/10 px-4 py-1.5 font-mono text-[11px] text-error"
        >
          Failed to load: {listFetchError.message}
        </div>
      ) : null}

      {workflowOpen && readOnly ? (
        <div className="border-b border-border bg-warning/10 px-4 py-1.5 text-[11.5px] text-text-secondary">
          Bundled workflow — read-only. <span className="font-semibold">Save as</span> writes a
          project override that shadows the bundled default.
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        {selectedProject === undefined ? (
          <EmptyState>
            Select a project to load its workflows. Workflows are discovered and saved per project
            (the project's <span className="font-mono">cwd</span>).
          </EmptyState>
        ) : notFound ? (
          <EmptyState>
            <p>
              No workflow named <span className="font-mono">{name}</span> was found in{' '}
              <span className="font-mono">{selectedProject.name}</span>.
            </p>
            <p className="mt-2">
              It may live in a subfolder (not loadable via the single-name route) or not exist yet.
            </p>
            <button
              type="button"
              onClick={(): void => {
                confirmIfDirty(doNew);
              }}
              className="mt-3 rounded-[8px] border border-border bg-surface px-2.5 py-1 text-[12px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
            >
              Create a new workflow
            </button>
          </EmptyState>
        ) : name === undefined ? (
          existingNames.length === 0 ? (
            <EmptyState>
              <p>
                <span className="font-mono">{selectedProject.name}</span> has no project workflows
                yet.
              </p>
              <button
                type="button"
                onClick={doNew}
                className="mt-3 rounded-[8px] border border-border bg-surface px-2.5 py-1 text-[12px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
              >
                Create the first workflow
              </button>
            </EmptyState>
          ) : (
            <EmptyState>
              Pick a workflow from the <span className="font-semibold">Workflow</span> menu above to
              start editing, or create a new one.
            </EmptyState>
          )
        ) : imported !== null && currentWorkflow !== null ? (
          <BuilderPage
            key={`${cwd ?? ''}:${name}:${String(isCreateMode)}`}
            initialWorkflow={imported.workflow}
            onChange={handleChange}
            extraIssues={extraIssues}
          />
        ) : (
          <EmptyState>Loading workflow…</EmptyState>
        )}
      </div>
    </div>
  );
}
