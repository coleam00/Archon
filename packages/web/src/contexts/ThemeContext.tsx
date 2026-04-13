import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

type Theme = 'light' | 'dark';

interface ThemeContextValue {
  theme: Theme;
  toggleTheme: () => void;
}

// eslint-disable-next-line @typescript-eslint/naming-convention
const ThemeContext = createContext<ThemeContextValue>({
  theme: 'dark',
  toggleTheme: (): void => undefined,
});

export function ThemeProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem('archon-theme') as Theme | null;
    return saved ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('archon-theme', theme);
  }, [theme]);

  const toggleTheme = (): void => {
    setTheme(t => (t === 'dark' ? 'light' : 'dark'));
  };

  return <ThemeContext.Provider value={{ theme, toggleTheme }}>{children}</ThemeContext.Provider>;
}

export const useTheme = (): ThemeContextValue => useContext(ThemeContext);
