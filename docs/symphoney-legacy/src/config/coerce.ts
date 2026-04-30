import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export function expandEnvAndHome(input: string, env: NodeJS.ProcessEnv = process.env): string {
  if (typeof input !== "string") return input;

  let s = input;

  // ~ expansion only at the start of the string or as a path segment
  if (s === "~") {
    s = homedir();
  } else if (s.startsWith("~/")) {
    s = `${homedir()}${s.slice(1)}`;
  }

  // $VAR or ${VAR}
  s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => env[name] ?? "");
  s = s.replace(/(^|[^\\])\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, prefix, name) => {
    return `${prefix}${env[name] ?? ""}`;
  });

  return s;
}

/**
 * Resolve `$VAR_NAME` indirection only. If the value is exactly `$VAR` or `${VAR}`,
 * return the env value (or empty string when missing). Otherwise return the value as-is.
 *
 * Used for tracker.api_key per §5.2 / §5.3.7 — env vars must NOT globally override YAML.
 */
export function resolveEnvIndirection(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return "";
  const m = trimmed.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
  if (m) {
    return env[m[1] as string] ?? "";
  }
  return trimmed;
}

export function resolvePath(
  value: string,
  baseDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const expanded = expandEnvAndHome(value, env);
  if (isAbsolute(expanded)) return resolve(expanded);
  return resolve(baseDir, expanded);
}
