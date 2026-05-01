import { cn } from '@/lib/utils';
import { relativeTime } from '@/lib/skill-utils';
import type { AgentSummary } from '@/lib/api';
import { Link2 } from 'lucide-react';

interface AgentRowProps {
  agent: AgentSummary;
  selected: boolean;
  onSelect: () => void;
}

const STATUS_DOT: Record<AgentSummary['status'], string> = {
  active: 'bg-bridges-success',
  draft: 'bg-bridges-warning',
  archived: 'bg-bridges-fg3',
};

const SOURCE_TINT: Record<AgentSummary['source'], { bg: string; fg: string; label: string }> = {
  global: { bg: 'bg-bridges-tag-sky-bg', fg: 'text-bridges-tag-sky-fg', label: 'Global' },
  project: { bg: 'bg-bridges-tag-mint-bg', fg: 'text-bridges-tag-mint-fg', label: 'Project' },
};

const STATUS_LABEL: Record<AgentSummary['status'], string> = {
  active: 'Active',
  draft: 'Draft',
  archived: 'Archived',
};

export function AgentRow({ agent, selected, onSelect }: AgentRowProps): React.ReactElement {
  const sourceTint = SOURCE_TINT[agent.source];
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
          className={cn(
            'inline-block h-[7px] w-[7px] shrink-0 rounded-full',
            STATUS_DOT[agent.status]
          )}
          aria-label={`status ${agent.status}`}
        />
        <span className="flex-1 truncate text-[13.5px] font-medium text-bridges-fg1">
          {agent.name}
        </span>
        {agent.parseError && (
          <span
            className="rounded bg-bridges-tint-danger-bg px-1.5 py-0.5 text-[10px] font-medium text-bridges-tint-danger-fg"
            title={agent.parseError}
          >
            error
          </span>
        )}
      </div>

      {agent.description && (
        <div className="mb-1.5 line-clamp-1 text-[12.5px] leading-snug text-bridges-fg2">
          {agent.description}
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
        <span className="inline-flex items-center rounded bg-bridges-surface-muted px-1.5 py-px text-[10.5px] font-medium leading-tight text-bridges-fg2">
          {STATUS_LABEL[agent.status]}
        </span>
        {agent.model && (
          <span className="inline-flex items-center rounded bg-bridges-surface-muted px-1.5 py-px font-mono text-[10.5px] font-medium leading-tight text-bridges-fg2">
            {agent.model}
          </span>
        )}
        {agent.skillCount > 0 && (
          <span className="font-mono text-[10.5px] text-bridges-fg3">
            {agent.skillCount} {agent.skillCount === 1 ? 'skill' : 'skills'}
          </span>
        )}
        {agent.toolCount > 0 && (
          <span className="font-mono text-[10.5px] text-bridges-fg3">
            {agent.toolCount} {agent.toolCount === 1 ? 'tool' : 'tools'}
          </span>
        )}
        {agent.isSymlink && (
          <span
            className="inline-flex items-center gap-1 rounded bg-bridges-tag-violet-bg px-1.5 py-px text-[10.5px] font-medium leading-tight text-bridges-tag-violet-fg"
            title={agent.realPath ?? 'symlink'}
          >
            <Link2 className="h-2.5 w-2.5" />
            link
          </span>
        )}
        <span className="ml-auto text-[10.5px] text-bridges-fg3">{relativeTime(agent.mtime)}</span>
      </div>
    </button>
  );
}
