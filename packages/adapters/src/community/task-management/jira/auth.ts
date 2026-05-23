import { timingSafeEqual } from 'crypto';

export function parseAllowedAccountIds(envValue: string | undefined): string[] {
  if (!envValue || envValue.trim() === '') return [];
  return envValue
    .split(',')
    .map(id => id.trim())
    .filter(id => id !== '');
}

export function isAccountIdAuthorized(
  accountId: string | undefined,
  allowedIds: string[]
): boolean {
  if (allowedIds.length === 0) return true;
  if (!accountId || accountId.trim() === '') return false;
  return allowedIds.includes(accountId);
}

export function verifyWebhookSecret(received: string, expected: string): boolean {
  if (!received || !expected) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
