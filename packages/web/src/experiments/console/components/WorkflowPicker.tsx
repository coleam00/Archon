import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { Workflow } from '../primitives/workflow';

interface WorkflowPickerProps {
  workflows: Workflow[];
  /**
   * Repo-curated workflow names (PR #1929). When non-empty, `workflows` is
   * expected to lead with these (in declared order) and the dropdown renders a
   * "Recommended" group above an "Other workflows" group, split by a divider.
   */
  recommendedNames?: string[];
  value: string;
  onChange: (workflowName: string) => void;
  disabled?: boolean;
  /**
   * Fires whenever the dropdown closes (any path: pick, Esc, click-outside).
   * Used by the parent card to move focus back to the context textarea after
   * a keymap-driven pick flow.
   */
  onClose?: () => void;
}

function sourceBadgeClass(source: Workflow['source']): string {
  switch (source) {
    case 'project':
      return 'text-accent-bright';
    case 'global':
      return 'text-text-secondary';
    case 'bundled':
      return 'text-text-tertiary';
  }
}

function shortDescription(desc: string | null): string {
  if (desc === null) return '';
  const firstPara = desc.split(/\n\s*\n/)[0] ?? desc;
  return firstPara.replace(/\s+/g, ' ').trim();
}

function fuzzyMatch(name: string, query: string): boolean {
  if (query.length === 0) return true;
  return name.toLowerCase().includes(query.toLowerCase());
}

const DROPDOWN_WIDTH = 420;
const DROPDOWN_GAP = 4;
const DROPDOWN_MARGIN = 12;

interface AnchorPosition {
  top: number;
  left: number;
  maxHeight: number;
  placement: 'below' | 'above';
}

/**
 * Workflow combobox.
 *
 * The dropdown is rendered via a portal into `document.body` so it escapes
 * any ancestor `overflow`/`transform` clipping — notably the feed's
 * scroll container and the card's rounded-corner clip. Positioned with
 * `position: fixed` relative to the trigger button's bounding rect, with a
 * flip above/below heuristic when there isn't room underneath.
 */
export function WorkflowPicker({
  workflows,
  recommendedNames = [],
  value,
  onChange,
  disabled = false,
  onClose,
}: WorkflowPickerProps): ReactElement {
  const [open, setOpen] = useState(false);
  // Funnel every close path through one wrapper. A separate onClose effect
  // would false-fire on re-renders that toggle `open` for other reasons.
  const closePicker = (): void => {
    setOpen(false);
    onClose?.();
  };
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [anchor, setAnchor] = useState<AnchorPosition | null>(null);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(
    () => workflows.filter(w => fuzzyMatch(w.name, query)),
    [workflows, query]
  );

  // Group boundaries for the recommended/other divider. `filtered` preserves the
  // incoming order (recommended-first), so the first non-recommended row marks the
  // split. Headers only render when at least one recommended row survives the filter.
  const recommendedSet = useMemo(() => new Set(recommendedNames), [recommendedNames]);
  const firstRecommendedIdx = filtered.findIndex(w => recommendedSet.has(w.name));
  const firstOtherIdx = filtered.findIndex(w => !recommendedSet.has(w.name));
  const showGroups = firstRecommendedIdx !== -1 && recommendedNames.length > 0;

  // Compute anchor position when opening + on viewport resize/scroll.
  const reposition = (): void => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    const spaceBelow = window.innerHeight - rect.bottom - DROPDOWN_MARGIN;
    const spaceAbove = rect.top - DROPDOWN_MARGIN;
    const placement: AnchorPosition['placement'] =
      spaceBelow < 240 && spaceAbove > spaceBelow ? 'above' : 'below';
    const maxHeight = placement === 'below' ? spaceBelow : spaceAbove;

    // Keep panel on-screen horizontally.
    let left = rect.left;
    if (left + DROPDOWN_WIDTH > window.innerWidth - DROPDOWN_MARGIN) {
      left = Math.max(DROPDOWN_MARGIN, window.innerWidth - DROPDOWN_MARGIN - DROPDOWN_WIDTH);
    }

    const top = placement === 'below' ? rect.bottom + DROPDOWN_GAP : rect.top - DROPDOWN_GAP; // translate(-100%) applied via style
    setAnchor({ top, left, maxHeight: Math.max(180, maxHeight), placement });
  };

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const onScroll = (): void => {
      reposition();
    };
    window.addEventListener('resize', onScroll);
    window.addEventListener('scroll', onScroll, true);
    return (): void => {
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  // Close on click-outside (accounts for the portalled panel).
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      const t = e.target as Node | null;
      if (t === null) return;
      if (triggerRef.current?.contains(t) === true) return;
      if (panelRef.current?.contains(t) === true) return;
      closePicker();
    };
    document.addEventListener('mousedown', onDoc);
    return (): void => {
      document.removeEventListener('mousedown', onDoc);
    };
  }, [open]);

  // Reset search + seed cursor when opening.
  useEffect(() => {
    if (open) {
      setQuery('');
      const idx = workflows.findIndex(w => w.name === value);
      setCursor(idx >= 0 ? idx : 0);
      requestAnimationFrame(() => {
        searchRef.current?.focus();
      });
    }
  }, [open, value, workflows]);

  // Reset cursor if filter changes.
  useEffect(() => {
    setCursor(0);
  }, [query]);

  // Keep highlighted row in view when arrowing through.
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (list === null) return;
    const el = list.querySelector(`[data-idx="${cursor.toString()}"]`);
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [cursor, open]);

  const handleTriggerKey = (e: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (disabled) return;
    if (!open && (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown')) {
      e.preventDefault();
      setOpen(true);
    }
  };

  const handleSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closePicker();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor(c => Math.min(filtered.length - 1, c + 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor(c => Math.max(0, c - 1));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const pick = filtered[cursor];
      if (pick !== undefined) {
        onChange(pick.name);
        closePicker();
      }
      return;
    }
  };

  const current = workflows.find(w => w.name === value) ?? workflows[0];

  const panelStyle: CSSProperties | undefined =
    anchor === null
      ? undefined
      : {
          top: anchor.top,
          left: anchor.left,
          width: DROPDOWN_WIDTH,
          maxHeight: anchor.maxHeight,
          transform: anchor.placement === 'above' ? 'translateY(-100%)' : undefined,
        };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-keymap-workflow-trigger
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          if (open) closePicker();
          else setOpen(true);
        }}
        onKeyDown={handleTriggerKey}
        className="flex h-9 min-w-[140px] items-center gap-2 rounded border border-border bg-surface px-3 text-sm text-text-primary transition-colors hover:bg-surface-hover disabled:opacity-50"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="flex-1 truncate text-left font-mono">{current?.name ?? '—'}</span>
        <span
          aria-hidden="true"
          className="text-text-tertiary transition-transform"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
        >
          ▾
        </span>
      </button>

      {open && anchor !== null
        ? createPortal(
            <div
              ref={panelRef}
              role="listbox"
              className="console-root fixed z-[1000] flex flex-col rounded border border-border bg-surface-elevated shadow-2xl"
              style={panelStyle}
            >
              <div className="border-b border-border/60 p-2">
                <input
                  ref={searchRef}
                  value={query}
                  onChange={e => {
                    setQuery(e.target.value);
                  }}
                  onKeyDown={handleSearchKey}
                  placeholder="Filter workflows…"
                  className="h-7 w-full rounded border border-border bg-surface px-2 font-mono text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-border-bright focus:outline-none"
                />
              </div>

              <div ref={listRef} className="flex flex-1 flex-col overflow-y-auto py-1">
                {filtered.length === 0 ? (
                  <div className="px-3 py-4 text-[12px] text-text-tertiary">
                    No workflows match <span className="font-mono">{query}</span>.
                  </div>
                ) : (
                  filtered.map((w, i) => {
                    const active = i === cursor;
                    const selected = w.name === value;
                    const desc = shortDescription(w.description);
                    const header =
                      showGroups && i === firstRecommendedIdx
                        ? 'Recommended for this project'
                        : showGroups && i === firstOtherIdx
                          ? 'Other workflows'
                          : null;
                    return (
                      <Fragment key={`${w.source}-${w.name}`}>
                        {header !== null ? (
                          <div
                            role="presentation"
                            className={`px-3 pb-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-text-tertiary ${
                              i === 0 ? 'pt-1' : 'mt-1 border-t border-border/60 pt-2'
                            }`}
                          >
                            {header}
                          </div>
                        ) : null}
                        <button
                          type="button"
                          role="option"
                          data-idx={i.toString()}
                          aria-selected={selected}
                          onClick={() => {
                            onChange(w.name);
                            closePicker();
                          }}
                          onMouseEnter={() => {
                            setCursor(i);
                          }}
                          className={`flex h-11 w-full shrink-0 items-center gap-3 px-3 text-left transition-colors ${
                            active ? 'bg-surface-hover' : ''
                          }`}
                        >
                          <div className="flex min-w-0 flex-1 items-baseline gap-2">
                            <span className="shrink-0 font-mono text-[13px] text-text-primary">
                              {w.name}
                            </span>
                            {desc.length > 0 ? (
                              <span className="min-w-0 truncate text-[11px] text-text-tertiary">
                                {desc}
                              </span>
                            ) : null}
                          </div>
                          <span
                            className={`shrink-0 text-[9px] uppercase tracking-[0.16em] ${sourceBadgeClass(w.source)}`}
                          >
                            {w.source}
                          </span>
                          {selected ? (
                            <span
                              aria-hidden
                              className="shrink-0 font-mono text-[11px] text-accent-bright"
                            >
                              ✓
                            </span>
                          ) : null}
                        </button>
                      </Fragment>
                    );
                  })
                )}
              </div>

              <div className="border-t border-border/60 px-3 py-1.5 font-mono text-[10px] text-text-tertiary">
                {filtered.length.toString()} of {workflows.length.toString()} · ↑↓ navigate · ↵
                select · esc close
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}
