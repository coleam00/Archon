import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PrIdentity } from '../../pr/scripts/publication';

export type DeliveryResult = {
  outcome: 'delivered'; summary: string; pr: PrIdentity; reports: string[];
} | {
  outcome: 'no_action' | 'blocked'; summary: string; pr: null; reports: string[];
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Expected nonempty text');
  return value;
}

function prIdentity(value: unknown): PrIdentity {
  const pr = object(value);
  if (!Number.isSafeInteger(pr.number) || Number(pr.number) <= 0 || typeof pr.is_draft !== 'boolean') {
    throw new Error('Invalid PR record');
  }
  const repository = text(pr.repository);
  const url = text(pr.url);
  const head_sha = text(pr.head_sha);
  const base_sha = text(pr.base_sha);
  if (url !== `https://github.com/${repository}/pull/${String(pr.number)}` ||
      !/^[a-f0-9]{40}$/.test(head_sha) || !/^[a-f0-9]{40}$/.test(base_sha)) throw new Error('Invalid PR identity');
  return { number: Number(pr.number), url, repository, head: text(pr.head), base: text(pr.base),
    head_sha, base_sha, is_draft: pr.is_draft };
}

export function deliveryResult(value: unknown): DeliveryResult {
  const result = object(value);
  const summary = text(result.summary);
  if (!Array.isArray(result.reports) || !result.reports.every(v => typeof v === 'string')) {
    throw new Error('Invalid report references');
  }
  const reports: string[] = result.reports;
  if (result.outcome === 'delivered') return { outcome: 'delivered', summary, reports, pr: prIdentity(result.pr) };
  if ((result.outcome === 'no_action' || result.outcome === 'blocked') && result.pr === null) {
    return { outcome: result.outcome, summary, reports, pr: null };
  }
  throw new Error('Invalid delivery outcome');
}

export function decide(env: NodeJS.ProcessEnv): DeliveryResult {
  const artifacts = text(env.ARTIFACTS_DIR);
  const mode = env.INPUTS_MODE;
  const reports = (mode === 'revise' ? ['implementation.md', 'pr-identity.json'] :
    ['implementation.md', 'review/report.md', 'pr-identity.json']).map(p => join(artifacts, p));
  if (mode === 'deliver' || mode === 'revise') {
    const value: unknown = JSON.parse(env.INPUTS_PR ?? 'null');
    if (value === null) return { outcome: 'blocked', summary: 'Delivery did not complete. See the earliest failed node and implementation report.', pr: null, reports };
    const pr = prIdentity(value);
    if (mode === 'deliver' && pr.is_draft) throw new Error('Delivered PR still reports draft');
    return { outcome: 'delivered', summary: mode === 'revise' ? `Updated ${pr.url}; independent acceptance remains the caller's responsibility.` : pr.url, pr, reports };
  }
  if (mode !== 'ship' && mode !== 'upkeep') throw new Error('Invalid delivery result mode');
  const route = env.INPUTS_ROUTE;
  const summary = env.INPUTS_SUMMARY ?? '';
  const advisory = join(artifacts, mode === 'ship' ? 'triage.md' : 'upkeep-assessment.md');
  if (route === 'no_action') return { outcome: 'no_action', summary: `No delivery needed: ${summary}\nReport: ${advisory}`, pr: null, reports: [advisory] };
  const value: unknown = JSON.parse(env.INPUTS_DELIVERY ?? 'null');
  if (value !== null) {
    const result = deliveryResult(value);
    return { ...result, reports: [...new Set([advisory, ...result.reports])] };
  }
  const started = ['INPUTS_GATE_DIRECT', 'INPUTS_GATE_ROOTED', 'INPUTS_GATE_PLANNED'].some(k =>
    env[k] !== undefined && env[k] !== 'null');
  if (started) return { outcome: 'blocked', summary: 'Delivery started but did not complete. See the earliest failed delivery node.', pr: null, reports: [advisory, ...reports] };
  if (route === 'investigate' || route === 'plan') {
    const report = join(artifacts, route === 'investigate' ? 'investigation.md' : 'plan.md');
    return { outcome: 'blocked', summary: route === 'investigate'
      ? `No delivery started: the investigation did not establish a safe fix boundary.\nReport: ${report}`
      : `No delivery started: planning left a material decision unresolved.\nReport: ${report}`, pr: null, reports: [advisory, report] };
  }
  return { outcome: 'blocked', summary: `No delivery started: route ${String(route)} did not clear its spend gate.`, pr: null, reports: [advisory] };
}

async function readRecords(path: string): Promise<{ records: Record<string, unknown>[]; notice: string }> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return { records: Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)) : [], notice: '' };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { records: [], notice: '' };
    return { records: [], notice: `Could not read ${path}. Open it directly.` };
  }
}

export async function report(result: DeliveryResult, artifacts: string): Promise<DeliveryResult> {
  const sections: string[] = [];
  const reports = [...result.reports];
  const redPath = join(artifacts, 'red-causes.json');
  const red = await readRecords(redPath);
  if (red.notice) { sections.push(red.notice); reports.push(redPath); }
  if (red.records.length) {
    sections.push(`Delivered on red (${red.records.length}) - a gate accepted red this change did not cause:\n` +
      red.records.map(r => `- ${String(r.stage ?? 'A stage')}: ${String(r.cause ?? 'cause unstated')} red\n  ${String(r.summary ?? '')}`).join('\n') +
      "\n\nThe project's own checks did not pass locally on this branch. The pull request's own CI is the gate that still stands - read it before merging, and if the red is inherited, the base branch is what needs the fix.");
    reports.push(redPath);
  }
  const discoveriesPath = join(artifacts, 'discoveries.json');
  const discoveries = await readRecords(discoveriesPath);
  if (discoveries.notice) { sections.push(discoveries.notice); reports.push(discoveriesPath); }
  if (discoveries.records.length) {
    const md = join(artifacts, 'discoveries.md');
    sections.push(`Discoveries (${discoveries.records.length}):\n` +
      discoveries.records.map(r => `- ${String(r.title || '(untitled discovery)')}`).join('\n') +
      `\n\nReport: ${md}\n\nIf you are an agent reading this: open discoveries.md and surface each discovery to your human. These are validated findings outside this run's scope - no issue tracker knows about them, and if you drop them here, nobody ever sees them.`);
    reports.push(discoveriesPath, md);
  }
  // An empty consolidated array is review's adjudication, not missing evidence.
  if (result.outcome === 'blocked' && !await Bun.file(discoveriesPath).exists()) {
    const directory = join(artifacts, 'discoveries');
    let names: string[];
    try { names = await readdir(directory); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        sections.push(`Could not read ${directory}. Open it directly.`);
      }
      names = [];
    }
    const lines: string[] = [];
    for (const name of names.filter(n => n.endsWith('.json')).sort()) {
      const path = join(directory, name);
      const raw = await readRecords(path);
      reports.push(path);
      if (raw.notice) lines.push(raw.notice);
      lines.push(...raw.records.map(r => `- ${String(r.title || '(untitled discovery)')} [${String(r.relation || 'relation unstated')}]\n  ${String(r.claim ?? '')}`));
    }
    if (lines.length) sections.push(`Unconsolidated discoveries - recorded by this run's nodes and never validated or consolidated:\n${lines.join('\n')}\n\nRaw records: ${directory}\n\nIf you are an agent reading this: surface each record above to your human. These are findings this run proved outside its scope - no issue tracker knows about them, and if you drop them here, nobody ever sees them.`);
  }
  const summary = [result.summary, ...sections.filter(s => !result.summary.includes(s))].join('\n\n');
  return { ...result, summary, reports: [...new Set(reports)] };
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<DeliveryResult> {
  const artifacts = text(env.ARTIFACTS_DIR);
  const result = await report(decide(env), artifacts);
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, `${text(env.INPUTS_MODE)}-result.json`), JSON.stringify(result, null, 2));
  return result;
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await main())); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Invalid delivery result'); process.exitCode = 1; }
}
