export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 100) / 10;
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = Math.round(secs % 60);
  return `${mins}m${remSecs}s`;
}
