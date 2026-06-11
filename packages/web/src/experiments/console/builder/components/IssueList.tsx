/**
 * Validation panel: renders the `Issue[]` from PR-1's `runValidation`,
 * grouped by severity (errors first), styled with the status tokens. Clicking
 * an issue with a `path.nodeId` selects that node on the canvas. Errors also
 * surface a "blocks save" banner — saving itself is PR-3; the gating UI lands
 * here so the contract is visible from day one.
 */
import type { ReactElement } from 'react';
import type { Issue, Severity } from '../types';

interface IssueListProps {
  issues: readonly Issue[];
  onSelectNode: (nodeId: string) => void;
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

function severityClass(severity: Severity): string {
  switch (severity) {
    case 'error':
      return 'text-error';
    case 'warning':
      return 'text-warning';
    case 'info':
      return 'text-text-tertiary';
  }
}

export function IssueList({ issues, onSelectNode }: IssueListProps): ReactElement {
  const sorted = [...issues].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
  );
  const errorCount = issues.filter(i => i.severity === 'error').length;

  return (
    <div className="flex min-h-0 flex-col">
      <header className="flex items-baseline justify-between border-b border-border px-3 py-1.5">
        <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-tertiary">
          Validation
        </span>
        <span className="font-mono text-[10.5px] text-text-tertiary">
          {issues.length === 0
            ? 'clean'
            : `${String(issues.length)} issue${issues.length === 1 ? '' : 's'}`}
        </span>
      </header>

      {errorCount > 0 ? (
        <div className="border-b border-error/30 bg-error/10 px-3 py-1.5 text-[11.5px] text-error">
          {errorCount === 1 ? '1 error blocks save' : `${String(errorCount)} errors block save`}
        </div>
      ) : null}

      <ul className="min-h-0 flex-1 overflow-y-auto">
        {sorted.length === 0 ? (
          <li className="px-3 py-2 text-[11.5px] text-text-tertiary">No issues.</li>
        ) : (
          sorted.map(issue => {
            const nodeId = issue.path.nodeId;
            const body = (
              <>
                <span
                  className={`font-mono text-[9.5px] font-bold uppercase ${severityClass(issue.severity)}`}
                >
                  {issue.severity}
                </span>
                <span className="min-w-0 flex-1 text-[11.5px] leading-snug text-text-secondary">
                  {nodeId !== undefined ? (
                    <span className="mr-1 font-mono text-[10.5px] text-text-primary">
                      {nodeId}:
                    </span>
                  ) : null}
                  {issue.message}
                </span>
              </>
            );
            return (
              <li key={issue.id}>
                {nodeId !== undefined ? (
                  <button
                    type="button"
                    onClick={(): void => {
                      onSelectNode(nodeId);
                    }}
                    title="Select this node on the canvas"
                    className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left transition-colors hover:bg-surface-hover"
                  >
                    {body}
                  </button>
                ) : (
                  <div className="flex items-baseline gap-2 px-3 py-1.5">{body}</div>
                )}
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}
