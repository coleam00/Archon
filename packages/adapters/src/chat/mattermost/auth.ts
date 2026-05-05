export function parseAllowedUserIds(envValue: string | undefined): string[] {
  if (!envValue || envValue.trim() === '') {
    return [];
  }

  return envValue
    .split(',')
    .map(id => id.trim())
    .filter(id => id !== '' && /^[a-z0-9]+$/i.test(id));
}

export function isMattermostUserAuthorized(
  userId: string | undefined,
  allowedIds: string[]
): boolean {
  if (allowedIds.length === 0) {
    return true;
  }

  if (userId === undefined || userId.trim() === '') {
    return false;
  }

  return allowedIds.includes(userId);
}
