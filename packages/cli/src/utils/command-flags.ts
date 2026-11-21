type Values = Record<string, unknown>;

/** Refuses any flag beyond the shared `--cwd`, `--help` and `--json` and the command's own. */
export function validateFlags(values: Values, allowed: string[]): void {
  const allowedKeys = new Set(['cwd', 'help', 'json', ...allowed]);
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && !allowedKeys.has(key))
      throw new Error(`--${key} is not supported by this command`);
  }
}

/** Reads a schedule's `--interval`, falling back to the command's default. */
export function parseIntervalSeconds(values: Values, fallback: number): number {
  const interval = values.interval === undefined ? fallback : Number(values.interval);
  if (!Number.isSafeInteger(interval) || interval <= 0)
    throw new Error('--interval must be a positive integer in seconds');
  return interval;
}
