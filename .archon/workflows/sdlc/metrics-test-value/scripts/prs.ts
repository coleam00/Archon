/**
 * The factory pull requests merged at or after `since` (an ISO time, or `<n>d` back from
 * now), with the build-queue runs that built each, for the judge to fan out over.
 *
 * Choosing them needs each pull request's merge time, which no forge operation reports
 * yet (`PR_TIMESTAMPS`), so the node refuses with that missing operation named.
 */

import { PR_TIMESTAMPS } from '../../.shared/factory-prs.ts';
import { refuse } from '../../.shared/io.ts';

refuse(`prs: test-value metrics need the forge operation ${PR_TIMESTAMPS}, which the forge plugin does not provide`);
