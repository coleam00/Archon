/**
 * A pack setting's plain name: its key in sentence case, underscores and hyphens read as
 * spaces ("triage_policy" reads "Triage policy"). The key itself stays beside it in mono.
 */
export function settingLabel(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
