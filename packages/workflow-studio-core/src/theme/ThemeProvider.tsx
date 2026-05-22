import { useEffect, type ReactNode } from 'react';

export type ThemePreset = 'archon-dark' | 'light' | 'high-contrast' | 'inherit';

export function ThemeProvider({
  preset = 'inherit',
  children,
}: {
  preset?: ThemePreset;
  children: ReactNode;
}): JSX.Element {
  useEffect(() => {
    document.documentElement.dataset.studioTheme = preset;
  }, [preset]);
  return <>{children}</>;
}
