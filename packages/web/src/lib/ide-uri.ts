/**
 * Build a `vscode://...` URI for opening a server-side absolute path in the
 * user's locally-installed VS Code.
 *
 * Two flavours, picked based on where the Archon server is running:
 *
 * - **default**: `vscode://file/<path>` — works when the path is reachable
 *   from the same OS as the browser (typical local dev or remote SSH proxied
 *   to localhost).
 * - **WSL2**: `vscode://vscode-remote/wsl+<distro>/<path>` — required when
 *   Archon runs inside a WSL2 distro and the browser is on the Windows host.
 *   Without this prefix Windows VS Code receives the Linux path verbatim and
 *   tries to resolve it on the Windows filesystem, which silently fails.
 *
 * @param path  Absolute path on the server, as reported by the API. Backslashes
 *              are normalised to forward slashes.
 * @param env   Server-environment hints from `/api/health` — `is_wsl` plus
 *              `wsl_distro` when known. Omit (or pass `is_wsl: false`) for
 *              the plain `vscode://file/...` form.
 */
export function ideUri(path: string, env?: { is_wsl?: boolean; wsl_distro?: string }): string {
  const normalised = path.replace(/\\/g, '/');

  if (env?.is_wsl && env.wsl_distro) {
    // vscode-remote URIs need a leading slash before the absolute Linux path
    const withLeadingSlash = normalised.startsWith('/') ? normalised : `/${normalised}`;
    return `vscode://vscode-remote/wsl+${encodeURIComponent(env.wsl_distro)}${withLeadingSlash}`;
  }

  return `vscode://file/${normalised}`;
}
