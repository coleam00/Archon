import { expect, it } from 'bun:test';
import { providerRegistry } from '@archon/providers';
import { BUNDLED_WORKFLOWS } from '../../../packages/workflows/src/defaults/bundled-defaults';
import { parseWorkflow } from '../../../packages/workflows/src/loader';
import { validateStructuredOutput } from '../../../packages/workflows/src/structured-output';
import { parseReviewTarget } from '../../workflows/sdlc/.shared/review-target';

it('review target schema conforms to the pack parser', () => {
  const parsed = parseWorkflow(
    BUNDLED_WORKFLOWS['archon-review'],
    'archon-review.yaml',
    providerRegistry
  );
  if (parsed.workflow === null) throw new Error(parsed.error.error);
  const node = parsed.workflow.nodes.find(node => node.id === 'head-check');
  if (node?.kind !== 'exec' || !node.output_format) throw new Error('missing target schema');
  const pr = { repo: { host: 'github.com', path: 'owner/repo' }, number: 1 };
  const sha = 'a'.repeat(40);
  const valid = { pr, base: 'dev', head: sha, merge_base: sha };
  const cases: unknown[] = [];
  for (const identity of [null, pr]) {
    for (const base of [null, 'dev']) {
      for (const merge_base of [null, sha]) {
        cases.push({ pr: identity, base, head: sha, merge_base });
      }
    }
  }
  cases.push(
    { ...valid, head: '   ' },
    { ...valid, base: '   ' },
    { ...valid, merge_base: 'invalid' },
    { ...valid, merge_base: 'a'.repeat(64) },
    { ...valid, pr: { ...pr, number: 0 } },
    { ...valid, pr: { ...pr, repo: { host: ' ', path: 'owner/repo' } } },
    { ...valid, pr: { ...pr, repo: { host: 'github.com', path: ' ' } } },
    { head: sha },
    null
  );
  for (const target of cases) {
    let accepted = true;
    try {
      parseReviewTarget(JSON.stringify(target));
    } catch {
      accepted = false;
    }
    expect({
      target,
      valid: validateStructuredOutput({ target }, node.output_format).valid,
    }).toEqual({ target, valid: accepted });
  }
});
