const result: unknown = JSON.parse(process.env.INPUTS_RESULT ?? 'null');
if (result === null || typeof result !== 'object' || !('status' in result) ||
    !['verified', 'failed', 'inconclusive'].includes(String(result.status)) ||
    !('candidate' in result) || !('checkout' in result) || !('reason' in result) || !('evidence' in result)) {
  throw new Error('unexpected terminal runtime assessment');
}
console.log(JSON.stringify({ verified: result.status === 'verified', verdict: result.status,
  candidate: result.candidate, checkout: result.checkout, summary: result.reason, evidence: result.evidence }));
