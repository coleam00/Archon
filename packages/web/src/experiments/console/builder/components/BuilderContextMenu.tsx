/**
 * Right-click context menu for the builder canvas. A small, dependency-free
 * floating menu positioned at the cursor (fixed-position, clamped to the
 * viewport). The canvas owns *when* it opens and *what* entries it shows; this
 * component only renders the entry tree and handles dismissal (outside click /
 * Escape / scroll / resize). Every action routes back through the editor
 * reducer via the callbacks baked into each entry.
 *
 * Submenus open to the right on hover (flipping left near the viewport edge) so
 * the pane menu can offer "Add node here ▸" without a long flat list.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';

export interface MenuActionItem {
  kind: 'item';
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Keyboard-shortcut hint shown right-aligned (purely informational). */
  hint?: string;
}

export interface MenuSeparator {
  kind: 'separator';
}

export interface MenuSubmenu {
  kind: 'submenu';
  label: string;
  items: MenuActionItem[];
}

export type MenuEntry = MenuActionItem | MenuSeparator | MenuSubmenu;

interface BuilderContextMenuProps {
  /** Cursor position (viewport coords) where the menu should anchor. */
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose: () => void;
}

const MENU_MIN_WIDTH = 180;

/** Clamp a desired (x, y) so the menu of the given size stays on-screen. */
function clamp(x: number, y: number, width: number, height: number): { x: number; y: number } {
  const margin = 8;
  const maxX = window.innerWidth - width - margin;
  const maxY = window.innerHeight - height - margin;
  return {
    x: Math.max(margin, Math.min(x, maxX)),
    y: Math.max(margin, Math.min(y, maxY)),
  };
}

export function BuilderContextMenu({
  x,
  y,
  entries,
  onClose,
}: BuilderContextMenuProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [openSub, setOpenSub] = useState<number | null>(null);

  // Position after measuring so the menu never spills off the viewport.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const rect = el.getBoundingClientRect();
    setPos(clamp(x, y, rect.width, rect.height));
  }, [x, y]);

  // Dismiss on outside interaction. `contextmenu` is included so a second
  // right-click elsewhere closes this menu (the canvas opens a fresh one).
  useEffect(() => {
    const onPointer = (e: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onPointer);
    window.addEventListener('contextmenu', onPointer);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    return (): void => {
      window.removeEventListener('mousedown', onPointer);
      window.removeEventListener('contextmenu', onPointer);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  const runItem = (item: MenuActionItem): void => {
    if (item.disabled === true) return;
    item.onSelect();
    onClose();
  };

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 rounded-lg border border-border bg-surface-elevated py-1 shadow-xl"
      style={{ left: pos.x, top: pos.y, minWidth: MENU_MIN_WIDTH }}
      onContextMenu={(e): void => {
        // Never let the browser menu surface over our own menu.
        e.preventDefault();
      }}
    >
      {entries.map((entry, i) => {
        if (entry.kind === 'separator') {
          return <div key={`sep-${i}`} className="my-1 h-px bg-border" aria-hidden />;
        }
        if (entry.kind === 'submenu') {
          return (
            <Submenu
              key={`sub-${i}`}
              entry={entry}
              open={openSub === i}
              onOpen={(): void => {
                setOpenSub(i);
              }}
              onCloseAll={onClose}
            />
          );
        }
        return (
          <button
            key={`item-${i}`}
            type="button"
            role="menuitem"
            disabled={entry.disabled === true}
            onMouseEnter={(): void => {
              setOpenSub(null);
            }}
            onClick={(): void => {
              runItem(entry);
            }}
            className={`flex w-full items-center justify-between gap-6 px-3 py-1.5 text-left text-[12.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              entry.danger === true
                ? 'text-[var(--error)] hover:bg-surface-hover'
                : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
            }`}
          >
            <span>{entry.label}</span>
            {entry.hint !== undefined ? (
              <span className="font-mono text-[10.5px] text-text-tertiary">{entry.hint}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

interface SubmenuProps {
  entry: MenuSubmenu;
  open: boolean;
  onOpen: () => void;
  onCloseAll: () => void;
}

function Submenu({ entry, open, onOpen, onCloseAll }: SubmenuProps): ReactElement {
  const itemRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [flip, setFlip] = useState(false);

  useLayoutEffect(() => {
    if (!open) return;
    const item = itemRef.current;
    const panel = panelRef.current;
    if (item === null || panel === null) return;
    const itemRect = item.getBoundingClientRect();
    const panelWidth = panel.getBoundingClientRect().width;
    // Flip to the left when the right-hand panel would overflow the viewport.
    setFlip(itemRect.right + panelWidth + 8 > window.innerWidth);
  }, [open]);

  return (
    <div className="relative" onMouseEnter={onOpen}>
      <button
        ref={itemRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-6 px-3 py-1.5 text-left text-[12.5px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
      >
        <span>{entry.label}</span>
        <span aria-hidden className="text-text-tertiary">
          ›
        </span>
      </button>
      {open ? (
        <div
          ref={panelRef}
          role="menu"
          className="absolute top-[-5px] rounded-lg border border-border bg-surface-elevated py-1 shadow-xl"
          style={{
            minWidth: MENU_MIN_WIDTH,
            [flip ? 'right' : 'left']: '100%',
          }}
        >
          {entry.items.map((item, i) => (
            <button
              key={`subitem-${i}`}
              type="button"
              role="menuitem"
              disabled={item.disabled === true}
              onClick={(): void => {
                if (item.disabled === true) return;
                item.onSelect();
                onCloseAll();
              }}
              className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12.5px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
