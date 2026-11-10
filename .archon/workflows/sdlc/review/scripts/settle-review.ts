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
 * note: `disproved` when two votes say it is not real; a pre-existing defect when
 * two votes say it is real but outside the change, added to the discoveries so it
 * is relayed rather than dropped; otherwise an open note, with no claim about why.
 *
 * Readiness is decided again only from typed facts: the verdict is ready when no
 * blocking finding stays open and synthesis declared no coverage gap. Otherwise
 * the action is the most severe of the remaining open blockers' own `action`s and
 * of what the coverage gaps need, so a demoted blocker that alone needed `ask` or
 * `replan` no longer stops delivery. The gaps need synthesis's action when it is
 * more severe than any blocker it saw, which only a gap explains; otherwise
 * `correct`, the next round being the retry. The report
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
import type { NodeOutput } from '../../.shared/outputs.generated.ts';
import { FINDING_VALUES, type Finding, readFindings } from '../../.shared/review-item.ts';
import { isObject } from '../../.shared/typed.ts';

/** The verifier nodes' numbers; each writes review/verify-<n>.json. */
const VOTERS = [1, 2, 3] as const;
const DEMOTE_AT = 2;
type Action = (typeof FINDING_VALUES.action)[number];
const rank = (action: string): number => FINDING_VALUES.action.findIndex(value => value === action);

interface Vote {
  readonly id: string;
  readonly real: boolean;
  readonly belongs: boolean;
  readonly reason: string;
}

/** Synthesis's verdict, as its node's schema certified it. */
type Synthesis = NodeOutput<'archon-review', 'synthesize'>;

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
    ready: JSON.parse(text(process.env.INPUTS_READY)) as Synthesis['ready'],
    action: text(process.env.INPUTS_ACTION),
    findings_summary: text(process.env.INPUTS_SUMMARY),
    report: JSON.parse(text(process.env.INPUTS_REPORT_POINTER)) as Synthesis['report'],
    discoveries: [...(JSON.parse(text(process.env.INPUTS_DISCOVERIES)) as Synthesis['discoveries'])],
    contract_left: JSON.parse(text(process.env.INPUTS_CONTRACT_LEFT)) as Synthesis['contract_left'],
  };
  const gaps = JSON.parse(text(process.env.INPUTS_COVERAGE_GAPS)) as Synthesis['coverage_gaps'];
  // A Ready verdict ran no verifier and has nothing to settle.
  if (verdict.ready) {
    emit(verdict);
  } else {
    const dir = join(artifactsDir(), 'review');
    const findingsFile = join(dir, 'findings.json');
    const synthesized = readFindings(artifactsDir());
    const isOpenBlocker = (finding: Finding): boolean => finding.severity === 'blocking' && finding.status === 'open';
    const votes = VOTERS.map(voter => votesOf(dir, voter));
    const disproved: string[] = [];
    const preExisting: string[] = [];
    const rejected: string[] = [];
    const findings = synthesized.map((finding): Finding => {
      if (!isOpenBlocker(finding) || finding.sources.includes('contract')) return finding;
      const against = votes
        .map(list => list.find(vote => vote.id === finding.id))
        .filter((vote): vote is Vote => vote !== undefined && !(vote.real && vote.belongs));
      if (against.length < DEMOTE_AT) return finding;
      const reasons = against.map(vote => vote.reason);
      const demoted: Finding = { ...finding, severity: 'note', verify: { against: against.length, reasons } };
      if (against.filter(vote => !vote.real).length >= DEMOTE_AT) {
        disproved.push(finding.id);
        return { ...demoted, status: 'disproved' };
      }
      if (against.filter(vote => vote.real).length < DEMOTE_AT) {
        rejected.push(finding.id);
        return demoted;
      }
      preExisting.push(finding.id);
      verdict.discoveries.push({
        title: `${finding.id} predates this change`,
        claim: finding.claim,
        evidence: reasons.length > 0 ? reasons : [`verifiers judged ${finding.id} outside this change`],
        relation: 'unrelated',
        source_nodes: [...finding.sources, 'verify'],
      });
      return demoted;
    });
    if (disproved.length + preExisting.length + rejected.length > 0) {
      const before = synthesized.filter(isOpenBlocker);
      const missing = before.filter(finding => finding.action === undefined).map(finding => finding.id);
      if (missing.length > 0) {
        throw new Error(`open blockers ${missing.join(', ')} carry no action, so the verdict cannot be settled`);
      }
      const open = findings.filter(isOpenBlocker);
      verdict.ready = open.length === 0 && gaps.length === 0;
      if (verdict.ready) {
        verdict.action = 'none';
      } else {
        const blockerMax = Math.max(-1, ...before.map(finding => rank(finding.action ?? 'correct')));
        const needs: Action[] = open.map(finding => finding.action ?? 'correct');
        if (gaps.length > 0) needs.push(rank(verdict.action) > blockerMax ? (verdict.action as Action) : 'correct');
        verdict.action = FINDING_VALUES.action[Math.max(...needs.map(rank))] ?? verdict.action;
      }
      writeFileSync(findingsFile, `${JSON.stringify(findings, null, 2)}\n`);
      const parts = [
        disproved.length > 0 ? `${disproved.join(', ')} disproved` : '',
        preExisting.length > 0 ? `${preExisting.join(', ')} predate this change and are now discoveries` : '',
        rejected.length > 0 ? `${rejected.join(', ')} rejected` : '',
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
