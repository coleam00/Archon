import { relative } from 'node:path';
import { compareComposition, readComparisonRequest } from '../../.shared/composition.ts';
import { artifactsDir, emit, trimmed } from '../../.shared/io.ts';

const request = readComparisonRequest(trimmed(process.env.INPUTS_COMPARISON));
const runId = process.env.WORKFLOW_ID;
if (!runId) throw new Error('WORKFLOW_ID is required for composition artifact attribution.');
const artifacts = artifactsDir();
const result = await compareComposition(process.cwd(), artifacts, request);
emit({
  ...result.verdict,
  evidence: {
    type: 'archon_artifact',
    run_id: runId,
    path: relative(artifacts, result.path).split('\\').join('/'),
  },
});
