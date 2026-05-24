import { useQuery } from '@tanstack/react-query';
import type { CSSProperties } from 'react';
import { useWorkflowApi } from '../../api/ApiClientProvider';
import { useBuilderStore } from '../../store/builder-store';
import { CollapsibleSection } from './CollapsibleSection';
import { LIBRARY_DRAG_MIME, encodeLibraryDrag } from './dragPayload';

export interface CommandsSectionProps {
  /** Working directory passed in from WorkflowBuilder via NodeLibrary. */
  cwd: string;
}

export function CommandsSection({ cwd }: CommandsSectionProps): JSX.Element {
  const client = useWorkflowApi();
  const addNodeFromVariant = useBuilderStore(s => s.addNodeFromVariant);
  const { data, isLoading, isError } = useQuery({
    queryKey: ['commands', cwd],
    queryFn: () => client.listCommands(cwd),
  });

  // Slug-safe id hint: Archon command names follow a slug convention by file
  // path (.archon/commands/<name>.md), but we don't enforce it here. Strip
  // anything that would break BuilderNode.id-as-string-key invariants used by
  // depends_on / when refs / Task 49 renameSubgraph. Keeps the literal name in
  // data.command for execution.
  const slugify = (name: string): string => name.replace(/[^A-Za-z0-9_-]+/g, '-');

  return (
    <CollapsibleSection id="commands" title="Commands">
      {isLoading && <div style={emptyStyle}>Loading…</div>}
      {isError && <div style={emptyStyle}>Couldn't load commands.</div>}
      {!isLoading && !isError && (data?.length ?? 0) === 0 && (
        <div style={emptyStyle}>No commands.</div>
      )}
      {data && data.length > 0 && (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          {data.map(cmd => (
            <li key={`${cmd.source}:${cmd.name}`}>
              <button
                type="button"
                aria-label={`Add command running ${cmd.name}`}
                draggable
                onDragStart={e => {
                  e.dataTransfer.setData(
                    LIBRARY_DRAG_MIME,
                    encodeLibraryDrag({
                      kind: 'variant',
                      variantId: 'command',
                      idHintOverride: `run-${slugify(cmd.name)}`,
                      prefill: { command: cmd.name },
                    })
                  );
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onClick={() =>
                  addNodeFromVariant('command', {
                    idHintOverride: `run-${slugify(cmd.name)}`,
                    dataPatch: { command: cmd.name },
                  })
                }
                style={rowStyle}
              >
                <span
                  style={{
                    width: 4,
                    height: 16,
                    borderRadius: 2,
                    background: 'var(--node-command)',
                  }}
                />
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                  }}
                >
                  <span style={{ fontSize: 13 }}>{cmd.name}</span>
                  <span
                    style={{
                      fontSize: 10,
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                      color: 'var(--studio-muted)',
                    }}
                  >
                    {cmd.source}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </CollapsibleSection>
  );
}

const emptyStyle: CSSProperties = { fontSize: 12, color: 'var(--studio-muted)' };
const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '6px 8px',
  textAlign: 'left',
  background: 'transparent',
  color: 'var(--studio-fg)',
  border: '1px solid transparent',
  borderRadius: 'var(--radius-sm)',
  cursor: 'grab',
};
