import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useBuilderStore } from '../../store/builder-store';
import { defaultRegistry } from '../../nodes/default-registry';
import { tabsForVariant, type InspectorProps, type InspectorTabId } from '../../nodes/shared/types';
import { useInspectorPatch } from '../../hooks/useInspectorPatch';
import { RenameField } from './shared';
import { VariantPicker } from './general/VariantPicker';
import { InspectorTabs } from './InspectorTabs';
import { ExecutionTab } from './tabs/ExecutionTab';
import { ProviderTab } from './tabs/ProviderTab';
import { ToolsTab } from './tabs/ToolsTab';
import { HooksTab } from './tabs/HooksTab';
import { SkillsMcpTab } from './tabs/SkillsMcpTab';
import { AdvancedTab } from './tabs/AdvancedTab';

/**
 * Right-rail editor for the currently-selected node. Reads selection from the
 * store, looks up the variant in the registry, derives the tab list via
 * tabsForVariant (capability-gated), and renders the per-variant General
 * Inspector + shared base-field tab stubs. Width matches spec §5.1 (320px).
 */
/**
 * Maps a focused issue's field name to the inspector tab that contains it.
 * All body editors (prompt, script, bash, command, loop.*, approval.*, cancel,
 * when) live in the 'general' tab. Execution, provider, etc. have no field-
 * level focus routing from validation, so they fall through to 'general'.
 */
function fieldToTab(_field: string | undefined): InspectorTabId {
  // Every field the validator emits lives in the General tab (the variant
  // Inspector renders inside NodeInspector's 'general' case). Keep the
  // function for forward-compatibility if future tabs gain field markers.
  return 'general';
}

export function NodeInspector(): JSX.Element {
  const selectedId = useBuilderStore(s => s.primarySelectionId);
  const nodes = useBuilderStore(s => s.nodes);
  const focused = useBuilderStore(s => s.focusedIssue);

  const node = useMemo(
    () => (selectedId ? nodes.find(n => n.id === selectedId) : undefined),
    [nodes, selectedId]
  );
  const siblingIds = useMemo(
    () => nodes.map(n => n.id).filter(id => id !== selectedId),
    [nodes, selectedId]
  );
  const onChange = useInspectorPatch(selectedId ?? '');

  // Controlled tab state — lifted so the focus-reaction effect can switch tabs.
  const [activeTab, setActiveTab] = useState<InspectorTabId>('general');

  // Focus reaction: switch to the correct tab then scroll + flash the field.
  useEffect(() => {
    if (!focused) return;
    setActiveTab(fieldToTab(focused.field));
    const t = setTimeout((): void => {
      const el = document.querySelector<HTMLElement>(`[data-field="${focused.field}"]`);
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el?.classList.add('flash');
      setTimeout(() => el?.classList.remove('flash'), 1200);
    }, 0);
    return (): void => {
      clearTimeout(t);
    };
  }, [focused]);

  if (!selectedId || !node) {
    return (
      <aside style={shellStyle} aria-label="Node inspector" data-testid="inspector-empty">
        <div style={emptyStyle}>Select a node to edit.</div>
      </aside>
    );
  }

  const variant = defaultRegistry[node.variant];
  if (!variant) {
    return (
      <aside style={shellStyle} aria-label="Node inspector">
        <div style={emptyStyle}>Unknown variant &lsquo;{node.variant}&rsquo;.</div>
      </aside>
    );
  }
  const tabs = tabsForVariant(variant);
  // eslint-disable-next-line @typescript-eslint/naming-convention -- React component variables must be PascalCase to be used as JSX
  const VariantInspector = variant.Inspector;

  return (
    <aside style={shellStyle} aria-label="Node inspector">
      <header style={headerStyle}>
        <div style={{ flex: 1 }}>
          <RenameField id={selectedId} />
        </div>
        <span style={typePillStyle} title="Variant">
          {node.variant}
        </span>
      </header>
      <InspectorTabs tabs={tabs} activeTab={activeTab} onActiveChange={setActiveTab}>
        {active => {
          const generalProps: InspectorProps<unknown> = {
            id: selectedId,
            data: node.data,
            base: node.base,
            unknown: node.unknown,
            onChange,
            siblingIds,
          };
          switch (active) {
            case 'general':
              return (
                <>
                  <VariantPicker />
                  <VariantInspector {...(generalProps as InspectorProps<never>)} />
                </>
              );
            case 'execution':
              return (
                <ExecutionTab {...generalProps} forbidsRetry={variant.capabilities.forbidsRetry} />
              );
            case 'provider':
              return <ProviderTab {...generalProps} />;
            case 'tools':
              return <ToolsTab {...generalProps} />;
            case 'hooks':
              return <HooksTab {...generalProps} />;
            case 'skills-mcp':
              return <SkillsMcpTab {...generalProps} />;
            case 'advanced':
              return <AdvancedTab {...generalProps} />;
          }
        }}
      </InspectorTabs>
    </aside>
  );
}

const shellStyle: CSSProperties = {
  width: 320,
  flexShrink: 0,
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  background: 'var(--studio-bg)',
  color: 'var(--studio-fg)',
  borderLeft: '1px solid var(--studio-border)',
};
const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 8,
  padding: 12,
  borderBottom: '1px solid var(--studio-border)',
};
const typePillStyle: CSSProperties = {
  fontSize: 11,
  padding: '2px 6px',
  background: 'var(--studio-bg-elevated)',
  color: 'var(--studio-muted)',
  border: '1px solid var(--studio-border)',
  borderRadius: 'var(--radius-sm)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  flexShrink: 0,
  marginTop: 18,
};
const emptyStyle: CSSProperties = {
  padding: 24,
  fontSize: 13,
  color: 'var(--studio-muted)',
  textAlign: 'center',
};
