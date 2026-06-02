/**
 * Better Auth React client (opt-in web auth).
 *
 * Same-origin posture: we omit `baseURL` so the client targets the current
 * origin's `/api/auth/*`. In production the SPA and API share an origin; in dev
 * the Vite `/api` proxy forwards to the backend, keeping the session cookie
 * first-party. This only matters when the server has web auth enabled
 * (GET /api/auth/status → { enabled: true }); when disabled, `useSession` still
 * fires its request but the result is ignored after the status check.
 */
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient();

export const { useSession, signIn, signUp, signOut } = authClient;
