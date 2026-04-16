import type { ReactElement } from 'react';

interface StreamToolbarProps {
  showToolCalls: boolean;
  onToggleToolCalls: (next: boolean) => void;
  showSystem: boolean;
  onToggleSystem: (next: boolean) => void;
  showGraph: boolean;
  onToggleGraph: (next: boolean) => void;
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

export function StreamToolbar({
  showToolCalls,
  onToggleToolCalls,
  showSystem,
  onToggleSystem,
  showGraph,
  onToggleGraph,
  toolCallCount,
  messageCount,
}: StreamToolbarProps): ReactElement {
  return (
    <div className="flex items-center gap-3 border-b border-border/50 bg-surface py-2 text-[11px]">
      <span className="font-mono text-text-tertiary">
        {messageCount.toString()} messages · {toolCallCount.toString()} tool calls
      </span>
      <div className="ml-auto flex items-center gap-4">
        <Checkbox label="Tool calls" checked={showToolCalls} onChange={onToggleToolCalls} />
        <Checkbox label="System" checked={showSystem} onChange={onToggleSystem} />
        <Checkbox label="Graph" checked={showGraph} onChange={onToggleGraph} />
      </div>
    </div>
  );
}
