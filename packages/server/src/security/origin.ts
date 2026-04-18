/**
 * Origin allowlist for the Web UI and API.
 *
 * Archon has no in-app auth. The server binds to 127.0.0.1 by default, which
 * prevents LAN access. This module adds a second layer: restrict which browser
 * origins can make requests to /api/*, protecting against CSRF from malicious
 * tabs on the same machine.
 *
 * Config precedence (highest first):
 *   1. ALLOWED_ORIGINS (comma-separated list, or "*")
 *   2. WEB_UI_ORIGIN   (legacy single-value form)
 *   3. default: any loopback origin (localhost / 127.0.0.1 / ::1 on any port)
 */

export type OriginAllowlist =
  | { mode: 'any' }
  | { mode: 'loopback' }
  | { mode: 'list'; origins: ReadonlySet<string> };

/**
 * Parse the allowlist from environment variables.
 * Exported for testing; call `getAllowlist()` for the runtime-config version.
 */
export function parseAllowlist(
  allowedOrigins: string | undefined,
  webUiOrigin: string | undefined
): OriginAllowlist {
  const raw = (allowedOrigins ?? webUiOrigin ?? '').trim();
  if (raw === '') return { mode: 'loopback' };
  if (raw === '*') return { mode: 'any' };
  const origins = raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (origins.length === 0) return { mode: 'loopback' };
  return { mode: 'list', origins: new Set(origins) };
}

/** Compute the runtime allowlist from process.env. */
export function getAllowlist(): OriginAllowlist {
  return parseAllowlist(process.env.ALLOWED_ORIGINS, process.env.WEB_UI_ORIGIN);
}

/**
 * True when the given origin resolves to the loopback interface on any port.
 * Handles IPv4 (127.0.0.1), IPv6 (::1), and the `localhost` alias.
 */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    // URL parser wraps IPv6 literals in brackets. Strip them for comparison.
    const host = u.hostname.startsWith('[') ? u.hostname.slice(1, -1) : u.hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * Whether the origin is accepted by the allowlist.
 * `undefined`/empty origins always pass — same-origin requests often omit the
 * header, and non-browser clients (curl, node scripts) do too. The 127.0.0.1
 * bind is what keeps those non-browser clients local.
 */
export function matchOrigin(origin: string | undefined, allowlist: OriginAllowlist): boolean {
  if (!origin) return true;
  if (allowlist.mode === 'any') return true;
  if (allowlist.mode === 'loopback') return isLoopbackOrigin(origin);
  return allowlist.origins.has(origin);
}

/** HTTP methods that can mutate server state. */
export const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
