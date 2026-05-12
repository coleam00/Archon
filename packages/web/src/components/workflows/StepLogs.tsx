import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useAutoScroll } from '@/hooks/useAutoScroll';

interface StepLogsProps {
  runId: string;
  lines?: string[];
}

export function StepLogs({ runId, lines = [] }: StepLogsProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { isAtBottom, scrollToBottom } = useAutoScroll(containerRef, [lines.length]);

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => 24,
    overscan: 20,
  });

  if (lines.length === 0) {
    return (
      <div className="flex-1 overflow-auto p-4 font-mono text-sm bg-surface-inset">
        <div className="text-text-secondary text-xs mb-2">
          Node logs &middot; Run {runId.slice(0, 8)}
        </div>
        <div className="text-text-secondary italic">
          Live log output will appear here during workflow execution.
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-surface-inset relative">
      <div className="text-text-secondary text-xs px-4 pt-3 pb-1">
        Node logs &middot; Run {runId.slice(0, 8)} &middot; {String(lines.length)} lines
      </div>
      <div ref={containerRef} className="flex-1 overflow-auto px-4 pb-4 font-mono text-sm">
        <div
          style={{
            height: `${String(virtualizer.getTotalSize())}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map(virtualRow => (
            <div
              key={virtualRow.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${String(virtualRow.size)}px`,
                transform: `translateY(${String(virtualRow.start)}px)`,
              }}
              className="text-text-primary whitespace-pre-wrap break-all"
            >
              {lines[virtualRow.index]}
            </div>
          ))}
        </div>
      </div>
      {!isAtBottom && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-4 right-4 bg-accent text-white text-xs px-3 py-1.5 rounded-full shadow-lg hover:bg-accent-bright transition-colors"
        >
          Jump to bottom
        </button>
      )}
    </div>
  );
}
