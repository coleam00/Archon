/**
 * Inline one pull request for the test-value judge, which runs with no tools: the
 * project's test-value criteria, every changed file's patch, and the full text of each
 * changed test file at the pull request's head, so a changed test's enclosing
 * `describe` blocks are visible.
 *
 * Reading a pull request's changed files and a file's text at a revision needs forge
 * operations the contract does not have yet, so the node refuses with them named.
 */

import { refuse } from '../../.shared/io.ts';

/** The forge operations this read needs and the contract does not have yet. */
const MISSING = 'pr.files (changed files with their patches) and repo.file (a file\'s text at a revision)';

refuse(`read: the test-value judge needs the forge operations ${MISSING}, which the forge plugin does not provide`);
