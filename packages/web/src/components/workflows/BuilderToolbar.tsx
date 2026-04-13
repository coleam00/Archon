import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { listWorkflows } from '@/lib/api';
import { useProject } from '@/contexts/ProjectContext';

export type ViewMode = 'hidden' | 'split' | 'full';

export interface BuilderToolbarProps {
  workflowName: string;
  workflowDescription: string;
  provider: 'claude' | 'codex' | undefined;
  model: string | undefined;
  hasUnsavedChanges: boolean;
  validationErrors: string[];
  viewMode: ViewMode;
  onNameChange: (name: string) => void;
  onDescriptionChange: (desc: string) => void;
  onProviderChange: (p: 'claude' | 'codex' | undefined) => void;
  onModelChange: (m: string | undefined) => void;
  onViewModeChange: (mode: ViewMode) => void;
  onValidate: () => void;
  onSave: () => void;
  onRun: () => void;
  onLoadWorkflow: (name: string) => void;
}

const VIEW_MODE_LABELS: readonly { value: ViewMode; label: string }[] = [
  { value: 'hidden', label: 'Visual' },
  { value: 'split', label: 'Split' },
  { value: 'full', label: 'YAML' },
];

export function BuilderToolbar({
  workflowName,
  workflowDescription,
  provider,
  model,
  hasUnsavedChanges,
  validationErrors,
  viewMode,
  onNameChange,
  onDescriptionChange,
  onProviderChange,
  onModelChange,
  onViewModeChange,
  onValidate,
  onSave,
  onRun,
  onLoadWorkflow,
}: BuilderToolbarProps): React.ReactElement {
  const navigate = useNavigate();
  const { codebases, selectedProjectId } = useProject();
  const cwd = selectedProjectId
    ? codebases?.find(cb => cb.id === selectedProjectId)?.default_cwd
    : undefined;

  const [showDescription, setShowDescription] = useState(false);

  // Scroll indicator state
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollRight, setCanScrollRight] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const check = (): void => {
      setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
    };

    check();
    el.addEventListener('scroll', check);
    window.addEventListener('resize', check);
    return (): void => {
      el.removeEventListener('scroll', check);
      window.removeEventListener('resize', check);
    };
  }, []);

  const { data: workflows, isError: workflowsError } = useQuery({
    queryKey: ['workflows', cwd],
    queryFn: () => listWorkflows(cwd),
  });

  return (
    <>
      {/*
       * overflow-x-auto: on mobile, the toolbar scrolls horizontally instead of
       * clipping the right-side controls (Provider, Model, Visual/Split/YAML, etc.)
       * All child groups have shrink-0 to prevent squishing.
       */}
      <div className="relative">
        <div
          ref={scrollRef}
          className="flex items-center h-12 px-3 border-b border-border gap-2 overflow-x-auto"
        >
          {/* Left group: Load + Breadcrumb + Mode badge */}
          <div className="flex items-center gap-2 min-w-0 shrink-0">
            {/* Load existing workflow */}
            <select
              value=""
              onChange={(e): void => {
                if (e.target.value) onLoadWorkflow(e.target.value);
              }}
              className="rounded-md border border-border bg-surface px-1.5 py-1 text-xs text-text-secondary focus:outline-none focus:ring-1 focus:ring-accent w-[72px] shrink-0"
              title={
                workflowsError
                  ? 'Failed to load workflows — check server connection'
                  : 'Load workflow'
              }
            >
              <option value="">{workflowsError ? 'Load failed' : 'Load...'}</option>
              {(workflows ?? []).map(entry => (
                <option key={entry.workflow.name} value={entry.workflow.name}>
                  {entry.workflow.name}
                </option>
              ))}
            </select>

            {/* Breadcrumb */}
            <div className="flex items-center gap-1 min-w-0">
              <button
                type="button"
                onClick={(): void => {
                  navigate('/workflows');
                }}
                className="text-xs text-text-tertiary hover:text-text-secondary shrink-0"
              >
                Workflows
              </button>
              <span className="text-xs text-text-tertiary shrink-0">/</span>
              <input
                type="text"
                value={workflowName}
                onChange={(e): void => {
                  onNameChange(e.target.value);
                }}
                placeholder="workflow-name"
                className="min-w-[80px] max-w-[160px] rounded-md border border-transparent hover:border-border focus:border-border bg-transparent px-1.5 py-0.5 text-xs font-medium text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
              />
              {hasUnsavedChanges && (
                <span
                  className="w-1.5 h-1.5 rounded-full bg-warning shrink-0"
                  title="Unsaved changes"
                />
              )}
            </div>

            {/* Description (click to expand) */}
            {showDescription ? (
              <input
                type="text"
                value={workflowDescription}
                onChange={(e): void => {
                  onDescriptionChange(e.target.value);
                }}
                onBlur={(): void => {
                  setShowDescription(false);
                }}
                autoFocus
                placeholder="Description..."
                className="w-48 rounded-md border border-border bg-surface px-2 py-0.5 text-xs text-text-secondary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
              />
            ) : (
              <button
                type="button"
                onClick={(): void => {
                  setShowDescription(true);
                }}
                className="text-[10px] text-text-tertiary hover:text-text-secondary truncate max-w-[120px] shrink-0"
                title={workflowDescription || 'Add description'}
              >
                {workflowDescription || 'add description'}
              </button>
            )}

            {/* Mode badge */}
            <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider shrink-0 bg-node-command/20 text-node-command">
              DAG
            </span>
          </div>

          {/* Center group: Provider + Model */}
          <div className="flex items-center gap-1.5 mx-auto shrink-0">
            <select
              value={provider ?? ''}
              onChange={(e): void => {
                onProviderChange((e.target.value || undefined) as 'claude' | 'codex' | undefined);
              }}
              className="rounded-md border border-border bg-surface px-1.5 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
            >
              <option value="">Provider</option>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>

            <input
              type="text"
              value={model ?? ''}
              onChange={(e): void => {
                onModelChange(e.target.value || undefined);
              }}
              placeholder="Model"
              className="w-20 rounded-md border border-border bg-surface px-1.5 py-1 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>

          {/* Right group: View toggle + Actions */}
          <div className="flex items-center gap-1.5 shrink-0">
            {/* View toggle — flex-nowrap prevents wrapping; scrollable via parent overflow-x-auto */}
            <div className="flex rounded-md border border-border overflow-hidden">
              {VIEW_MODE_LABELS.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  onClick={(): void => {
                    onViewModeChange(value);
                  }}
                  className={cn(
                    'px-2 py-1 text-[10px] font-medium transition-colors whitespace-nowrap',
                    viewMode === value
                      ? 'bg-accent text-accent-foreground'
                      : 'bg-surface text-text-secondary hover:text-text-primary hover:bg-surface-hover'
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Validation errors badge */}
            {validationErrors.length > 0 && (
              <span className="rounded-full bg-error/20 text-error px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap">
                {validationErrors.length}
              </span>
            )}

            <Button variant="outline" size="xs" onClick={onValidate}>
              Val
            </Button>

            <Button variant="secondary" size="xs" onClick={onSave} disabled={!workflowName.trim()}>
              Save
            </Button>

            <Button
              size="xs"
              onClick={onRun}
              disabled={!workflowName.trim() || hasUnsavedChanges}
              title={hasUnsavedChanges ? 'Save the workflow before running' : undefined}
              className="bg-node-command hover:bg-node-command/90 text-white"
            >
              Run
            </Button>
          </div>
        </div>

        {/* Horizontal scroll indicator: fade gradient + chevron */}
        {canScrollRight && (
          <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-1 w-8 bg-gradient-to-l from-background to-transparent">
            <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
          </div>
        )}
      </div>

      {workflowsError && (
        <div className="px-4 py-1.5 text-xs text-error bg-surface-inset border-b border-border">
          Failed to load workflow list. The load dropdown may be empty.
        </div>
      )}
    </>
  );
}
