/**
 * Metric records for the pull requests the build queue opened: opened, merged,
 * abandoned and the merge rate, each attributed to the build-queue runs that built it.
 *
 * The records need each pull request's creation, merge and close times, which no forge
 * operation reports yet (`PR_TIMESTAMPS`), so the node refuses with that missing
 * operation named. `prMetricRecords` turns the facts into records once the forge
 * reports them.
 */

import { PR_TIMESTAMPS } from '../../.shared/factory-prs.ts';
import { refuse } from '../../.shared/io.ts';

refuse(`prs: PR metrics need the forge operation ${PR_TIMESTAMPS}, which the forge plugin does not provide`);
