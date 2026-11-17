import { expect, mock, spyOn, test } from 'bun:test';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { runWorkflowCancel, runWorkflowWait, type WorkflowRoute } from './workflow';

function route(positionals: string[], values: Record<string, unknown>) {
  const commands = {
    workflowCancelCommand: mock(async () => 0),
    workflowCancelItemCommand: mock(async () => 0),
    workflowWaitCommand: mock(async () => 0),
  };
  const context = {
    positionals: ['workflow', positionals[0] ?? '', ...positionals.slice(1)],
    values,
    command: 'workflow',
    subcommand: positionals[0],
    cwd: '/repo',
    effectiveCwd: '/repo',
    json: undefined,
    detachedRunConfig: undefined,
    inheritedEnv: {},
    forgeTrustedEnv: {},
    host: {} as WorkflowHost,
    commands,
  } as unknown as WorkflowRoute;
  return { context, commands };
}

test.each([
  [['cancel', 'run-1'], { item: 'issue-42' }, 'Pass a run id or --item <key>, not both.'],
  [['cancel', 'run-1'], { 'all-runs': true }, '--all-runs applies with --item.'],
  [['wait'], { item: 'issue-42', 'all-runs': true }, '--all-runs applies to cancel and abandon.'],
])('%p %p refuses without acting', async (argv, values, message) => {
  const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const { context, commands } = route(argv, values);
    const run = argv[0] === 'wait' ? runWorkflowWait : runWorkflowCancel;
    expect(await run(context)).toBe(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain(message);
    for (const command of Object.values(commands)) expect(command).not.toHaveBeenCalled();
  } finally {
    errorSpy.mockRestore();
  }
});

test('--item routes cancel to the item form with --all-runs', async () => {
  const { context, commands } = route(['cancel'], { item: 'issue-42', 'all-runs': true });
  expect(await runWorkflowCancel(context)).toBe(0);
  expect(commands.workflowCancelItemCommand).toHaveBeenCalledWith(
    context.host,
    'issue-42',
    '/repo',
    { json: undefined, allRuns: true }
  );
  expect(commands.workflowCancelCommand).not.toHaveBeenCalled();
});
