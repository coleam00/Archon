export function isModified(current: string, baseline: string | null): boolean {
  if (baseline == null) return false;
  return current.trim() !== baseline.trim();
}
