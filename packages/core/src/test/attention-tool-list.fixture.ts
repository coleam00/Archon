/**
 * Lists one install's attention queue through the chat attention tool and prints the
 * items it reports as JSON. Runs as its own process so ARCHON_HOME selects a scratch home
 * and database before anything opens them.
 *
 * Usage: bun attention-tool-list.fixture.ts
 */
import * as codebaseDb from '../db/codebases';
import { attentionQueueSource, resolveAttentionProject } from '../operations/attention-queue';
import { buildAttentionTool } from '../orchestrator/attention-tool';
import { createSqlWorkflowOperations, createWorkflowHostStore } from '../workflows/sql-host';
import { createWorkflowStore } from '../workflows/store-adapter';

// The tool lists what its actor may answer; an operator may answer every run.
const tool = buildAttentionTool({
  actor: { kind: 'operator' },
  operations: createSqlWorkflowOperations(),
  queue: attentionQueueSource(createWorkflowStore(), createWorkflowHostStore().isolation),
  resolveProject: spec => resolveAttentionProject(codebaseDb, spec),
  codebaseId: null,
});
const listed = await tool.handler({ action: 'list' });
// The items are the JSON block between the count line and the answer guide.
const start = listed.indexOf('\n[');
const items: unknown =
  start === -1 ? [] : JSON.parse(listed.slice(start, listed.indexOf('\nAnswer an item')));
console.log(JSON.stringify(items));
