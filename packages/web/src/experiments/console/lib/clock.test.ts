import { describe, test, expect } from 'bun:test';
import { formatClockIn, localeClockFormat, parseClockFormat } from './clock';

// A fixed instant, expressed both ways the app receives timestamps.
const EVENING = '2026-06-13T20:06:24.000Z';
const NAIVE_EVENING = '2026-06-13 20:06:24';

describe('parseClockFormat', () => {
  test('accepts the two real values', () => {
    expect(parseClockFormat('12')).toBe('12');
    expect(parseClockFormat('24')).toBe('24');
  });

  test('anything else is no preference, so the locale decides', () => {
    expect(parseClockFormat(null)).toBeNull();
    expect(parseClockFormat(undefined)).toBeNull();
    expect(parseClockFormat('')).toBeNull();
    expect(parseClockFormat('12h')).toBeNull();
    expect(parseClockFormat('am/pm')).toBeNull();
  });
});

describe('localeClockFormat', () => {
  test('a 12-hour locale gives 12', () => {
    expect(localeClockFormat(() => true)).toBe('12');
  });

  test('a 24-hour locale gives 24', () => {
    expect(localeClockFormat(() => false)).toBe('24');
  });

  test('no strong convention falls back to 24, the unambiguous one', () => {
    expect(localeClockFormat(() => undefined)).toBe('24');
  });

  test('a throwing Intl does not take the app down', () => {
    expect(
      localeClockFormat(() => {
        throw new Error('no Intl');
      })
    ).toBe('24');
  });
});

describe('formatClockIn', () => {
  test('24-hour pads to a fixed width so columns line up', () => {
    const out = formatClockIn(EVENING, '24');
    expect(out).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  test('12-hour carries a meridiem and does not pad the hour', () => {
    const out = formatClockIn(EVENING, '12');
    expect(out).toMatch(/^\d{1,2}:\d{2}:\d{2} (AM|PM)$/);
  });

  test('naive and Z-suffixed forms of one instant agree', () => {
    // The naive shape is what SQLite's datetime('now') produces; both are UTC.
    expect(formatClockIn(NAIVE_EVENING, '12')).toBe(formatClockIn(EVENING, '12'));
    expect(formatClockIn(NAIVE_EVENING, '24')).toBe(formatClockIn(EVENING, '24'));
  });

  test('midnight is 12 AM and noon is 12 PM, never 0', () => {
    // Local-time construction, so this holds whatever the host timezone is.
    const at = (h: number): string => {
      const d = new Date();
      d.setHours(h, 5, 0, 0);
      return formatClockIn(d.toISOString(), '12');
    };
    expect(at(0)).toStartWith('12:05:00 AM');
    expect(at(12)).toStartWith('12:05:00 PM');
    expect(at(13)).toStartWith('1:05:00 PM');
    expect(at(11)).toStartWith('11:05:00 AM');
  });
});
