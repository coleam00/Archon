import { create } from 'zustand';

const STORAGE_KEY = 'archon-studio:user-library';
const STORAGE_VERSION = 1;

export interface UserCommand {
  /** Stable id for delete/update operations. */
  id: string;
  /** The command name — written into BuilderNode.data.command when dropped. */
  name: string;
  /** Optional description shown as a subtitle in the library. */
  description?: string;
  /** ms epoch for created-time ordering. */
  createdAt: number;
}

export interface UserSnippet {
  id: string;
  name: string;
  /** Serialized workflow YAML for the saved subgraph. */
  yaml: string;
  createdAt: number;
}

interface PersistedShape {
  v: number;
  userCommands: UserCommand[];
  userSnippets: UserSnippet[];
}

interface UserLibraryState {
  userCommands: UserCommand[];
  userSnippets: UserSnippet[];
  hydrated: boolean;

  hydrate: () => void;
  addUserCommand: (input: { name: string; description?: string }) => UserCommand;
  removeUserCommand: (id: string) => void;
  addUserSnippet: (input: { name: string; yaml: string }) => UserSnippet;
  removeUserSnippet: (id: string) => void;
  /** Test helper — wipes both lists and persisted state. */
  _resetForTest: () => void;
}

function safeRead(): PersistedShape | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'v' in parsed &&
      (parsed as { v: unknown }).v === STORAGE_VERSION &&
      Array.isArray((parsed as PersistedShape).userCommands) &&
      Array.isArray((parsed as PersistedShape).userSnippets)
    ) {
      return parsed as PersistedShape;
    }
  } catch {
    // private mode / corrupt JSON — silently start fresh.
  }
  return null;
}

function safeWrite(state: { userCommands: UserCommand[]; userSnippets: UserSnippet[] }): void {
  try {
    const payload: PersistedShape = {
      v: STORAGE_VERSION,
      userCommands: state.userCommands,
      userSnippets: state.userSnippets,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // quota / private mode — non-fatal
  }
}

function makeId(prefix: string): string {
  // Avoid pulling crypto for a non-security id. ms + small random suffix is
  // collision-free at human timescales and fine across reloads.
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useUserLibraryStore = create<UserLibraryState>((set, get) => ({
  userCommands: [],
  userSnippets: [],
  hydrated: false,

  hydrate: (): void => {
    const persisted = safeRead();
    if (persisted) {
      set({
        userCommands: persisted.userCommands,
        userSnippets: persisted.userSnippets,
        hydrated: true,
      });
    } else {
      set({ hydrated: true });
    }
  },

  addUserCommand: ({ name, description }): UserCommand => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('command name required');
    const entry: UserCommand = {
      id: makeId('cmd'),
      name: trimmed,
      description: description?.trim() || undefined,
      createdAt: Date.now(),
    };
    const next = [...get().userCommands, entry];
    set({ userCommands: next });
    safeWrite({ userCommands: next, userSnippets: get().userSnippets });
    return entry;
  },

  removeUserCommand: (id): void => {
    const next = get().userCommands.filter(c => c.id !== id);
    set({ userCommands: next });
    safeWrite({ userCommands: next, userSnippets: get().userSnippets });
  },

  addUserSnippet: ({ name, yaml }): UserSnippet => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('snippet name required');
    if (!yaml.trim()) throw new Error('snippet yaml required');
    const entry: UserSnippet = {
      id: makeId('snip'),
      name: trimmed,
      yaml,
      createdAt: Date.now(),
    };
    const next = [...get().userSnippets, entry];
    set({ userSnippets: next });
    safeWrite({ userCommands: get().userCommands, userSnippets: next });
    return entry;
  },

  removeUserSnippet: (id): void => {
    const next = get().userSnippets.filter(s => s.id !== id);
    set({ userSnippets: next });
    safeWrite({ userCommands: get().userCommands, userSnippets: next });
  },

  _resetForTest: (): void => {
    set({ userCommands: [], userSnippets: [], hydrated: false });
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  },
}));
