import { VARIANT_IDS } from '../nodes/registry';
import { defaultRegistry } from '../nodes/default-registry';
import { useBuilderStore } from '../store/builder-store';
import { VariantTile } from './library/VariantTile';
import { CommandsSection } from './library/CommandsSection';
import { SnippetsSection } from './library/SnippetsSection';
import { CollapsibleSection } from './library/CollapsibleSection';
import { LIBRARY_DRAG_MIME, encodeLibraryDrag } from './library/dragPayload';
import styles from './NodeLibrary.module.css';

export interface NodeLibraryProps {
  /** Working directory for cwd-scoped queries (e.g. listCommands). */
  cwd: string;
}

export function NodeLibrary({ cwd }: NodeLibraryProps): JSX.Element {
  const addNodeFromVariant = useBuilderStore(s => s.addNodeFromVariant);
  return (
    <aside aria-label="Node library" className={styles.library}>
      <CollapsibleSection id="variants" title="Variants">
        <ul className={styles.tileList}>
          {VARIANT_IDS.map(id => (
            <li key={id}>
              <VariantTile
                id={id}
                meta={defaultRegistry[id].library}
                onActivate={() => addNodeFromVariant(id)}
                draggable
                onDragStart={e => {
                  e.dataTransfer.setData(
                    LIBRARY_DRAG_MIME,
                    encodeLibraryDrag({ kind: 'variant', variantId: id })
                  );
                  e.dataTransfer.effectAllowed = 'copy';
                }}
              />
            </li>
          ))}
        </ul>
      </CollapsibleSection>
      <CommandsSection cwd={cwd} />
      <SnippetsSection />
    </aside>
  );
}
