import { cn } from '@/lib/utils';

interface SegmentedTabsProps<T extends string> {
  tabs: readonly T[];
  value: T;
  onChange: (value: T) => void;
}

export function SegmentedTabs<T extends string>({
  tabs,
  value,
  onChange,
}: SegmentedTabsProps<T>): React.ReactElement {
  return (
    <div className="flex gap-4 border-b border-bridges-border-subtle px-5">
      {tabs.map(t => (
        <button
          key={t}
          type="button"
          onClick={() => {
            onChange(t);
          }}
          className={cn(
            '-mb-px border-b-2 py-2.5 text-[13px] font-medium transition-colors',
            value === t
              ? 'border-bridges-action text-bridges-fg1'
              : 'border-transparent text-bridges-fg3 hover:text-bridges-fg2'
          )}
        >
          {t}
        </button>
      ))}
    </div>
  );
}
