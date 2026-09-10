/**
 * The delivery tail's terminal report.
 *
 * flip-ready owns the one irreversible public action and certifies the ready pull
 * request's URL as its declared result. This composes what the run's reader — usually
 * an orchestrating agent — actually receives, which is that URL plus whatever the
 * review recorded in the run's discovery sidecar.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_PR_URL: `$flip-ready.output.pr_url`, certified non-empty at the producer.
 */

import { artifactsDir, emit, refuse, trimmedInput } from '../../.shared/io.ts';
import { caveats } from '../../.shared/report.ts';

const artifacts = artifactsDir();
const url = trimmedInput('PR_URL');

if (url === '') {
  refuse(
    `outcome: flip-ready reported no pull request URL.${caveats(artifacts, { failed: true })}`
  );
} else {
  emit({ pr_url: url, summary: `${url}${caveats(artifacts, { failed: false })}` });
}
