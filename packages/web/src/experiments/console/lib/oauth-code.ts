/**
 * Normalize whatever a user pastes from a manual (claude) subscription login
 * into the `code#state` form the bridge expects.
 *
 * The browser redirect on a HEADLESS server lands on the *server's*
 * `localhost:<port>/callback?code=…&state=…` (unreachable from the user's
 * machine → "site can't be reached"); the user copies that URL or just the code.
 * Accepts a full URL, a bare `code=…&state=…` query, an explicit `code#state`,
 * or a bare code. (On a LOCAL install the callback server resolves the login
 * itself and no paste is needed.)
 */
export function normalizeOAuthCode(pasted: string): string {
  const v = pasted.trim();
  if (v.includes('code=')) {
    try {
      const query = v.includes('?') ? v.slice(v.indexOf('?')) : `?${v}`;
      const params = new URLSearchParams(query);
      const code = params.get('code');
      const state = params.get('state');
      if (code) return state ? `${code}#${state}` : code;
    } catch (err) {
      // Couldn't parse it as a URL/query — surface (not swallow) and send as-is.
      console.warn('normalizeOAuthCode: failed to parse pasted value; sending as-is', err);
    }
  }
  return v;
}
