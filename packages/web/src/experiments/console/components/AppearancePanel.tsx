import { type ReactElement } from 'react';
import { SettingsSection } from './SettingsSection';
import {
  formatClockIn,
  getClockFormat,
  setClockFormat,
  useClock,
  type ClockFormat,
} from '../lib/clock';

const OPTIONS: readonly { value: ClockFormat; label: string }[] = [
  { value: '12', label: '12-hour' },
  { value: '24', label: '24-hour' },
];

/**
 * How the console renders things, as opposed to what it does.
 *
 * Only the clock for now. The default follows the browser's locale, so this
 * exists to override that guess rather than to make everyone choose.
 */
export function AppearancePanel(): ReactElement {
  // Subscribing here is what makes the preview update the instant you pick.
  const clock = useClock();
  const active = getClockFormat();
  // A fixed afternoon instant, so the preview actually shows the difference —
  // a morning time looks nearly identical in both formats.
  const sample = new Date();
  sample.setHours(20, 6, 24, 0);
  const sampleIso = sample.toISOString();

  return (
    <SettingsSection title="Appearance">
      <div className="flex items-center justify-between gap-4 py-2">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-text-primary">Time format</div>
          <div className="mt-0.5 text-[11.5px] text-text-tertiary">
            How timestamps on messages and runs are shown. Defaults to your browser&apos;s locale.
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {OPTIONS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setClockFormat(value);
              }}
              aria-pressed={active === value}
              className={`rounded-[8px] border px-2.5 py-1 font-mono text-[11px] transition-colors ${
                active === value
                  ? 'text-text-primary'
                  : 'text-text-tertiary hover:text-text-secondary'
              }`}
              style={{
                borderColor: active === value ? 'var(--border-bright)' : 'var(--border)',
                background: active === value ? 'var(--surface-elevated)' : 'transparent',
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-baseline gap-3 border-t border-border pt-2.5">
        <span className="font-mono text-[10.5px] tracking-[0.12em] text-text-tertiary">
          PREVIEW
        </span>
        <span className="font-mono text-[12.5px] text-text-secondary">{clock(sampleIso)}</span>
        <span className="font-mono text-[10.5px] text-text-tertiary">
          (other: {formatClockIn(sampleIso, active === '12' ? '24' : '12')})
        </span>
      </div>
    </SettingsSection>
  );
}
