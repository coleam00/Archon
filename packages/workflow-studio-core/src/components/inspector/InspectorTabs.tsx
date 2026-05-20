import { useState, type CSSProperties, type ReactNode } from 'react';
import type { InspectorTabId } from '../../nodes/shared/types';

const LABELS: Record<InspectorTabId, string> = {
  general: 'General',
  execution: 'Execution',
  provider: 'Provider',
  tools: 'Tools',
  hooks: 'Hooks',
  'skills-mcp': 'Skills+MCP',
  advanced: 'Advanced',
};

interface Props {
  tabs: InspectorTabId[];
  initial?: InspectorTabId;
  /**
   * Optional controlled active tab. When provided (along with onActiveChange),
   * the caller owns the active state — used by NodeInspector to react to
   * focusedIssue changes from the validation panel.
   */
  activeTab?: InspectorTabId;
  onActiveChange?: (tab: InspectorTabId) => void;
  /** Render-prop called with the active tab id; returns the panel content. */
  children: (active: InspectorTabId) => ReactNode;
}

/**
 * Capability-driven tab strip + panel for the Node Inspector. The active tab
 * is local state by default; pass `activeTab` + `onActiveChange` to use
 * controlled mode (required for focus reactions from the validation panel).
 * When the active tab id is no longer present (e.g. variant switch removes
 * the AI tabs), it falls back to the first tab so the panel never goes blank.
 */
export function InspectorTabs({
  tabs,
  initial,
  activeTab,
  onActiveChange,
  children,
}: Props): JSX.Element {
  const [localActive, setLocalActive] = useState<InspectorTabId>(initial ?? tabs[0]);
  const controlled = activeTab !== undefined && onActiveChange !== undefined;
  const active = controlled ? activeTab : localActive;
  const setActive = controlled ? onActiveChange : setLocalActive;
  const current = tabs.includes(active) ? active : tabs[0];
  return (
    <div style={containerStyle}>
      <div role="tablist" aria-label="Inspector tabs" style={tabListStyle}>
        {tabs.map(t => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={current === t}
            onClick={() => {
              setActive(t);
            }}
            style={current === t ? activeTabStyle : tabStyle}
          >
            {LABELS[t]}
          </button>
        ))}
      </div>
      <div role="tabpanel" data-testid={`tab-panel-${current}`} style={panelStyle}>
        {children(current)}
      </div>
    </div>
  );
}

const containerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  minHeight: 0,
};
const tabListStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 2,
  borderBottom: '1px solid var(--studio-border)',
  padding: '0 8px',
};
const tabStyle: CSSProperties = {
  padding: '8px 10px',
  fontSize: 12,
  fontWeight: 500,
  background: 'transparent',
  color: 'var(--studio-muted)',
  borderTop: 'none',
  borderRight: 'none',
  borderLeft: 'none',
  borderBottomWidth: 2,
  borderBottomStyle: 'solid',
  borderBottomColor: 'transparent',
  cursor: 'pointer',
};
const activeTabStyle: CSSProperties = {
  ...tabStyle,
  color: 'var(--studio-fg)',
  borderBottomColor: 'var(--studio-accent, #8b5cf6)',
};
const panelStyle: CSSProperties = { flex: 1, overflow: 'auto', padding: 12 };
