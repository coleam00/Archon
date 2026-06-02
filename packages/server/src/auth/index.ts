/**
 * Opt-in web authentication (Better Auth) barrel.
 *
 * See ./config for the opt-in gate + pure helpers and ./instance for the lazy
 * Better Auth singleton (`getAuth`).
 */
export {
  isWebAuthEnabled,
  assertWebAuthAtBoot,
  parseAllowedEmails,
  isEmailAllowed,
  getSignupMode,
  MIN_BETTER_AUTH_SECRET_LENGTH,
} from './config';
export { getAuth, resetAuthForTest, type AuthInstance } from './instance';
