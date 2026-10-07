/**
 * archon-validate's one verdict, from whichever path produced it.
 *
 * Each producer is certified by its node's schema. The comparison path and the
 * ordinary path are exclusive. On the ordinary path a reuse decision selects the
 * recorded verdict and nothing ran; otherwise `run` is null only when its timeout
 * stopped the gate, and `classify` ran exactly when `run` reported red. A fresh
 * ordinary verdict is recorded as evidence a later pass of this run may reuse.
 *
 * `checks_performed` is true only when at least one project check ran to an exit
 * status the verdict rests on: a gate with no defined checks, and a gate that did
 * not finish, performed none.
 */
import { dirname, join } from 'node:path';
import { emit, note, text } from '../../.shared/io.ts';
import {
  recordEvidence,
  reusedVerdict,
  type Applicability,
  type ValidationVerdict,
} from '../../.shared/validation-evidence.ts';
import type { Discovery } from './run-checks.ts';

const comparison = JSON.parse(text(process.env.INPUTS_COMPARISON)) as Omit<
  ValidationVerdict,
  'checks_performed'
> | null;
const applicability = JSON.parse(text(process.env.INPUTS_APPLICABILITY)) as Applicability | null;
const discovery = JSON.parse(text(process.env.INPUTS_DISCOVERY)) as Discovery | null;
const run = JSON.parse(text(process.env.INPUTS_RUN)) as {
  status: 'green' | 'red' | 'incomplete';
  summary: string;
} | null;
const classification = JSON.parse(text(process.env.INPUTS_CLASSIFICATION)) as {
  red_cause: 'introduced' | 'inherited' | 'environment';
  summary: string;
} | null;
const scope = text(process.env.INPUTS_SCOPE);
const context = text(process.env.INPUTS_CONTEXT);
const packRoot = join(dirname(import.meta.path), '..', '..');

function fresh(): ValidationVerdict {
  if (run === null) {
    return {
      green: false,
      checks_performed: false,
      red_cause: 'incomplete',
      summary:
        "The project gate didn't finish: the check runner's time limit stopped it. " +
        'validation.md records which checks ran and which never did.',
      evidence: null,
    };
  }
  if (run.status === 'red') {
    if (classification === null) throw new Error('A red gate reached the result unclassified.');
    return {
      green: false,
      checks_performed: true,
      red_cause: classification.red_cause,
      summary: classification.summary,
      evidence: null,
    };
  }
  const green = run.status === 'green';
  return {
    green,
    // No declared check is no performed check: green then means "nothing to run".
    checks_performed: green && discovery !== null && discovery.checks.length > 0,
    red_cause: green ? '' : 'incomplete',
    summary: run.summary,
    evidence: null,
  };
}

if (comparison !== null) {
  if (applicability !== null || run !== null || classification !== null) {
    throw new Error('Validation requires exactly one executed path.');
  }
  // The comparison runner either reached a gate verdict or reports a non-verdict
  // (a composition conflict, an incomplete record) as an empty cause.
  emit({ ...comparison, checks_performed: comparison.green || comparison.red_cause !== '' });
} else if (applicability === null) {
  throw new Error('Ordinary validation reached the result without an applicability decision.');
} else if (applicability.reuse) {
  if (discovery !== null || run !== null || classification !== null) {
    throw new Error('A reused verdict reached the result alongside a fresh validation.');
  }
  emit(await reusedVerdict(process.cwd(), packRoot, scope, context));
} else {
  const verdict = fresh();
  const notRecorded = await recordEvidence(process.cwd(), applicability, verdict);
  if (notRecorded !== null) note(`Validation evidence not recorded: ${notRecorded}.`);
  emit(verdict);
}
