// Database constraint errors can include identity values in message/detail;
// GitHub identity conflicts also include the login in their message.
export function identityErrorLogFields(error: unknown): {
  errorType: string;
  errorCode?: string;
} {
  return {
    errorType: error instanceof Error ? error.name : typeof error,
    ...(error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
      ? { errorCode: error.code }
      : {}),
  };
}
