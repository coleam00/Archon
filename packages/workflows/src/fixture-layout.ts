/**
 * On-disk layout of declared-data dry-run fixtures (#2772), shared by every
 * walker that enumerates workflow folders so they cannot disagree about which
 * files beside a workflow are workflows and which are fixtures.
 *
 * A `fixtures/` directory holds `<name>.stubs.yaml` files next to the workflow
 * they exercise. It is never a workflow source, at any depth.
 */
export const FIXTURES_DIR = 'fixtures';
export const FIXTURE_SUFFIX = '.stubs.yaml';
