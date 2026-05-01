import { cn } from '@/lib/utils';
import { relativeTime } from '@/lib/skill-utils';
import type { SkillSummary } from '@/lib/api';
import { Link2 } from 'lucide-react';

interface SkillRowProps {
  skill: SkillSummary;
  selected: boolean;
  onSelect: () => void;
}

const SOURCE_TINT: Record<SkillSummary['source'], { bg: string; fg: string; label: string }> = {
  global: { bg: 'bg-bridges-tag-sky-bg', fg: 'text-bridges-tag-sky-fg', label: 'Global' },
  project: { bg: 'bg-bridges-tag-mint-bg', fg: 'text-bridges-tag-mint-fg', label: 'Project' },
};

export function SkillRow({ skill, selected, onSelect }: SkillRowProps): React.ReactElement {
  const sourceTint = SOURCE_TINT[skill.source];
  const fileCount =
    (skill.hasScripts ? 1 : 0) + (skill.hasReferences ? 1 : 0) + (skill.hasAssets ? 1 : 0);

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
            skill.source === 'project' ? 'bg-bridges-success' : 'bg-bridges-open'
          )}
          aria-label={`source ${skill.source}`}
        />
        <span className="flex-1 truncate text-[13.5px] font-medium text-bridges-fg1">
          {skill.name}
        </span>
        {skill.parseError && (
          <span
            className="rounded bg-bridges-tint-danger-bg px-1.5 py-0.5 text-[10px] font-medium text-bridges-tint-danger-fg"
            title={skill.parseError}
          >
            error
          </span>
        )}
      </div>

      {skill.description && (
        <div className="mb-1.5 line-clamp-1 text-[12.5px] leading-snug text-bridges-fg2">
          {skill.description}
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
        {skill.prefix && (
          <span className="inline-flex items-center rounded bg-bridges-surface-muted px-1.5 py-px font-mono text-[10.5px] font-medium leading-tight text-bridges-fg2">
            {skill.prefix}
          </span>
        )}
        {skill.isSymlink && (
          <span
            className="inline-flex items-center gap-1 rounded bg-bridges-tag-violet-bg px-1.5 py-px text-[10.5px] font-medium leading-tight text-bridges-tag-violet-fg"
            title={skill.realPath ?? 'symlink'}
          >
            <Link2 className="h-2.5 w-2.5" />
            link
          </span>
        )}
        {fileCount > 0 && (
          <span className="font-mono text-[10.5px] text-bridges-fg3">+{fileCount}</span>
        )}
        <span className="ml-auto text-[10.5px] text-bridges-fg3">{relativeTime(skill.mtime)}</span>
      </div>
    </button>
  );
}
