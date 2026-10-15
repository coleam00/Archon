/**
 * Env var through which Archon hands Pi a per-run auth.json. Core's delivery writes the
 * file and sets this. The Pi provider uses that file as Pi's auth store only for a
 * provider it holds an entry for; other providers keep the user's own Pi logins.
 */
export const PI_AUTH_PATH_ENV = 'ARCHON_PI_AUTH_PATH';
