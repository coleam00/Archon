/**
 * Re-run the pull request's failed checks once, after the re-run agent judged the
 * failure a flake or the infrastructure's and asked for one. The agent only decides;
 * this is the one place a delivery re-runs CI (../../.shared/checks.ts owns how).
 *
 * A re-run that cannot be requested (a refused or failed request, a check no source
 * here can re-run) is reported as not requested, with the reason, and the red goes
 * on to classification as it is: a missing re-run costs evidence, not the delivery.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_PR: `$pr.output`, the run's verified pull-request record.
 */

import { rerunFailedChecks } from '../../.shared/checks.ts';
import { parseQualifiedPr } from '../../.shared/forge.ts';
import { emit, note } from '../../.shared/io.ts';

try {
  emit(rerunFailedChecks(parseQualifiedPr(process.env.INPUTS_PR)));
} catch (error) {
  const detail = `the re-run could not be requested: ${error instanceof Error ? error.message : String(error)}`;
  note(`rerun-failed: ${detail}`);
  emit({ requested: false, detail });
}
