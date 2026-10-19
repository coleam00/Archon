import { parsePrRecord } from '../../workflows/sdlc/.shared/forge.ts';
import { refuse, report, text } from '../../workflows/sdlc/.shared/io.ts';
import { pushHead } from '../../workflows/sdlc/.shared/push.ts';

// Drives the push publish-pr makes, so its target choice and refusals are testable alone.
try {
  const pr = parsePrRecord(JSON.parse(text(process.env.INPUTS_PR)));
  if (pr.head_repo === null) throw new Error('head repository is gone');
  report(pushHead({ repo: pr.repo, head_repo: pr.head_repo, head: pr.head }));
} catch (error) {
  refuse(`push: ${error instanceof Error ? error.message : String(error)}`);
}
