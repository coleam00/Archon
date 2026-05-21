import type { ReactElement } from 'react';

export type DetailView = 'log' | 'graph';

interface StreamToolbarProps {
  view: DetailView;
  onChangeView: (next: DetailView) => void;
  showToolCalls: boolean;
  onToggleToolCalls: (next: boolean) => void;
  showSystem: boolean;
  onToggleSystem: (next: boolean) => void;
  toolCallCount: number;
  messageCount: number;
}

interface CheckboxProps {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}

function Checkbox({ label, checked, onChange }: CheckboxProps): ReactElement {
  return (
    <label className="flex cursor-pointer select-none items-center gap-1.5 text-text-secondary hover:text-text-primary">
      <input
        type="checkbox"
        checked={checked}
        onChange={e => {
          onChange(e.target.checked);
        }}
        className="h-3 w-3 cursor-pointer accent-[color:var(--accent-bright)]"
      />
      <span>{label}</span>
    </label>
  );
}

interface TabProps {
  label: string;
  active: boolean;
  onClick: () => void;
}

function Tab({ label, active, onClick }: TabProps): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`relative px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider transition-colors ${
        active ? 'text-text-primary' : 'text-text-tertiary hover:text-text-primary'
      }`}
    >
      {label}
      {active ? (
        <span
          aria-hidden
          className="brand-bar pointer-events-none absolute inset-x-1 -bottom-px h-0.5 rounded-full"
        />
      ) : null}
    </button>
  );
}

export function StreamToolbar({
  view,
  onChangeView,
  showToolCalls,
  onToggleToolCalls,
  showSystem,
  onToggleSystem,
  toolCallCount,
  messageCount,
}: StreamToolbarProps): ReactElement {
  const isLog = view === 'log';
  return (
    <div className="flex items-center gap-3 border-b border-border/60 bg-surface py-1.5 text-[11px]">
      <div className="flex items-center gap-1">
        <Tab
          label="Log"
          active={isLog}
          onClick={() => {
            onChangeView('log');
          }}
        />
        <Tab
          label="Graph"
          active={view === 'graph'}
          onClick={() => {
            onChangeView('graph');
          }}
        />
      </div>

      {isLog ? (
        <span className="ml-3 font-mono text-text-tertiary">
          {messageCount.toString()} messages · {toolCallCount.toString()} tool calls
        </span>
      ) : null}

      {isLog ? (
        <div className="ml-auto flex items-center gap-4">
          <Checkbox label="Tool calls" checked={showToolCalls} onChange={onToggleToolCalls} />
          <Checkbox label="System" checked={showSystem} onChange={onToggleSystem} />
        </div>
      ) : null}
    </div>
  );
}
