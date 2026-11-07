/**
 * Settle the review round's verdict from the verifiers' votes.
 *
 * Synthesis labels the findings and decides a verdict; when that verdict is not
 * ready, three verifiers each judge every open blocking finding: is it real at the
 * reviewed head, and does it belong to this change. This node applies their votes
 * and owns the verdict the round returns and publishes.
 *
 * A blocker is demoted only when at least two verifiers voted against it. A
 * verifier that failed, wrote no file, or skipped a finding casts no vote, and no
 * vote upholds: a missing verifier can never turn a blocker into a note. A finding
 * that carries `contract` is never demoted: contract coverage is synthesis's own
 * judgment of what the accepted contract requires. A demoted finding becomes a
 * note: `disproved` when two votes say it is not real, otherwise a pre-existing
 * defect, which is added to the discoveries so it is relayed rather than dropped.
 *
 * Readiness is decided again only from typed facts: the verdict is ready when no
 * blocking finding stays open and synthesis declared no coverage gap. The report
 * and its round copy get a short verification section at the top, so the published
 * report says why its verdict differs from the synthesizer's text below it.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_READY / INPUTS_ACTION / INPUTS_SUMMARY / INPUTS_REPORT_POINTER /
 *   INPUTS_DISCOVERIES / INPUTS_CONTRACT_LEFT: synthesis's certified verdict.
 * - INPUTS_COVERAGE_GAPS: each reason synthesis found readiness failing other than
 *   an open blocking finding.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactsDir, emit, note, refuse, text } from '../../.shared/io.ts';
import { isObject } from '../../.shared/typed.ts';

/** The verifier nodes' numbers; each writes review/verify-<n>.json. */
const VOTERS = [1, 2, 3] as const;
const DEMOTE_AT = 2;

interface Vote {
  readonly id: string;
  readonly real: boolean;
  readonly belongs: boolean;
  readonly reason: string;
}

interface Discovery {
  title: string;
  claim: string;
  evidence: string[];
  relation: 'unrelated' | 'scope_conflict' | 'note';
  source_nodes: string[];
}

function isVote(value: unknown): value is Vote {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.real === 'boolean' &&
    typeof value.belongs === 'boolean' &&
    typeof value.reason === 'string'
  );
}

/** One verifier's votes; a missing or unreadable file is no vote at all. */
function votesOf(dir: string, voter: number): readonly Vote[] {
  const file = join(dir, `verify-${String(voter)}.json`);
  if (!existsSync(file)) {
    note(`settle-review: verifier ${String(voter)} wrote no votes; its absence upholds every finding.`);
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(parsed)) return parsed.filter(isVote);
  } catch {
    // reported below
  }
  note(`settle-review: ${file} is not a JSON array of votes; it upholds every finding.`);
  return [];
}

/** The latest round copy synthesis wrote beside report.md, if any. */
function latestRoundCopy(dir: string): string | undefined {
  const rounds = readdirSync(dir)
    .map(name => /^report-round-(\d+)\.md$/.exec(name)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
  return rounds.length === 0 ? undefined : join(dir, `report-round-${String(Math.max(...rounds))}.md`);
}

try {
  const verdict = {
    ready: JSON.parse(text(process.env.INPUTS_READY)) as boolean,
    action: text(process.env.INPUTS_ACTION),
    findings_summary: text(process.env.INPUTS_SUMMARY),
    report: JSON.parse(text(process.env.INPUTS_REPORT_POINTER)) as unknown,
    discoveries: JSON.parse(text(process.env.INPUTS_DISCOVERIES)) as Discovery[],
    contract_left: JSON.parse(text(process.env.INPUTS_CONTRACT_LEFT)) as unknown,
  };
  const gaps = JSON.parse(text(process.env.INPUTS_COVERAGE_GAPS)) as unknown[];
  // A Ready verdict ran no verifier and has nothing to settle.
  if (verdict.ready) {
    emit(verdict);
  } else {
    const dir = join(artifactsDir(), 'review');
    const findingsFile = join(dir, 'findings.json');
    const findings: unknown = JSON.parse(readFileSync(findingsFile, 'utf8'));
    if (!Array.isArray(findings) || !findings.every(isObject)) {
      throw new Error(`${findingsFile} is not a JSON array of finding records`);
    }
    const votes = VOTERS.map(voter => votesOf(dir, voter));
    const disproved: string[] = [];
    const preExisting: string[] = [];
    for (const finding of findings) {
      if (finding.severity !== 'blocking' || finding.status !== 'open') continue;
      const sources = Array.isArray(finding.sources) ? finding.sources : [];
      if (sources.includes('contract')) continue;
      const id = String(finding.id);
      const against = votes
        .map(list => list.find(vote => vote.id === id))
        .filter((vote): vote is Vote => vote !== undefined && !(vote.real && vote.belongs));
      if (against.length < DEMOTE_AT) continue;
      const reasons = against.map(vote => vote.reason);
      finding.severity = 'note';
      finding.verify = { against: against.length, reasons };
      if (against.filter(vote => !vote.real).length >= DEMOTE_AT) {
        finding.status = 'disproved';
        disproved.push(id);
      } else {
        preExisting.push(id);
        verdict.discoveries.push({
          title: `${id} predates this change`,
          claim: String(finding.claim),
          evidence: reasons.length > 0 ? reasons : [`verifiers judged ${id} outside this change`],
          relation: 'unrelated',
          source_nodes: [...sources.map(String), 'verify'],
        });
      }
    }
    if (disproved.length + preExisting.length > 0) {
      writeFileSync(findingsFile, `${JSON.stringify(findings, null, 2)}\n`);
      const open = findings.some(finding => finding.severity === 'blocking' && finding.status === 'open');
      verdict.ready = !open && gaps.length === 0;
      if (verdict.ready) verdict.action = 'none';
      const parts = [
        disproved.length > 0 ? `${disproved.join(', ')} disproved` : '',
        preExisting.length > 0 ? `${preExisting.join(', ')} predate this change and are now discoveries` : '',
      ].filter(part => part !== '');
      const outcome = verdict.ready
        ? 'With that, the verdict is Ready (action `none`).'
        : `The verdict stays not ready (action \`${verdict.action}\`).`;
      const summary = `Verification: most verifiers rejected ${parts.join('; ')}; each is now a note, not a blocker. ${outcome}`;
      const header = `> **Verification.** Three independent verifiers judged each open blocking finding. ${summary.slice('Verification: '.length)} The findings below are the synthesizer's, before verification; \`findings.json\` holds the settled labels.\n\n`;
      for (const file of [join(dir, 'report.md'), latestRoundCopy(dir)]) {
        if (file !== undefined) writeFileSync(file, header + readFileSync(file, 'utf8'));
      }
      if (preExisting.length > 0) {
        const listed = verdict.discoveries.slice(-preExisting.length);
        const section = listed.map(record => `- **${record.title}**: ${record.claim}\n  - ${record.evidence.join('\n  - ')}`);
        const discoveriesFile = join(artifactsDir(), 'discoveries.md');
        const before = existsSync(discoveriesFile) ? readFileSync(discoveriesFile, 'utf8') : '';
        writeFileSync(discoveriesFile, `${before}\n## unrelated (demoted by verification)\n\n${section.join('\n')}\n`);
      }
      verdict.findings_summary = `${verdict.findings_summary} ${summary}`;
    }
    emit(verdict);
  }
} catch (error) {
  refuse(`settle-review: ${error instanceof Error ? error.message : String(error)}`);
}
