import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type JsonObject = Record<string, unknown>;
type MergeMethod = keyof typeof methodFlags;

interface MergeResult {
  done: boolean;
  merged: boolean;
  urls: string[];
  queued: string[];
  summary: string;
}

const methodFlags = {
  merge: '--merge',
  squash: '--squash',
  rebase: '--rebase',
} as const;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`merge-action: ${name} is required`);
  return value;
}

function input(name: string, fallback?: unknown): unknown {
  const raw = process.env[`INPUTS_${name.toUpperCase()}`];
  return raw === undefined || raw === '' ? fallback : (JSON.parse(raw) as unknown);
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

function isMethod(value: unknown): value is MergeMethod {
  return typeof value === 'string' && Object.hasOwn(methodFlags, value);
}

function plan(): { value: JsonObject; digest: string } {
  const bytes = readFileSync(join(requiredEnv('ARTIFACTS_DIR'), 'merge-plan.json'));
  return {
    value: object(JSON.parse(bytes.toString('utf8')) as unknown),
    digest: createHash('sha256').update(bytes).digest('hex'),
  };
}

function gate(): void {
  const assessment = object(input('assessment'));
  const current = plan();
  const method = assessment.method;
  const reasons: string[] = [];
  if (!isMethod(method) || current.value.method !== method) {
    reasons.push('merge method is missing, conflicting, or unsupported');
  }
  if (assessment.plan_digest !== current.digest) {
    reasons.push('merge plan digest does not match the assessed file');
  }
  if (assessment.ci_requirement === 'none') {
    if (assessment.checks_state !== 'not_applicable') {
      reasons.push('known no-required-CI must use the not_applicable checks state');
    }
  } else if (assessment.ci_requirement === 'required') {
    if (assessment.checks_state !== 'passing') reasons.push('required checks are not passing');
  } else {
    reasons.push('required CI policy is unknown');
  }
  if (assessment.validation_verified !== true) reasons.push('independent validation is not verified');
  if (assessment.review_verified !== true) reasons.push('independent review is not verified');
  console.log(
    JSON.stringify({
      ready: reasons.length === 0,
      summary: reasons.length > 0 ? reasons.join('; ') : String(assessment.summary ?? ''),
      method: isMethod(method) ? method : '',
      plan_digest: current.digest,
    })
  );
}

function authorized(gated: JsonObject, mode: string, approval: unknown): boolean {
  if (gated.ready !== true) return false;
  if (mode === 'auto') return true;
  return mode === 'approve' && object(approval).decision === 'approve';
}

function finish(result: MergeResult): void {
  const lines = ['# Merge result', '', result.summary];
  if (result.urls.length > 0) lines.push('', 'Merged:', ...result.urls.map((url) => `- ${url}`));
  if (result.queued.length > 0) lines.push('', 'Queued:', ...result.queued.map((url) => `- ${url}`));
  writeFileSync(join(requiredEnv('ARTIFACTS_DIR'), 'merge-result.md'), `${lines.join('\n')}\n`, 'utf8');
  console.log(JSON.stringify(result));
}

function stop(urls: string[], queued: string[], summary: string): void {
  finish({ done: true, merged: false, urls, queued, summary });
}

function runGh(args: string[]): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
}

function execute(): void {
  const gated = object(input('gate'));
  const previous = object(input('previous'));
  const request = object(input('request'));
  const urls = strings(previous.urls);
  const queued = strings(previous.queued);
  if (!authorized(gated, process.env.INPUTS_MODE ?? '', input('approval'))) {
    stop(urls, queued, 'merge is not authorized');
    return;
  }

  const current = plan();
  if (gated.plan_digest !== current.digest) {
    stop(urls, queued, 'approved merge plan changed');
    return;
  }
  const entries = current.value.pull_requests;
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 5) {
    stop(urls, queued, 'merge plan entries are missing or invalid');
    return;
  }
  if (urls.length >= entries.length) {
    finish({ done: true, merged: true, urls, queued, summary: 'all planned pull requests are merged' });
    return;
  }

  const entry = object(entries[urls.length]);
  const repository = current.value.repository;
  const number = entry.number;
  const head = entry.head_sha;
  const method = current.value.method;
  const requestMatches =
    request.repository === repository &&
    request.number === number &&
    request.head_sha === head &&
    request.method === method;
  if (request.authorized !== true || !requestMatches || !isMethod(method)) {
    stop(
      urls,
      queued,
      typeof request.summary === 'string' && request.summary !== ''
        ? request.summary
        : 'fresh merge checks did not authorize a write'
    );
    return;
  }
  if (typeof repository !== 'string' || !Number.isInteger(number) || typeof head !== 'string') {
    stop(urls, queued, 'planned pull request identity is malformed');
    return;
  }

  const merge = runGh([
    'pr',
    'merge',
    String(number),
    '--repo',
    repository,
    methodFlags[method],
    '--match-head-commit',
    head,
  ]);
  const readback = runGh([
    'pr',
    'view',
    String(number),
    '--repo',
    repository,
    '--json',
    'state,mergedAt,mergeCommit,url',
  ]);
  let state: JsonObject = {};
  if (readback.exitCode === 0) {
    try {
      state = object(JSON.parse(readback.stdout?.toString() ?? '') as unknown);
    } catch {
      // Unclear readback is held below even when GitHub accepted the write.
    }
  }
  const url = typeof entry.url === 'string' ? entry.url : '';
  if (
    state.state === 'MERGED' &&
    typeof state.mergedAt === 'string' &&
    state.mergedAt !== '' &&
    object(state.mergeCommit).oid !== undefined
  ) {
    const completed = [...urls, url];
    const done = completed.length === entries.length;
    finish({
      done,
      merged: done,
      urls: completed,
      queued,
      summary: done
        ? 'all planned pull requests are merged'
        : 'merge confirmed; refreshing the next planned pull request',
    });
  } else if (merge.exitCode === 0) {
    stop(urls, [...queued, url], 'GitHub accepted the request but did not confirm a merge; reported as queued');
  } else {
    const detail =
      merge.stderr?.toString().trim() || merge.stdout?.toString().trim() || 'gh pr merge failed';
    stop(urls, queued, detail);
  }
}

const action = requiredEnv('INPUTS_ACTION');
if (action === 'gate') gate();
else if (action === 'execute') execute();
else throw new Error(`merge-action: unsupported action ${action}`);
