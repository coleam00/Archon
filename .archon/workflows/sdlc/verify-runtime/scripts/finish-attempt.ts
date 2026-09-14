const assessment: unknown = JSON.parse(process.env.INPUTS_ASSESSMENT ?? 'null');
if (assessment === null || typeof assessment !== 'object' || !('status' in assessment) ||
    !('reason' in assessment) || typeof assessment.status !== 'string' || typeof assessment.reason !== 'string') {
  throw new Error('runtime assessment is malformed');
}
let { status, reason } = assessment;
if (process.env.INPUTS_TEARDOWN_OK !== 'true') {
  reason = `teardown failed; external owner must clean up. Prior assessment: ${status}: ${reason}`;
  status = 'inconclusive';
} else if (status === 'malformed' && Number(process.env.INPUTS_ATTEMPT) >= Number(process.env.INPUTS_ATTEMPT_LIMIT)) {
  status = 'inconclusive';
  reason = `malformed report after exhausting the retry budget: ${reason}`;
}
console.log(JSON.stringify({ ...assessment, status, reason, done: status !== 'malformed', checkout: process.env.INPUTS_CHECKOUT }));
