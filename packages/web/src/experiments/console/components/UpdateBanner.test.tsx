import { afterEach, describe, expect, test } from 'bun:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UpdateBanner } from './UpdateBanner';
import { set, invalidate } from '../store/cache';
import { K } from '../store/keys';

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
afterEach(() => {
  invalidate(K.updateCheck);
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

type BannerElement = ReactElement<{ children: ReactElement<{ onClick?: () => void }>[] }>;

/** Render statically and return the dismiss button's click handler. */
function renderBanner(): { html: string; dismiss?: () => void } {
  const rendered: { element?: BannerElement | null } = {};
  function Probe(): ReactElement | null {
    rendered.element = UpdateBanner() as BannerElement | null;
    return rendered.element;
  }
  const html = renderToStaticMarkup(<Probe />);
  const button = rendered.element?.props.children.find(child => child.type === 'button');
  return { html, dismiss: button?.props.onClick };
}

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
    const { html, dismiss } = renderBanner();
    expect(html).toContain('0.12.0');
    expect(html).toContain('https://archon.diy/getting-started/updating/');
    dismiss?.();
    expect(renderBanner().html).toBe('');
    set(K.updateCheck, { ...update, latestVersion: '0.13.0' });
    expect(renderBanner().html).toContain('0.13.0');
    set(K.updateCheck, { ...update, latestVersion: '0.14.0', updateAvailable: false });
    expect(renderBanner().html).toBe('');
  });

  test('missing update data does not show a banner', () => {
    expect(renderBanner().html).toBe('');
  });
});
