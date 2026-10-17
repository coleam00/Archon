import { parsePrRecord } from '../../workflows/sdlc/.shared/forge.ts';
import { refuse, report, text } from '../../workflows/sdlc/.shared/io.ts';
import { pushHead } from '../../workflows/sdlc/.shared/push.ts';

// Drives the push publish-pr makes, so its target choice and refusals are testable alone.
try {
  report(pushHead(parsePrRecord(JSON.parse(text(process.env.INPUTS_PR)))));
} catch (error) {
  refuse(`push: ${error instanceof Error ? error.message : String(error)}`);
}
