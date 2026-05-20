import { create } from 'zustand';
import type { ThemePreset } from '../theme/ThemeProvider';

const STORAGE_KEY = 'archon-studio:theme';
const VALID: ThemePreset[] = ['archon-dark', 'light', 'high-contrast'];

interface ThemeState {
  preset: ThemePreset;
  setPreset: (p: ThemePreset) => void;
  hydrate: () => void;
}

export const useThemeStore = create<ThemeState>(set => ({
  preset: 'archon-dark',
  setPreset: (p): void => {
    try {
      localStorage.setItem(STORAGE_KEY, p);
    } catch {
      // private mode, etc. — non-fatal
    }
    set({ preset: p });
  },
  hydrate: (): void => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw && (VALID as string[]).includes(raw)) set({ preset: raw as ThemePreset });
    } catch {
      // ignore
    }
  },
}));
