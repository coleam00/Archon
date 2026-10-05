/**
 * The delivery tail's terminal report.
 *
 * confirm-ready owns the final ready claim and certifies the ready pull request's URL
 * as its declared result. This composes what the run's reader — usually
 * an orchestrating agent — actually receives, which is that URL plus whatever the
 * review recorded in the run's discovery sidecar.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_PR_URL: `$confirm-ready.output.pr_url`, certified non-empty at the producer.
 */

import { artifactsDir, emit, trimmed } from '../../.shared/io.ts';
import { caveats } from '../../.shared/report.ts';

const artifacts = artifactsDir();
const listingFile = process.env.TYPED_ARTIFACTS_FILE;
const url = trimmed(process.env.INPUTS_PR_URL);

emit({
  pr_url: url,
  summary: `${url}${caveats(artifacts, { listingFile })}`,
});
