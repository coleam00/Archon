import { timingSafeEqual } from 'crypto';
import type { JiraUser } from './types';

export function parseAllowedUsers(envValue: string | undefined): string[] {
  if (!envValue || envValue.trim() === '') {
    return [];
  }

  return envValue
    .split(',')
    .map(user => user.trim().toLowerCase())
    .filter(user => user !== '');
}

export function isJiraUserAuthorized(user: JiraUser | undefined, allowedUsers: string[]): boolean {
  if (allowedUsers.length === 0) {
    return true;
  }

  if (!user) {
    return false;
  }

  const candidates = [user.accountId, user.emailAddress, user.displayName, user.name, user.key]
    .filter((value): value is string => Boolean(value?.trim()))
    .map(value => value.toLowerCase());

  return candidates.some(value => allowedUsers.includes(value));
}

export function verifyWebhookToken(receivedToken: string, expectedSecret: string): boolean {
  if (!receivedToken || !expectedSecret) return false;

  const receivedBuf = Buffer.from(receivedToken);
  const expectedBuf = Buffer.from(expectedSecret);

  if (receivedBuf.length !== expectedBuf.length) {
    return false;
  }

  return timingSafeEqual(receivedBuf, expectedBuf);
}
