const VSCODE_NEW_WINDOW_QUERY = 'windowId=_blank';

/** Build a VS Code protocol URI that opens a path without replacing the active window. */
export function buildIdeUri(workingPath: string): string {
  const normalizedPath = workingPath.replace(/\\/g, '/');
  return `vscode://file/${normalizedPath}?${VSCODE_NEW_WINDOW_QUERY}`;
}

export function openInIde(workingPath: string): void {
  window.open(buildIdeUri(workingPath), '_blank');
}
