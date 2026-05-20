import { useMemo } from 'react';
import { useBuilderStore } from '../../store/builder-store';
import { serializeYaml } from '../../exporter/serializeYaml';
import { YamlPreview } from './YamlPreview';
import { isModified } from './yamlDiffBadge';
import './YamlPreviewDrawer.css';

export function YamlPreviewDrawer(): JSX.Element {
  const meta = useBuilderStore(s => s.workflow);
  const nodes = useBuilderStore(s => s.nodes);
  const selectedNodeId = useBuilderStore(s => s.primarySelectionId);
  const hoveredNodeId = useBuilderStore(s => s.hoveredNodeId);
  const setSelection = useBuilderStore(s => s.setSelection);
  const clearSelection = useBuilderStore(s => s.clearSelection);
  const setHoveredNodeId = useBuilderStore(s => s.setHoveredNodeId);
  const baseline = useBuilderStore(s => s.baselineYaml);

  const result = useMemo(() => {
    if (!meta) return { yaml: '', sourceMap: [] };
    return serializeYaml({ meta, nodes });
  }, [meta, nodes]);

  const modified = isModified(result.yaml, baseline);
  const filename = `${meta?.name ?? 'workflow'}.yaml`;

  const onCopy = (): void => {
    void navigator.clipboard.writeText(result.yaml);
  };

  const onDownload = (): void => {
    const blob = new Blob([result.yaml], { type: 'text/yaml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="yaml-preview-drawer">
      <header className="yaml-preview-drawer__header">
        <div className="yaml-preview-drawer__title-row">
          <h2>YAML preview</h2>
          {modified && (
            <span
              className="badge badge--modified"
              style={{
                display: 'inline-block',
                padding: '2px 8px',
                borderRadius: '9999px',
                fontSize: '0.75rem',
                fontWeight: 600,
                background: 'var(--color-amber-100, #fef3c7)',
                color: 'var(--color-amber-800, #92400e)',
                border: '1px solid var(--color-amber-300, #fcd34d)',
              }}
            >
              Modified
            </span>
          )}
        </div>
        <p className="yaml-preview-drawer__note">Preview formatting may differ from saved file.</p>
        <div className="yaml-preview-drawer__actions">
          <button type="button" onClick={onCopy}>
            Copy
          </button>
          <button type="button" onClick={onDownload}>
            Download
          </button>
        </div>
      </header>
      <YamlPreview
        yaml={result.yaml}
        sourceMap={result.sourceMap}
        selectedNodeId={selectedNodeId}
        hoveredNodeId={hoveredNodeId}
        onLinePick={id => {
          if (id) setSelection([id]);
          else clearSelection();
        }}
        onLineHover={id => {
          setHoveredNodeId(id);
        }}
      />
    </div>
  );
}
