export function sqlState(error: unknown): string | undefined {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && code.length === 5 && !/[^0-9A-Z]/.test(code)
    ? code
    : undefined;
}
