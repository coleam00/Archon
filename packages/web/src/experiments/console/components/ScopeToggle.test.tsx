import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { HttpError } from '../lib/http';
import { UserScopeSlot, userScopeStatus } from './ScopeToggle';

function renderSlot(prefsError: Error | undefined): string {
  return renderToStaticMarkup(
    <UserScopeSlot
      status={userScopeStatus(prefsError)}
      scope="install"
      onChange={() => undefined}
    />
  );
}

describe('UserScopeSlot', () => {
  test('a loaded prefs read shows the scope toggle', () => {
    const html = renderSlot(undefined);
    expect(html).toContain('Just me');
    expect(html).not.toContain('Couldn’t load');
  });

  test('a 401 (no web identity) hides the toggle without an error', () => {
    expect(renderSlot(new HttpError(401, '/api/auth/me/ai-prefs', ''))).toBe('');
  });

  test('any other failure reports the load failure instead of the toggle', () => {
    const serverError = new HttpError(
      500,
      '/api/auth/me/ai-prefs',
      '{"error":"Failed to load AI preferences"}'
    );
    for (const error of [serverError, new TypeError('Failed to fetch')]) {
      const html = renderSlot(error);
      expect(html).toContain('Couldn’t load your personal settings');
      expect(html).not.toContain('Just me');
    }
    expect(renderSlot(serverError)).toContain('Failed to load AI preferences');
  });
});
