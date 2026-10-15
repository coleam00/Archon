/**
 * Env var through which Archon hands Pi a per-run auth.json. Core's delivery writes the
 * file and sets this; the Pi provider layers that file over the user's own Pi logins.
 */
export const PI_AUTH_PATH_ENV = 'ARCHON_PI_AUTH_PATH';
