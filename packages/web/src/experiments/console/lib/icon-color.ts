/**
 * Deterministic color for a project tile based on its id.
 * RawBlock palette — stark, high-contrast, aligned with index.css semantics.
 */

const PALETTE: readonly string[] = [
  '#000000',
  '#333333',
  '#4a4a4a',
  '#666666',
  '#0000ff',
  '#008000',
  '#ffa500',
  '#ff0000',
];

/** FNV-1a hash, 32-bit, non-cryptographic but deterministic. */
function hash(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function tileColor(projectId: string): string {
  return PALETTE[hash(projectId) % PALETTE.length];
}

export function tileAbbreviation(name: string): string {
  const cleaned = name.trim();
  if (cleaned.length === 0) return '??';
  if (cleaned.includes('/')) {
    const [a, b] = cleaned.split('/', 2);
    const left = (a ?? '').trim()[0] ?? '';
    const right = (b ?? '').trim()[0] ?? '';
    if (left && right) return `${left}${right}`.toUpperCase();
  }
  const alnum = cleaned.replace(/[^A-Za-z0-9]/g, '');
  return (alnum.slice(0, 2) || cleaned.slice(0, 2)).toUpperCase();
}
