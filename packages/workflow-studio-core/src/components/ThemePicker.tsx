import { useThemeStore } from '../store/theme-store';
import type { ThemePreset } from '../theme/ThemeProvider';
import styles from './ThemePicker.module.css';

const PRESETS: { id: ThemePreset; label: string; glyph: string }[] = [
  { id: 'archon-dark', label: 'archon-dark', glyph: '◐' },
  { id: 'light', label: 'light', glyph: '☀' },
  { id: 'high-contrast', label: 'high-contrast', glyph: '◑' },
];

export function ThemePicker(): JSX.Element {
  const preset = useThemeStore(s => s.preset);
  const setPreset = useThemeStore(s => s.setPreset);
  return (
    <div role="group" aria-label="Theme" className={styles.group}>
      {PRESETS.map(p => (
        <button
          key={p.id}
          type="button"
          aria-label={`Theme: ${p.label}`}
          aria-pressed={preset === p.id}
          className={styles.button}
          onClick={() => {
            setPreset(p.id);
          }}
        >
          {p.glyph}
        </button>
      ))}
    </div>
  );
}
