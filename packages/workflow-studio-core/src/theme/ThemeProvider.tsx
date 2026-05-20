import { useEffect, type ReactNode } from 'react';
import { useThemeStore } from '../store/theme-store';

export type ThemePreset = 'archon-dark' | 'light' | 'high-contrast' | 'inherit';

export function ThemeProvider({
  preset,
  children,
}: {
  preset?: ThemePreset;
  children: ReactNode;
}): JSX.Element {
  const storePreset = useThemeStore(s => s.preset);
  const effective = preset ?? storePreset;
  useEffect(() => {
    document.documentElement.dataset.studioTheme = effective;
  }, [effective]);
  return <>{children}</>;
}
