import { useState, useEffect } from 'react';
import { ChevronRight, Loader2, Terminal } from 'lucide-react';
import type { ToolCallDisplay } from '@/lib/types';
import { cn } from '@/lib/utils';

interface ToolCallCardProps {
  tool: ToolCallDisplay;
}

export function ToolCallCard({ tool }: ToolCallCardProps): React.ReactElement {
  const [expanded, setExpanded] = useState(tool.isExpanded);
  const [showAllOutput, setShowAllOutput] = useState(false);
  const isRunning = tool.output === undefined && tool.duration === undefined;

  // Live elapsed counter — ticks every second while tool is running
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!isRunning || !tool.startedAt) return;
    setElapsed(Date.now() - tool.startedAt);
    const interval = setInterval(() => {
      setElapsed(Date.now() - tool.startedAt);
    }, 1000);
    return (): void => {
      clearInterval(interval);
    };
  }, [isRunning, tool.startedAt]);

  // Get a brief summary from the input
  const summary = Object.values(tool.input)[0];
  const summaryText =
    typeof summary === 'string' ? summary.slice(0, 60) + (summary.length > 60 ? '...' : '') : '';

  // Limit output display
  const outputLines = tool.output?.split('\n') ?? [];
  const isLongOutput = outputLines.length > 20;
  const displayOutput = showAllOutput ? tool.output : outputLines.slice(0, 20).join('\n');

  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-surface transition-colors hover:border-border-bright',
        isRunning && 'border-l-2 border-l-primary'
      )}
    >
      {/* Header - clickable to expand */}
      <button
        onClick={(): void => {
          setExpanded(!expanded);
        }}
        className="flex h-9 w-full items-center gap-2 px-3 text-left"
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-text-tertiary transition-transform duration-150',
            expanded && 'rotate-90'
          )}
        />
        {isRunning ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
        ) : (
          <Terminal className="h-3.5 w-3.5 shrink-0 text-text-secondary" />
        )}
        <span className="truncate font-mono text-xs text-text-secondary">{tool.name}</span>
        {summaryText && <span className="truncate text-xs text-text-tertiary">{summaryText}</span>}
        <span className="ml-auto shrink-0">
          {isRunning && elapsed > 0 ? (
            <span className="rounded-full bg-primary/20 px-2 py-0.5 text-[10px] text-primary">
              {elapsed < 1000 ? `${String(elapsed)}ms` : `${(elapsed / 1000).toFixed(1)}s`}
            </span>
          ) : tool.duration !== undefined ? (
            <span className="rounded-full bg-surface-elevated px-2 py-0.5 text-[10px] text-text-secondary">
              {tool.duration < 1000
                ? `${String(tool.duration)}ms`
                : `${(tool.duration / 1000).toFixed(1)}s`}
            </span>
          ) : null}
        </span>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-border px-3 py-2">
          {Object.keys(tool.input).length > 0 && (
            <div className="mb-2">
              <span className="text-[10px] font-medium uppercase tracking-wider text-text-tertiary">
                Input
              </span>
              <pre className="mt-1 overflow-x-auto rounded-md bg-background p-2 font-mono text-xs text-text-secondary">
                {JSON.stringify(tool.input, null, 2)}
              </pre>
            </div>
          )}
          {tool.output !== undefined && (
            <div>
              <span className="text-[10px] font-medium uppercase tracking-wider text-text-tertiary">
                Output
              </span>
              <pre className="mt-1 max-h-80 overflow-auto rounded-md bg-background p-2 font-mono text-xs text-text-secondary">
                {displayOutput || '(no output)'}
              </pre>
              {isLongOutput && !showAllOutput && (
                <button
                  onClick={(): void => {
                    setShowAllOutput(true);
                  }}
                  className="mt-1 text-xs text-text-secondary hover:text-text-primary"
                >
                  Show {String(outputLines.length - 20)} more lines
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
