const CLIPBOARD_VERSION = 'archon-studio-v1';

export interface ClipboardEnvelope {
  version: string;
  nodes: unknown[];
}

export function serializeClipboard(nodes: unknown[]): string {
  return JSON.stringify({ version: CLIPBOARD_VERSION, nodes });
}

export function parseClipboard(text: string): ClipboardEnvelope | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed?.version !== CLIPBOARD_VERSION) return null;
    if (!Array.isArray(parsed.nodes)) return null;
    return parsed as ClipboardEnvelope;
  } catch {
    return null;
  }
}
