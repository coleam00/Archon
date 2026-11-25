import type { ReactElement, ReactNode } from 'react';

export const DETAIL_VIEWS = ['log', 'graph', 'artifacts'] as const;
export type DetailView = (typeof DETAIL_VIEWS)[number];
export const DETAIL_VIEW_LABELS = {
  log: 'Log',
  graph: 'Graph',
  artifacts: 'Artifacts',
} satisfies Record<DetailView, string>;

export interface NodeFilterOption {
  id: string;
  name: string;
}

interface StreamToolbarProps {
  view: DetailView;
  onChangeView: (next: DetailView) => void;
  showToolCalls: boolean;
  onToggleToolCalls: (next: boolean) => void;
  showSystem: boolean;
  onToggleSystem: (next: boolean) => void;
  toolCallCount: number;
  messageCount: number;
  artifactCount: number | null;
  /** Nodes with stream transitions. */
  nodeOptions: NodeFilterOption[];
  /** null selects all nodes. */
  selectedNodeId: string | null;
  onSelectNode: (next: string | null) => void;
}

// Compact native select styled with brand tokens — mirrors AssistantConfigPanel's
// SelectShell/SELECT_CLASS, tuned for the toolbar row height.
const SELECT_CLASS =
  'max-w-45 cursor-pointer appearance-none truncate rounded-md border border-border bg-surface-elevated py-0.75 pl-2.5 pr-7 font-mono text-console-12 font-medium text-text-primary transition-all focus:border-accent-bright/50 focus:outline-none focus:shadow-[0_0_0_3px_color-mix(in_oklch,var(--brand-magenta),transparent_92%)]';

function SelectShell({ children }: { children: ReactNode }): ReactElement {
  return (
    <span className="relative inline-flex items-center">
      {children}
      <span aria-hidden className="pointer-events-none absolute right-2.25 flex text-text-tertiary">
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </span>
    </span>
  );
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
        className="h-3.5 w-3.5 cursor-pointer accent-[color:var(--accent-bright)]"
      />
      <span>{label}</span>
    </label>
  );
}

interface TabProps {
  label: string;
  active: boolean;
  onClick: () => void;
  count?: number | null;
}

function Tab({ label, active, onClick, count }: TabProps): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`relative px-3 py-1.5 font-mono text-console-11 font-semibold uppercase tracking-widest transition-colors ${
        active ? 'text-text-primary' : 'text-text-tertiary hover:text-text-secondary'
      }`}
    >
      {label}
      {typeof count === 'number' ? (
        <span className="ml-1.5 font-mono tabular-nums text-text-tertiary">{count.toString()}</span>
      ) : null}
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
  artifactCount,
  nodeOptions,
  selectedNodeId,
  onSelectNode,
}: StreamToolbarProps): ReactElement {
  const isLog = view === 'log';
  return (
    <div className="flex items-center gap-3 border-b border-border/60 bg-surface py-2 text-console-11">
      <div className="flex items-center gap-1">
        {DETAIL_VIEWS.map(tab => (
          <Tab
            key={tab}
            label={DETAIL_VIEW_LABELS[tab]}
            count={tab === 'artifacts' ? artifactCount : undefined}
            active={view === tab}
            onClick={() => onChangeView(tab)}
          />
        ))}
      </div>

      {isLog ? (
        <span className="ml-3 font-mono text-console-12 text-text-tertiary">
          {messageCount.toString()} messages · {toolCallCount.toString()} tool calls
        </span>
      ) : null}

      {isLog ? (
        <div className="ml-auto flex items-center gap-4.5 font-mono text-console-12">
          {nodeOptions.length > 0 || selectedNodeId !== null ? (
            <label className="flex items-center gap-1.5 text-text-secondary">
              <span className="text-text-tertiary">Node</span>
              <SelectShell>
                <select
                  value={selectedNodeId ?? ''}
                  onChange={e => {
                    onSelectNode(e.target.value || null);
                  }}
                  className={SELECT_CLASS}
                  aria-label="Filter stream by node"
                >
                  <option value="">All nodes</option>
                  {selectedNodeId !== null && !nodeOptions.some(o => o.id === selectedNodeId) ? (
                    <option value={selectedNodeId}>{selectedNodeId}</option>
                  ) : null}
                  {nodeOptions.map(o => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </SelectShell>
            </label>
          ) : null}
          <Checkbox label="Tool calls" checked={showToolCalls} onChange={onToggleToolCalls} />
          <Checkbox label="System" checked={showSystem} onChange={onToggleSystem} />
        </div>
      ) : null}
    </div>
  );
}
