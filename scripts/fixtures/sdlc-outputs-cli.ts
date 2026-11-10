/**
 * The host CLI for the SDLC report tests: the engine's own `workflow outputs` command,
 * over a store in which every run id names a run whose output root is
 * `SDLC_OUTPUT_ROOT`. The document a pack script reads is therefore the one the real
 * command writes, from artifacts the engine's writer left.
 */
import { parseArgs } from 'node:util';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { cliArgOptions } from '../../packages/cli/src/args';
import { workflowOutputsCommand } from '../../packages/cli/src/commands/workflow-outputs';

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  options: cliArgOptions,
  allowPositionals: true,
});
if (positionals[0] !== 'workflow' || positionals[1] !== 'outputs') {
  throw new Error(`this host CLI only answers workflow outputs, not ${positionals.join(' ')}`);
}
const host = {
  deps: {
    store: {
      getWorkflowRun: async (id: string) => ({
        id,
        output_root: process.env.SDLC_OUTPUT_ROOT,
        codebase_id: null,
      }),
    },
  },
  records: { codebases: { getCodebase: async () => null } },
} as unknown as WorkflowHost;

process.exitCode = await workflowOutputsCommand(host, positionals.slice(2), {
  json: values.json as boolean | undefined,
  type: values.type as string | undefined,
  node: values.node as string | undefined,
});
