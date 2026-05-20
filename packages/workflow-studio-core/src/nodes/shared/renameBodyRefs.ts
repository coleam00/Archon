/**
 * Rewrite `$<oldId>.…` references inside a free-form body string. Used by the
 * body-text variants (prompt, bash, script, loop.prompt, approval.message) to
 * cascade renameNode through their body text. Match is word-bounded so
 * `$dispatch_v2` is not touched when the rename target is `$dispatch`.
 */
export function rewriteBodyRefs(body: string, oldId: string, newId: string): string {
  if (!body) return body;
  const escaped = oldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return body.replace(new RegExp(`\\$${escaped}\\b`, 'g'), `$${newId}`);
}
