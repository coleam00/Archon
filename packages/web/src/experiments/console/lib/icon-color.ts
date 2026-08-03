/**
 * Deterministic color for a project tile based on its id.
 * Same id always yields the same color so tiles are stable across sessions.
 *
 * Uses a small palette of oklch hues tuned for the app's dark surface. Kept in
 * sync with the general visual language (no neon, no clashing with success/
 * warning/error status colors).
 */

// Warm palette. Hues concentrated in 0–90 (roses, corals, peaches, ambers)
// with two jewel-tone outliers (plum + teal, echoing the logo's magenta→teal
// gradient endpoints) so 8+ projects still feel visually distinct.
const PALETTE: readonly string[] = [
  'oklch(0.58 0.16 15)', // rose
  'oklch(0.60 0.14 40)', // coral
  'oklch(0.62 0.14 65)', // peach
  'oklch(0.62 0.13 85)', // warm amber-gold
  'oklch(0.56 0.15 350)', // warm magenta (logo-leaning)
  'oklch(0.52 0.14 325)', // plum
  'oklch(0.58 0.13 160)', // warm teal (logo-leaning)
  'oklch(0.55 0.13 100)', // olive-gold
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
  // owner/repo → ownerInitial + repoInitial
  if (cleaned.includes('/')) {
    const [a, b] = cleaned.split('/', 2);
    const left = (a ?? '').trim()[0] ?? '';
    const right = (b ?? '').trim()[0] ?? '';
    if (left && right) return `${left}${right}`.toUpperCase();
  }
  // First two alphanumeric characters
  const alnum = cleaned.replace(/[^A-Za-z0-9]/g, '');
  return (alnum.slice(0, 2) || cleaned.slice(0, 2)).toUpperCase();
}
