/**
 * Classify input for POST /api/codebases. A `url` key signals a remote clone;
 * a `path` key signals registering a local/relative path (server resolves
 * tilde/relative). Inputs without an explicit remote prefix fall through to `path`.
 */
export function getCodebaseInput(value: string): { path: string } | { url: string } {
  const trimmed = value.trim();
  const isRemoteUrl = /^(https?:\/\/|ssh:\/\/|git@|git:\/\/)/i.test(trimmed);
  return isRemoteUrl ? { url: trimmed } : { path: trimmed };
}
