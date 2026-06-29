/**
 * Left-rail node palette: one draggable tile per variant (PR-1 `VARIANTS`
 * order), color-swatched via the `--node-<variant>` tokens. Drag writes the
 * variant id into `dataTransfer` for the canvas drop handler; clicking a tile
 * adds the variant at a default spot for keyboard/trackpad users.
 */
import type { CSSProperties, DragEvent, ReactElement } from 'react';
import { VARIANTS, VARIANT_REGISTRY } from '../variants';
import type { VariantId } from '../types';
import { PALETTE_DATA_KEY } from './BuilderCanvas';

interface NodePaletteProps {
  onAddVariant: (variant: VariantId) => void;
}

function variantHint(variant: VariantId): string {
  switch (variant) {
    case 'prompt':
      return 'Inline AI prompt';
    case 'command':
      return 'Named command file';
    case 'bash':
      return 'Shell script, no AI';
    case 'script':
      return 'bun / uv script, no AI';
    case 'loop':
      return 'Iterate until a signal';
    case 'route_loop':
      return 'Route retry outcomes';
    case 'approval':
      return 'Human gate (interactive)';
    case 'cancel':
      return 'Stop the run';
  }
}

export function NodePalette({ onAddVariant }: NodePaletteProps): ReactElement {
  return (
    <aside
      aria-label="Node palette"
      className="flex w-48 shrink-0 flex-col gap-1.5 overflow-y-auto border-r border-border bg-surface-inset p-2.5"
    >
      <h2 className="px-1 pb-1 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-tertiary">
        Nodes
      </h2>
      {VARIANTS.map(variant => {
        const swatch: CSSProperties = { background: `var(--node-${variant})` };
        return (
          <button
            key={variant}
            type="button"
            draggable
            onDragStart={(event: DragEvent<HTMLButtonElement>): void => {
              event.dataTransfer.setData(PALETTE_DATA_KEY, variant);
              event.dataTransfer.effectAllowed = 'copy';
            }}
            onClick={(): void => {
              onAddVariant(variant);
            }}
            title={`Drag onto the canvas (or click) to add a ${VARIANT_REGISTRY[variant].label} node`}
            className="flex cursor-grab items-center gap-2.5 rounded-[10px] border border-border bg-surface px-2.5 py-2 text-left transition-colors hover:border-border-bright hover:bg-surface-hover active:cursor-grabbing"
          >
            <span aria-hidden className="h-7 w-[3px] shrink-0 rounded-sm" style={swatch} />
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-text-primary">
                {VARIANT_REGISTRY[variant].label}
              </span>
              <span className="block truncate text-[10.5px] text-text-tertiary">
                {variantHint(variant)}
              </span>
            </span>
          </button>
        );
      })}
    </aside>
  );
}
