/**
 * Symphony config parser. Wraps Bun's native YAML parser so the rest of the
 * package can stay decoupled from a specific YAML library. Symphony config
 * files are pure YAML (no Markdown front-matter), so this is just a thin
 * wrapper with explicit error typing.
 */
export type ConfigErrorCode = 'config_parse_error' | 'config_not_a_map';

export class ConfigError extends Error {
  constructor(
    public readonly code: ConfigErrorCode,
    message: string,
    public override readonly cause?: unknown
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function parseSymphonyConfig(content: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(content);
  } catch (e) {
    throw new ConfigError(
      'config_parse_error',
      `Failed to parse symphony config YAML: ${(e as Error).message}`,
      e
    );
  }
  if (parsed === null || parsed === undefined) {
    return {};
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError('config_not_a_map', 'symphony config must decode to a map/object');
  }
  return parsed as Record<string, unknown>;
}
