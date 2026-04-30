import { SymphonyKanban } from '@/components/symphony';

export function SymphonyPage(): React.ReactElement {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-4 pt-4 pb-2">
        <div>
          <h1 className="text-lg font-semibold text-text-primary">Symphony</h1>
          <p className="text-xs text-muted-foreground">
            Autonomous tracker-driven dispatch — running, retrying, and historical workflow runs.
          </p>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        <SymphonyKanban />
      </div>
    </div>
  );
}
