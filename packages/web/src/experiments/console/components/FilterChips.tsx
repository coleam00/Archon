import type { ReactElement } from 'react';
import type { RunStatus } from '../lib/run-status';
import type { RunCounts } from '../skills/runs';

export type Filter = 'all' | RunStatus;

interface FilterChipsProps {
  value: Filter;
  onChange: (next: Filter) => void;
  counts: RunCounts;
}

// Order reflects the typical user journey: what's happening now (running),
// what needs me (paused), what's broken (failed), then the retrospective
// buckets (completed, all) at the end.
const ORDER: readonly {
  filter: Filter;
  label: string;
  countKey: keyof RunCounts;
}[] = [
  { filter: 'running', label: 'Running', countKey: 'running' },
  { filter: 'paused', label: 'Paused', countKey: 'paused' },
  { filter: 'failed', label: 'Failed', countKey: 'failed' },
  { filter: 'completed', label: 'Completed', countKey: 'completed' },
  { filter: 'all', label: 'All', countKey: 'all' },
];

export function FilterChips({ value, onChange, counts }: FilterChipsProps): ReactElement {
  return (
    <div className="flex items-center gap-1">
      {ORDER.map(({ filter, label, countKey }) => {
        const active = value === filter;
        const n = counts[countKey];
        return (
          <button
            key={filter}
            type="button"
            onClick={() => {
              onChange(filter);
            }}
            className={`relative rounded px-2 py-1 text-[11px] font-medium uppercase tracking-wider transition-colors ${
              active
                ? 'bg-surface-elevated text-text-primary'
                : 'text-text-tertiary hover:text-text-primary'
            }`}
            aria-pressed={active}
          >
            {label}
            <span className="ml-1.5 font-mono tabular-nums text-text-tertiary">{n}</span>
            {active ? (
              <span
                aria-hidden
                className="brand-bar pointer-events-none absolute inset-x-1 -bottom-0.5 h-0.5 rounded-full"
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
