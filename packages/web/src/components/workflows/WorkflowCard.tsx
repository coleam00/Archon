import { Link } from 'react-router';
import {
  Bug,
  GitMerge,
  Rocket,
  RefreshCw,
  TestTube,
  Workflow,
  Eye,
  Lightbulb,
  Wrench,
  Zap,
  Bot,
  Pencil,
  Play,
  type LucideIcon,
} from 'lucide-react';
import type { WorkflowDefinition } from '@/lib/api';
import {
  parseWorkflowDescription,
  getWorkflowDisplayName,
  getWorkflowCategory,
  getWorkflowTags,
  getWorkflowIconName,
  type WorkflowIconName,
} from '@/lib/workflow-metadata';
import { t } from '@/lib/i18n';

const ICON_MAP: Record<WorkflowIconName, LucideIcon> = {
  Bug,
  GitMerge,
  Rocket,
  RefreshCw,
  TestTube,
  Workflow,
  Eye,
  Lightbulb,
  Wrench,
  Zap,
  Bot,
};

interface WorkflowCardProps {
  workflow: WorkflowDefinition;
  isSelected: boolean;
  onToggle: (name: string) => void;
  onRun: (name: string) => void;
}

export function WorkflowCard({
  workflow,
  isSelected,
  onToggle,
  onRun,
}: WorkflowCardProps): React.ReactElement {
  const parsed = parseWorkflowDescription(workflow.description ?? '');
  const displayName = getWorkflowDisplayName(workflow.name);
  const category = getWorkflowCategory(workflow.name, workflow.description ?? '');
  const tags = getWorkflowTags(workflow.name, parsed);
  const iconName = getWorkflowIconName(workflow.name, category);
  const CARD_ICON = ICON_MAP[iconName];

  const hasSections =
    parsed.whenToUse || parsed.triggers.length > 0 || parsed.does || parsed.constraints;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${t('workflowCard.selectPrefix')} ${displayName}`}
      aria-pressed={isSelected}
      onClick={(): void => {
        onToggle(workflow.name);
      }}
      onKeyDown={(e): void => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle(workflow.name);
        }
      }}
      className={`flex flex-col rounded-lg border p-4 transition-colors cursor-pointer h-full ${
        isSelected
          ? 'border-accent bg-accent/5'
          : 'border-border bg-surface hover:bg-surface-hover hover:border-border/80'
      }`}
    >
      {/* Header: Icon + Name + ID */}
      <div className="flex items-start gap-3 mb-3 shrink-0">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-elevated text-text-secondary">
          <CARD_ICON className="size-4.5" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-sm text-text-primary leading-tight">{displayName}</h3>
          <p className="text-xs text-text-tertiary font-mono mt-0.5 truncate">{workflow.name}</p>
        </div>
      </div>

      {/* Metadata sections */}
      {hasSections ? (
        <div className="grid grid-cols-2 gap-x-3 gap-y-2 mb-3 text-xs flex-1">
          {/* Left column: When to Use + Does */}
          <div className="space-y-2">
            {parsed.whenToUse && (
              <div>
                <span className="text-[10px] font-semibold uppercase tracking-wider text-accent-bright">
                  {t('workflowCard.whenToUse')}
                </span>
                <p className="text-text-secondary mt-0.5 line-clamp-3 leading-relaxed">
                  {parsed.whenToUse}
                </p>
              </div>
            )}
            {parsed.does && (
              <div>
                <span className="text-[10px] font-semibold uppercase tracking-wider text-accent-bright">
                  {t('workflowCard.does')}
                </span>
                <p className="text-text-secondary mt-0.5 line-clamp-2 leading-relaxed">
                  {parsed.does}
                </p>
              </div>
            )}
          </div>

          {/* Right column: Triggers + Constraints */}
          <div className="space-y-2">
            {parsed.triggers.length > 0 && (
              <div>
                <span className="text-[10px] font-semibold uppercase tracking-wider text-accent-bright">
                  {t('workflowCard.triggers')}
                </span>
                <div className="flex flex-wrap gap-1 mt-0.5">
                  {parsed.triggers.slice(0, 4).map(trigger => (
                    <span
                      key={trigger}
                      className="inline-block rounded bg-surface-elevated px-1.5 py-0.5 text-[10px] text-text-secondary"
                    >
                      {trigger}
                    </span>
                  ))}
                  {parsed.triggers.length > 4 && (
                    <span className="inline-block text-[10px] text-text-tertiary">
                      +{parsed.triggers.length - 4} {t('workflowCard.moreSuffix')}
                    </span>
                  )}
                </div>
              </div>
            )}
            {parsed.constraints && (
              <div>
                <span className="text-[10px] font-semibold uppercase tracking-wider text-warning">
                  {t('workflowCard.notFor')}
                </span>
                <p className="text-text-secondary mt-0.5 line-clamp-2 leading-relaxed">
                  {parsed.constraints}
                </p>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Fallback: raw description */
        workflow.description && (
          <p className="text-xs text-text-secondary mb-3 line-clamp-3 flex-1">
            {workflow.description}
          </p>
        )
      )}

      {/* Footer: Tags + Actions */}
      <div className="flex items-center justify-between pt-2 border-t border-border/50 mt-auto shrink-0">
        <div className="flex flex-wrap gap-1">
          {tags.slice(0, 3).map(tag => (
            <span
              key={tag}
              className="inline-block rounded-full bg-surface-elevated px-2 py-0.5 text-[10px] font-medium text-text-secondary"
            >
              #{tag}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <Link
            to={`/workflows/builder?edit=${encodeURIComponent(workflow.name)}`}
            onClick={(e): void => {
              e.stopPropagation();
            }}
            className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-surface-elevated transition-colors"
            title={t('workflowCard.editInBuilder')}
          >
            <Pencil className="size-3.5" />
          </Link>
          <button
            onClick={(e): void => {
              e.stopPropagation();
              onRun(workflow.name);
            }}
            className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary hover:bg-primary/20 transition-colors"
            title={t('workflowCard.configureRun')}
          >
            <Play className="size-3" />
            {t('workflows.run')}
          </button>
        </div>
      </div>
    </div>
  );
}
