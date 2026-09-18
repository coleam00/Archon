/**
 * Chat file-attachment limits + client-side validation.
 *
 * These are UX hints only — the server is the authoritative validator of
 * uploads. The accepted-extension list is an *approximate subset* of the old
 * production MessageInput's set (copied, not imported — the console may not
 * import `@/components/**`), so it can drift; a file the picker hides may still
 * be accepted by the server. Kept conservative on purpose.
 */

export const MAX_FILES = 5;
export const MAX_FILE_MB = 10;
export const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;

const ACCEPTED_EXTENSIONS_LIST = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.pdf',
  '.md',
  '.txt',
  '.csv',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.log',
  '.html',
  '.css',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.sh',
  '.sql',
];

/** Comma-separated string for the file input's `accept` attribute. */
export const ACCEPTED_EXTENSIONS = ACCEPTED_EXTENSIONS_LIST.join(',');

const ACCEPTED_SET = new Set(ACCEPTED_EXTENSIONS_LIST);

/**
 * True if the file looks acceptable. Prefers the reported MIME type; falls back
 * to the extension because many code/config files report an empty MIME type. A
 * file with no extension and a non-text/non-image MIME is rejected.
 */
export function isAcceptedFileType(file: File): boolean {
  // Strip any `;charset=…` parameter — some sources (and Bun's File) append one.
  const mime = (file.type.split(';')[0] ?? '').trim();
  if (mime.startsWith('text/') || mime.startsWith('image/')) return true;
  if (mime === 'application/pdf' || mime === 'application/json') return true;
  const dot = file.name.lastIndexOf('.');
  if (dot <= 0) return false; // no extension, or a dotfile like `.gitignore` (no real ext)
  return ACCEPTED_SET.has(file.name.slice(dot).toLowerCase());
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${String(Math.round(bytes / (1024 * 1024)))} MB`;
}

/**
 * True when a drag carries files.
 *
 * `DataTransfer.types` reports `'Files'` for a file drag, while dragging a text
 * selection out of the composer's own textarea reports `'text/plain'` only.
 * Distinguishing them keeps a text drag from lighting up the drop zone and from
 * being swallowed by the drop handler's `preventDefault`.
 *
 * Reads through `Array.from` because Safari hands back a `DOMStringList` rather
 * than a real array.
 */
export function dragHasFiles(types: DataTransfer['types']): boolean {
  return Array.from(types).includes('Files');
}

/**
 * The image files on a clipboard payload.
 *
 * A copied screenshot rides the clipboard as an `image/*` item rather than as a
 * path, so reading the items is the only way to see it. Everything else is left
 * alone — an ordinary text copy carries `text/plain` and `text/html` items and
 * must keep pasting as text.
 *
 * Reads through `Array.from` because `DataTransferItemList` is array-like
 * rather than an array.
 */
export function imagesFromClipboard(items: DataTransferItemList): File[] {
  const images: File[] = [];
  for (const item of Array.from(items)) {
    if (!item.type.startsWith('image/')) continue;
    // Null when the item is not really a file despite its MIME type.
    const file = item.getAsFile();
    if (file !== null) images.push(file);
  }
  return images;
}
