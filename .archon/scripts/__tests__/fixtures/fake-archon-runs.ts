/**
 * The host CLI for intake, discoveries and attention-manager script tests:
 * `workflow get <id> --json` answers from the status table in `INTAKE_RUN_STATUSES`,
 * `workflow runs --json` from the rows in `RUN_LISTING`, and `workflow attention` and
 * `workflow answer` from the queue items in the JSON file `ATTENTION_QUEUE`, logging
 * each of those calls to `<ATTENTION_QUEUE>.calls.jsonl`. `ATTENTION_REFUSE=1` makes
 * the queue refuse every answer and label, as when the pause moved after it was read.
 * Every other command runs the real CLI.
 *
 * The real CLI runs as a surface write, outside any run, in `INTAKE_STATE_CWD` when
 * set: inside a run it would refuse with exit 5, because its store has no such run.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);

type QueueItem = { runId: string; occurrence: string; pausedAt: string; revision: number; labels: Record<string, string> };

/** The flag's value after `--name`, or undefined. */
function flag(name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

/** The fake attention queue: list, read one, label, answer. */
function attention(file: string): void {
  appendFileSync(`${file}.calls.jsonl`, `${JSON.stringify(argv)}\n`);
  const items = JSON.parse(readFileSync(file, 'utf8')) as QueueItem[];
  const save = (next: QueueItem[]): void => writeFileSync(file, JSON.stringify(next));
  const reply = (value: Record<string, unknown>): void => {
    process.stdout.write(JSON.stringify(value));
    process.exitCode = value.ok === true ? 0 : 1;
  };
  const target = (runId: string | undefined): QueueItem | undefined =>
    process.env.ATTENTION_REFUSE === '1'
      ? undefined
      : items.find(item => item.runId === runId && item.occurrence === flag('--occurrence'));
  if (argv[1] === 'answer') {
    const item = target(argv[2]);
    if (item === undefined) {
      reply({ ok: false, action: 'answer', error: `run ${argv[2]} is not awaiting an answer now` });
      return;
    }
    save(items.filter(entry => entry !== item));
    reply({ ok: true, action: 'answer', answer: { decision: flag('--choose'), text: flag('--text') } });
  } else if (argv[2] === 'label') {
    const item = target(argv[3]);
    if (item === undefined) {
      reply({ ok: false, action: 'attention_label', error: `run ${argv[3]} is not paused at that occurrence` });
      return;
    }
    const [key, value] = (flag('--set') ?? '').split('=');
    item.labels = { ...item.labels, [key as string]: value as string };
    item.revision += 1;
    save(items);
    reply({ ok: true, action: 'attention_label', labels: item.labels, revision: item.revision });
  } else if (argv[2] !== undefined && !argv[2].startsWith('--')) {
    reply({ ok: true, action: 'attention', item: items.find(item => item.runId === argv[2]) ?? null });
  } else {
    const sorted = [...items].sort((left, right) => left.pausedAt.localeCompare(right.pausedAt));
    reply({ ok: true, action: 'attention', scope: { kind: 'project' }, items: sorted });
  }
}

const queue = process.env.ATTENTION_QUEUE;
if (queue && argv[0] === 'workflow' && (argv[1] === 'attention' || argv[1] === 'answer')) {
  attention(queue);
} else if (argv[0] === 'workflow' && argv[1] === 'runs') {
  // The project's run listing, from `RUN_LISTING` (a JSON array of run rows).
  const runs = JSON.parse(process.env.RUN_LISTING ?? '[]') as unknown[];
  process.stdout.write(JSON.stringify({ runs, total: runs.length, scopeFallback: false }));
} else if (argv[0] === 'workflow' && argv[1] === 'get') {
  const statuses = JSON.parse(process.env.INTAKE_RUN_STATUSES ?? '{}') as Record<string, string>;
  const status = statuses[argv[2]];
  process.stdout.write(
    JSON.stringify(
      status === undefined
        ? { ok: false, runId: argv[2], error: 'not_found' }
        : { id: argv[2], status }
    )
  );
  process.exitCode = status === undefined ? 1 : 0;
} else {
  const result = spawnSync(
    process.execPath,
    ['--no-env-file', resolve(import.meta.dir, '../../../../packages/cli/src/cli.ts'), ...argv],
    {
      cwd: process.env.INTAKE_STATE_CWD || process.cwd(),
      env: { ...process.env, WORKFLOW_ID: '', ARCHON_NODE_EXECUTION: '' },
      input: readFileSync(0),
      encoding: 'utf8',
    }
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
}
