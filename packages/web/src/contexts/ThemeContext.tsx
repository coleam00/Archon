import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

type Theme = 'light' | 'dark';

interface ThemeContextValue {
  theme: Theme;
  toggleTheme: () => void;
  compactLayout: boolean;
  toggleCompactLayout: () => void;
}

// eslint-disable-next-line @typescript-eslint/naming-convention
const ThemeContext = createContext<ThemeContextValue>({
  theme: 'dark',
  toggleTheme: (): void => undefined,
  compactLayout: false,
  toggleCompactLayout: (): void => undefined,
});

export function ThemeProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem('archon-theme') as Theme | null;
    return saved ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  });

  const [compactLayout, setCompactLayout] = useState<boolean>(() => {
    return localStorage.getItem('archon-compact-layout') === 'true';
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('archon-theme', theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem('archon-compact-layout', String(compactLayout));
    document.documentElement.classList.toggle('compact-layout', compactLayout);
  }, [compactLayout]);

  const toggleTheme = (): void => {
    setTheme(t => (t === 'dark' ? 'light' : 'dark'));
  };

  const toggleCompactLayout = (): void => {
    setCompactLayout(v => !v);
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, compactLayout, toggleCompactLayout }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = (): ThemeContextValue => useContext(ThemeContext);
