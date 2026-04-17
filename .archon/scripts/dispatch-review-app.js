#!/usr/bin/env bun
/**
 * Dispatch a GitHub Actions workflow_dispatch event on the given ref.
 *
 * Usage: bun .archon/scripts/dispatch-review-app.js <workflow-file> <ref>
 *
 * Exits 0 on successful dispatch. Exits non-zero with a human-readable stderr
 * message on any failure (missing args, gh not installed, gh call failed).
 *
 * Used by the archon-slack-feature-to-review-app workflow after CI passes
 * to deploy a review app for the PR branch.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function main() {
  const [workflowFile, ref] = process.argv.slice(2);

  if (!workflowFile || !ref) {
    console.error('Usage: dispatch-review-app.js <workflow-file> <ref>');
    process.exit(2);
  }

  try {
    const { stdout, stderr } = await execFileAsync('gh', [
      'workflow',
      'run',
      workflowFile,
      '--ref',
      ref,
    ]);
    if (stdout.trim()) console.log(stdout.trim());
    if (stderr.trim()) console.log(stderr.trim());
    console.log(
      JSON.stringify({ dispatched: true, workflow: workflowFile, ref })
    );
  } catch (err) {
    console.error(
      `Failed to dispatch ${workflowFile} on ref ${ref}: ${err.stderr ?? err.message}`
    );
    process.exit(1);
  }
}

void main();
