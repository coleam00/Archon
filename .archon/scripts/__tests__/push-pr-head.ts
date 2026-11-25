import { input, refuse } from 'archon:script';
import type { PrRecord } from '../../workflows/sdlc/.shared/identity.ts';
import { pushHead } from '../../workflows/sdlc/.shared/push.ts';

// Drives the push publish-pr makes, so its target choice and refusals are testable alone.
try {
  console.log(pushHead(JSON.parse(input('pr')) as PrRecord));
} catch (error) {
  refuse(`push: ${error instanceof Error ? error.message : String(error)}`);
}
