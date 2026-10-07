/**
 * Convert the ready pull request back to draft before the run pauses for the
 * operator on CI red it could not resolve: a red pull request never stays ready.
 * See ../../.shared/pr.ts for the write and its read-back.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_PR: `$pr.output`, the run's verified pull-request record.
 */
import { forgeSource, parsePrRecord } from '../../.shared/forge.ts';
import { markPrDraft } from '../../.shared/pr.ts';
import { refuse, report, text } from '../../.shared/io.ts';

try {
  const pr = markPrDraft(parsePrRecord(JSON.parse(text(process.env.INPUTS_PR))), forgeSource());
  report(`mark-draft: ${pr.url} is a draft while CI stays red`);
} catch (error) {
  refuse(`mark-draft: ${error instanceof Error ? error.message : String(error)}`);
}
