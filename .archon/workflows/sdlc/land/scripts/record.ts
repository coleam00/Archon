// Record on the item that its change merged, as the forge reports it, so the item's
// merge is a fact the engine keeps (`archon workflow merged`) and not the land agent's
// word. It runs only after the agent said the pull request merged. A record that cannot
// be written is said in the output and on stderr; it does not undo a merge that happened.
import { emit, forge, input, recordMerge } from 'archon:script';

const change = input('change').trim();
let recorded: string;
try {
  const where = forge('resolve', { remote: change, web: true });
  if (where.kind !== 'resolved' || where.subject?.kind !== 'pr') {
    recorded = `not recorded: ${change} is not a pull request this install can read`;
  } else {
    const ref = { repo: where.repo, number: where.subject.number };
    const seen = forge('pr.view', { selector: { kind: 'number', ref } });
    const at = seen?.timestamps?.merged_at;
    if (seen?.pr.state !== 'merged' || !at) {
      recorded = `not recorded: the forge says the pull request is ${seen?.pr.state ?? 'unknown'}`;
    } else {
      const commit = forge('pr.merge-state', { ref }).merge_commit ?? null;
      recordMerge({ change: seen.pr.url, at, commit });
      recorded = `merged into ${seen.pr.base}${commit ? ` as ${commit}` : ''}`;
    }
  }
} catch (error) {
  recorded = `not recorded: ${error instanceof Error ? error.message : String(error)}`;
}
console.error(`record: ${recorded}`);
emit({ recorded });
