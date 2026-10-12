// Database constraint errors can include identity values in message/detail;
// GitHub identity conflicts also include the login in their message; vendor API
// errors (for example discord.js DiscordAPIError) can echo the request body.
// Only the error class and a scalar machine code are safe to log.
export function identityErrorLogFields(error: unknown): {
  errorType: string;
  errorCode?: string | number;
} {
  return {
    errorType: error instanceof Error ? error.name : typeof error,
    ...(error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (typeof error.code === 'string' || typeof error.code === 'number')
      ? { errorCode: error.code }
      : {}),
  };
}
