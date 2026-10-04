import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { UpdateBanner, dismissUpdate } from './UpdateBanner';
import { set, invalidate } from '../store/cache';
import { K } from '../store/keys';

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
afterEach(() => {
  invalidate(K.updateCheck);
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('UpdateBanner', () => {
  test('dismissal survives a remount and a newer release reappears', () => {
    const stored = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
      },
    });
    const update = {
      updateAvailable: true,
      currentVersion: '0.11.1',
      latestVersion: '0.12.0',
      releaseUrl: 'https://example.com/release',
    };
    set(K.updateCheck, update);
    const html = renderToStaticMarkup(<UpdateBanner />);
    expect(html).toContain('0.12.0');
    expect(html).toContain('https://archon.diy/getting-started/updating/');
    expect(html).toContain('Dismiss update notice');
    dismissUpdate(update.latestVersion);
    expect(renderToStaticMarkup(<UpdateBanner />)).toBe('');
    set(K.updateCheck, { ...update, latestVersion: '0.13.0' });
    expect(renderToStaticMarkup(<UpdateBanner />)).toContain('0.13.0');
    set(K.updateCheck, { ...update, updateAvailable: false });
    expect(renderToStaticMarkup(<UpdateBanner />)).toBe('');
  });

  test('missing update data does not show a banner', () => {
    expect(renderToStaticMarkup(<UpdateBanner />)).toBe('');
  });
});
