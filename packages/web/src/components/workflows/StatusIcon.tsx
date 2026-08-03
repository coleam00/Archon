import { Pause } from 'lucide-react';

export function StatusIcon({ status }: { status: string }): React.ReactElement {
  switch (status) {
    case 'completed':
      return <span className="text-success text-sm">&#x2713;</span>;
    case 'running':
      return (
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      );
    case 'paused':
      return <Pause className="h-3 w-3 text-warning" />;
    case 'failed':
      return <span className="text-error text-sm">&#x2717;</span>;
    case 'cancelled':
      return <span className="text-text-secondary text-sm">&#x2715;</span>;
    case 'skipped':
      return <span className="text-text-secondary text-sm">&#x2014;</span>;
    default:
      return <span className="text-text-secondary text-sm">&#x25CB;</span>;
  }
}
