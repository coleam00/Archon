import { cn } from '@/lib/utils';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import type { ValidationIssue } from '@/hooks/useBuilderValidation';

interface ValidationPanelProps {
  issues: ValidationIssue[];
  isOpen: boolean;
  onToggle: () => void;
  onFocusNode?: (nodeId: string) => void;
}

function severityIcon(severity: ValidationIssue['severity']): React.ReactElement {
  switch (severity) {
    case 'error':
      return <span className="text-error text-xs leading-none">●</span>;
    case 'warning':
      return <span className="text-warning text-xs leading-none">▲</span>;
    case 'info':
      return <span className="text-[oklch(0.62_0.18_250)] text-xs leading-none">ℹ</span>;
  }
}

function countBySeverity(issues: ValidationIssue[], severity: ValidationIssue['severity']): number {
  return issues.filter(i => i.severity === severity).length;
}

export function ValidationPanel({
  issues,
  isOpen,
  onToggle,
  onFocusNode,
}: ValidationPanelProps): React.ReactElement | null {
  if (!isOpen) {
    return null;
  }

  const errorCount = countBySeverity(issues, 'error');
  const warningCount = countBySeverity(issues, 'warning');

  return (
    <div className="border-t border-border bg-surface" style={{ maxHeight: 200 }}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-text-primary">Problems</span>
          {errorCount > 0 && (
            <span className="inline-flex items-center justify-center rounded-full bg-error/20 px-1.5 py-0.5 text-[10px] font-medium text-error min-w-[18px]">
              {errorCount}
            </span>
          )}
          {warningCount > 0 && (
            <span className="inline-flex items-center justify-center rounded-full bg-warning/20 px-1.5 py-0.5 text-[10px] font-medium text-warning min-w-[18px]">
              {warningCount}
            </span>
          )}
        </div>
        <Button variant="ghost" size="icon-xs" onClick={onToggle} aria-label="Close problems panel">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </Button>
      </div>

      {/* Issue list */}
      <ScrollArea className="h-full" style={{ maxHeight: 200 - 36 }}>
        {issues.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-4 text-xs text-success">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            No issues found
          </div>
        ) : (
          <div className="flex flex-col">
            {issues.map((issue, index) => (
              <div
                key={`${issue.severity}-${issue.nodeId ?? ''}-${issue.message}-${String(index)}`}
                className="flex items-start gap-2 px-3 py-1.5 hover:bg-surface-hover text-xs"
              >
                <span className="mt-0.5 shrink-0">{severityIcon(issue.severity)}</span>
                <div className="flex flex-col gap-0.5 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-text-primary">{issue.message}</span>
                    {issue.nodeId != null && (
                      <button
                        type="button"
                        onClick={(): void => {
                          if (issue.nodeId != null) onFocusNode?.(issue.nodeId);
                        }}
                        className={cn(
                          'inline-flex items-center rounded px-1.5 py-0.5',
                          'font-mono text-[10px] text-text-secondary',
                          'bg-surface-elevated hover:bg-surface-hover',
                          'cursor-pointer transition-colors'
                        )}
                      >
                        {issue.nodeId}
                      </button>
                    )}
                  </div>
                  {issue.suggestion != null && (
                    <span className="italic text-text-tertiary">{issue.suggestion}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
