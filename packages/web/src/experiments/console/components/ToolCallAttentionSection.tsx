import { useEffect, useState, type ReactElement } from 'react';
import type { Run } from '../primitives/run';
import { elapsedSince, formatElapsed } from '../lib/format';

export function ToolCallAttentionSection({ run }: { run: Run }): ReactElement | null {
  const [, tick] = useState(0);
  const calls = run.status === 'running' ? (run.toolCallAttention ?? []) : [];
  useEffect(() => {
    if (calls.length === 0) return;
    const timer = setInterval(() => {
      tick(n => n + 1);
    }, 1000);
    return (): void => {
      clearInterval(timer);
    };
  }, [calls.length]);
  if (calls.length === 0) return null;
  return (
    <div className="w-full px-4 py-2 text-xs text-warning">
      {/* Only the static notice is live; the ticking rows would re-announce every second. */}
      <p role="status">Tool calls need attention. Work remains running.</p>
      {calls.map(call => (
        <p key={JSON.stringify([call.streamId, call.toolCallId])} className="break-words font-mono">
          {call.nodeId} · {call.provider} · {call.name}: {call.title || call.name} (running{' '}
          {formatElapsed(elapsedSince(call.startedAt))}; no progress{' '}
          {formatElapsed(elapsedSince(call.lastProgressAt))})
        </p>
      ))}
    </div>
  );
}
