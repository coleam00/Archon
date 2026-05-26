import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react';
import { useNavigate } from 'react-router';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import * as skill from '../skills';
import type { Project } from '../primitives/project';
import { formatProjectLocator } from '../lib/format';

interface ProjectPaletteProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Cmd-K-style overlay for jumping to a project. Opened via `p` anywhere.
 *
 * Match is character-subsequence ("subsequence fuzzy") — `c00/A` matches
 * `coleam00/Archon` — not a full Levenshtein scorer; good enough for short
 * project lists, no extra deps.
 *
 * Closes on Esc / outside-click / Enter (after navigating).
 */
export function ProjectPalette({ open, onClose }: ProjectPaletteProps): ReactElement | null {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);

  const { data: projects } = useEntity<Project[]>(K.projects, () => skill.listProjects());

  // Reset query + selection each time the palette opens. Focus is called
  // synchronously — the input ref is committed by React before useEffect
  // runs, so there's no need to defer with rAF, and deferring leaves a
  // one-frame window where Enter from the keymap can leak through to the
  // page underneath.
  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
      inputRef.current?.focus();
    }
  }, [open]);

  const matches = useMemo<Project[]>(() => {
    const list = projects ?? [];
    const q = query.trim().toLowerCase();
    if (q.length === 0) return list;
    return list.filter(p => subsequence(p.name.toLowerCase(), q));
  }, [projects, query]);

  // Clamp index when the result set shrinks.
  useEffect(() => {
    if (index >= matches.length) setIndex(Math.max(0, matches.length - 1));
  }, [matches.length, index]);

  if (!open) return null;

  const choose = (project: Project): void => {
    navigate(`/console/p/${project.id}`);
    onClose();
  };

  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex(i => Math.min(matches.length - 1, i + 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex(i => Math.max(0, i - 1));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const picked = matches[index];
      if (picked !== undefined) choose(picked);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  const listboxId = 'project-palette-listbox';
  const activeOptionId =
    matches[index] !== undefined ? `project-palette-option-${matches[index].id}` : undefined;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Pick a project"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[12vh]"
      onClick={onClose}
    >
      <div
        onClick={e => {
          e.stopPropagation();
        }}
        className="w-full max-w-xl overflow-hidden rounded-md border border-border bg-surface-elevated shadow-2xl"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={e => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={onKey}
          placeholder="Pick a project…"
          aria-label="Pick a project"
          role="combobox"
          aria-expanded="true"
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          className="w-full border-b border-border bg-transparent px-4 py-3 text-[15px] text-text-primary placeholder:text-text-tertiary focus:outline-none"
        />
        <ul
          id={listboxId}
          role="listbox"
          aria-label="Projects"
          className="max-h-[50vh] overflow-y-auto py-1"
        >
          {matches.length === 0 ? (
            <li className="px-4 py-3 text-[12px] text-text-tertiary">No projects match.</li>
          ) : (
            matches.map((p, i) => {
              const selected = i === index;
              return (
                <li key={p.id} role="presentation">
                  <button
                    id={`project-palette-option-${p.id}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      choose(p);
                    }}
                    onMouseEnter={() => {
                      setIndex(i);
                    }}
                    className={`relative flex w-full items-baseline gap-3 px-4 py-2 text-left transition-colors ${
                      selected ? 'bg-surface-hover' : 'hover:bg-surface-hover'
                    }`}
                  >
                    {selected ? (
                      <span
                        aria-hidden
                        className="brand-bar pointer-events-none absolute left-0 top-1 bottom-1 w-0.5 rounded-full"
                      />
                    ) : null}
                    <span className="text-[13px] font-medium text-text-primary">{p.name}</span>
                    <span className="truncate font-mono text-[10.5px] text-text-tertiary">
                      {formatProjectLocator(p)}
                    </span>
                  </button>
                </li>
              );
            })
          )}
        </ul>
        <footer className="flex items-center justify-between border-t border-border px-4 py-2 font-mono text-[10px] text-text-tertiary">
          <span>↑↓ move · ↵ open · esc cancel</span>
          <span>
            {matches.length} of {projects?.length ?? 0}
          </span>
        </footer>
      </div>
    </div>
  );
}

/** True if `needle` is a subsequence of `haystack` (case-folded by caller). */
function subsequence(haystack: string, needle: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i += 1;
    if (i === needle.length) return true;
  }
  return i === needle.length;
}
