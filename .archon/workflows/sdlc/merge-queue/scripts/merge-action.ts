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
  prior_base_sha: string;
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

function requestedMethodMatches(method: unknown): boolean {
  const requested = process.env.INPUTS_MERGE_METHOD ?? '';
  return requested === '' || (isMethod(requested) && requested === method);
}

function validPlan(value: JsonObject): boolean {
  const entries = value.pull_requests;
  const numbers = new Set<number>();
  const heads = new Set<string>();
  return (
    typeof value.repository === 'string' &&
    value.repository !== '' &&
    typeof value.base === 'string' &&
    value.base !== '' &&
    typeof value.base_sha === 'string' &&
    value.base_sha !== '' &&
    isMethod(value.method) &&
    Array.isArray(entries) &&
    entries.length > 0 &&
    entries.length <= 5 &&
    entries.every((item) => {
      const entry = object(item);
      const valid =
        Number.isInteger(entry.number) &&
        typeof entry.url === 'string' &&
        entry.url !== '' &&
        typeof entry.head_sha === 'string' &&
        entry.head_sha !== '';
      if (!valid) return false;
      const number = entry.number as number;
      const head = entry.head_sha as string;
      if (numbers.has(number) || heads.has(head)) return false;
      numbers.add(number);
      heads.add(head);
      return true;
    })
  );
}

function evidenceReasons(value: JsonObject): string[] {
  if (!Array.isArray(value.evidence)) {
    return ['merge plan evidence bindings are missing or invalid'];
  }
  const reasons: string[] = [];
  for (const item of value.evidence) {
    const evidence = object(item);
    if (
      typeof evidence.path !== 'string' ||
      evidence.path === '' ||
      typeof evidence.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(evidence.sha256)
    ) {
      reasons.push('merge plan evidence bindings are missing or invalid');
      continue;
    }
    try {
      const actual = createHash('sha256').update(readFileSync(evidence.path)).digest('hex');
      if (actual !== evidence.sha256) reasons.push(`approved evidence changed: ${evidence.path}`);
    } catch {
      reasons.push(`approved evidence is unavailable: ${evidence.path}`);
    }
  }
  return reasons;
}

function gate(): void {
  const assessment = object(input('assessment'));
  const current = plan();
  const method = assessment.method;
  const reasons: string[] = [];
  if (assessment.eligible !== true) reasons.push('the assessed batch is not eligible');
  if (!validPlan(current.value)) reasons.push('merge plan entries are missing or invalid');
  if (!isMethod(method) || current.value.method !== method) {
    reasons.push('merge method is missing, conflicting, or unsupported');
  }
  if (!requestedMethodMatches(method)) {
    reasons.push('requested merge method does not match the assessed plan');
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
  reasons.push(...evidenceReasons(current.value));
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

function stop(
  urls: string[],
  queued: string[],
  priorBaseSha: string,
  summary: string
): void {
  finish({ done: true, merged: false, urls, queued, prior_base_sha: priorBaseSha, summary });
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
  const priorBaseSha = typeof previous.prior_base_sha === 'string' ? previous.prior_base_sha : '';
  if (!authorized(gated, process.env.INPUTS_MODE ?? '', input('approval'))) {
    stop(urls, queued, priorBaseSha, 'merge is not authorized');
    return;
  }

  const current = plan();
  if (gated.plan_digest !== current.digest) {
    stop(urls, queued, priorBaseSha, 'approved merge plan changed');
    return;
  }
  const evidenceFailures = evidenceReasons(current.value);
  if (evidenceFailures.length > 0) {
    stop(urls, queued, priorBaseSha, evidenceFailures.join('; '));
    return;
  }
  const entries = current.value.pull_requests;
  if (!validPlan(current.value) || !Array.isArray(entries)) {
    stop(urls, queued, priorBaseSha, 'merge plan entries are missing or invalid');
    return;
  }
  if (urls.length >= entries.length) {
    finish({
      done: true,
      merged: true,
      urls,
      queued,
      prior_base_sha: priorBaseSha,
      summary: 'all planned pull requests are merged',
    });
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
      priorBaseSha,
      typeof request.summary === 'string' && request.summary !== ''
        ? request.summary
        : 'fresh merge checks did not authorize a write'
    );
    return;
  }
  if (!requestedMethodMatches(method)) {
    stop(urls, queued, priorBaseSha, 'requested merge method does not match the approved plan');
    return;
  }
  if (typeof repository !== 'string' || !Number.isInteger(number) || typeof head !== 'string') {
    stop(urls, queued, priorBaseSha, 'planned pull request identity is malformed');
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
    const base = current.value.base;
    const baseReadback =
      typeof base === 'string'
        ? runGh(['api', `repos/${repository}/branches/${encodeURIComponent(base)}`, '--jq', '.commit.sha'])
        : undefined;
    const nextBaseSha =
      baseReadback?.exitCode === 0 ? (baseReadback.stdout?.toString() ?? '').trim() : '';
    if (nextBaseSha === '') {
      stop(
        completed,
        queued,
        priorBaseSha,
        'merge was confirmed but the live base readback is unclear'
      );
      return;
    }
    const done = completed.length === entries.length;
    finish({
      done,
      merged: done,
      urls: completed,
      queued,
      prior_base_sha: nextBaseSha,
      summary: done
        ? 'all planned pull requests are merged'
        : 'merge confirmed; refreshing the next planned pull request',
    });
  } else if (merge.exitCode === 0) {
    stop(urls, queued, priorBaseSha, 'GitHub accepted the request but merge or queue state is unclear');
  } else {
    const detail =
      merge.stderr?.toString().trim() || merge.stdout?.toString().trim() || 'gh pr merge failed';
    stop(urls, queued, priorBaseSha, detail);
  }
}

const action = requiredEnv('INPUTS_ACTION');
if (action === 'gate') gate();
else if (action === 'execute') execute();
else throw new Error(`merge-action: unsupported action ${action}`);
