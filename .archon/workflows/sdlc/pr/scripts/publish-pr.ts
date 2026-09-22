import { readFileSync } from 'node:fs';
import { invokeForge, parsePrRecord, record } from '../../.shared/forge.ts';
import { emit, refuse, text } from '../../.shared/io.ts';

try {
  const intent = record(JSON.parse(readFileSync(text(process.env.INPUTS_INTENT), 'utf8')));
  if (!intent) throw new Error('PR intent must be a JSON object');
  const existing = intent.existing;
  const value = existing
    ? invokeForge('pr.view', { selector: existing })
    : invokeForge('pr.create', {
        repo: intent.repo, headRepo: intent.headRepo, head: intent.head,
        headRevision: intent.headRevision, base: intent.base, title: intent.title,
        body: readFileSync(String(intent.bodyPath), 'utf8'), draft: intent.draft,
      });
  // A selected existing PR that disappeared is a refusal, never permission to create a duplicate.
  const pr = parsePrRecord(record(value)?.pr);
  emit(pr);
} catch (error) {
  refuse(`publish-pr: ${error instanceof Error ? error.message : String(error)}`);
}
