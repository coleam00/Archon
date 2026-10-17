export function resolveCliUserId(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.ARCHON_USER_ID?.trim();
  if (explicit) return explicit;
  const sys = env.USER?.trim() || env.USERNAME?.trim();
  return sys || null;
}
