import { parseQualifiedPr, readChecks, preferredChecks } from '../../.shared/forge.ts';
import { emit, note, refuse } from '../../.shared/io.ts';

function flipReady(): void {
  try {
    const observation = readChecks(process.env.INPUTS_PR);
    const checks = preferredChecks(observation);
    if (checks.summary.state !== 'green' && checks.summary.state !== 'none') {
      throw new Error(`refusing at ${observation.revision} with ${checks.summary.state} checks`);
    }
  } catch (error) {
    refuse(`flip-ready: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const pr = parseQualifiedPr(process.env.INPUTS_PR);
  const repo = `${pr.repo.host}/${pr.repo.path}`;
  const number = String(pr.number);

  function gh(...args: string[]): { ok: boolean; stdout: string; stderr: string } {
    const result = Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
    return {
      ok: result.exitCode === 0,
      stdout: result.stdout.toString().trim(),
      stderr: result.stderr.toString().trim(),
    };
  }

  const ready = gh('pr', 'ready', number, '--repo', repo);
  if (ready.ok) {
    const draft = gh('pr', 'view', number, '--repo', repo, '--json', 'isDraft', '--jq', '.isDraft');
    if (!draft.ok) refuse('flip-ready: PR was flipped but its draft state could not be read back.');
    else if (draft.stdout !== 'false')
      refuse('flip-ready: PR still reports draft after the ready flip');
  } else {
    const state = gh('pr', 'view', number, '--repo', repo, '--json', 'state', '--jq', '.state');
    if (state.ok && state.stdout === 'MERGED')
      note('flip-ready: the PR was already merged, so no flip was needed.');
    else if (state.ok && state.stdout === 'CLOSED')
      refuse('flip-ready: the PR is CLOSED without a merge, so there is no delivery to report.');
    else refuse(`flip-ready: the ready flip failed: ${ready.stderr}`);
  }

  if (process.exitCode !== 1) {
    const url = gh('pr', 'view', number, '--repo', repo, '--json', 'url', '--jq', '.url');
    if (!url.ok || url.stdout === '') refuse('flip-ready: the PR URL could not be read back.');
    else emit({ pr_url: url.stdout });
  }
}
flipReady();
