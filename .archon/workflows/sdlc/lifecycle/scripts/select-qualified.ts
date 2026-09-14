function object(name: string): Record<string, unknown> | null {
  const value: unknown = JSON.parse(process.env[`INPUTS_${name}`] ?? 'null');
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid ${name}`);
  return Object.fromEntries(Object.entries(value));
}

const initial = object('INITIAL');
if (initial === null || typeof initial.repair !== 'boolean') throw new Error('missing initial qualification');
const result = initial.repair ? object('RETRIED') : initial;
const candidate = object(initial.repair ? 'REPAIRED' : 'CANDIDATE');
const ready = result?.ready === true && candidate?.delivered === true;
console.log(JSON.stringify({ ready, prs: ready ? candidate.prs : [],
  evidence: result?.evidence ?? initial.evidence, references: ready ? result.references : [] }));
