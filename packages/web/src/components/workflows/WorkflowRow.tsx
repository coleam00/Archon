import { cn } from '@/lib/utils';
import type { WorkflowListEntry, WorkflowSource } from '@/lib/api';

interface WorkflowRowProps {
  entry: WorkflowListEntry;
  selected: boolean;
  onSelect: () => void;
}

const SOURCE_DOT: Record<WorkflowSource, string> = {
  bundled: 'bg-bridges-fg3',
  global: 'bg-bridges-tag-sky-fg',
  project: 'bg-bridges-tag-mint-fg',
};

const SOURCE_TINT: Record<WorkflowSource, { bg: string; fg: string; label: string }> = {
  bundled: { bg: 'bg-bridges-surface-muted', fg: 'text-bridges-fg2', label: 'Bundled' },
  global: { bg: 'bg-bridges-tag-sky-bg', fg: 'text-bridges-tag-sky-fg', label: 'Global' },
  project: { bg: 'bg-bridges-tag-mint-bg', fg: 'text-bridges-tag-mint-fg', label: 'Project' },
};

export function WorkflowRow({ entry, selected, onSelect }: WorkflowRowProps): React.ReactElement {
  const { workflow, source } = entry;
  const sourceTint = SOURCE_TINT[source];
  const stepCount = workflow.nodes.length;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'block w-full cursor-pointer select-none border-b border-bridges-border-subtle px-4 py-3 text-left transition-colors',
        selected
          ? 'border-l-2 border-l-bridges-action bg-bridges-surface-subtle pl-[14px]'
          : 'border-l-2 border-l-transparent hover:bg-bridges-surface-subtle'
      )}
    >
      <div className="mb-1 flex items-center gap-2">
        <span
          className={cn('inline-block h-[7px] w-[7px] shrink-0 rounded-full', SOURCE_DOT[source])}
        />
        <span className="flex-1 truncate text-[13.5px] font-medium text-bridges-fg1">
          {workflow.name}
        </span>
      </div>

      {workflow.description && (
        <div className="mb-1.5 line-clamp-1 text-[12.5px] leading-snug text-bridges-fg2">
          {workflow.description}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={cn(
            'inline-flex items-center rounded px-1.5 py-px text-[10.5px] font-medium leading-tight',
            sourceTint.bg,
            sourceTint.fg
          )}
        >
          {sourceTint.label}
        </span>
        <span className="inline-flex items-center rounded bg-bridges-surface-muted px-1.5 py-px font-mono text-[10.5px] font-medium leading-tight text-bridges-fg2">
          {stepCount} {stepCount === 1 ? 'step' : 'steps'}
        </span>
        {workflow.interactive && (
          <span className="inline-flex items-center rounded bg-bridges-tint-info-bg px-1.5 py-px text-[10.5px] font-medium leading-tight text-bridges-tint-info-fg">
            interactive
          </span>
        )}
        {(workflow.tags ?? []).slice(0, 2).map(tag => (
          <span
            key={tag}
            className="inline-flex items-center rounded bg-bridges-surface-muted px-1.5 py-px text-[10.5px] leading-tight text-bridges-fg3"
          >
            {tag}
          </span>
        ))}
      </div>
    </button>
  );
}
