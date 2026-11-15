/**
 * Reads one install's attention queue through the API list route and prints its items as
 * JSON. Runs as its own process so ARCHON_HOME selects a scratch home and database before
 * anything opens them.
 *
 * Usage: bun attention-list-route.fixture.ts
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import { createSqlWorkflowOperations } from '@archon/core/workflows/sql-host';
import { registerRunAttentionRoutes } from '../routes/api.run-attention';

const app = new OpenAPIHono();
registerRunAttentionRoutes(app, createSqlWorkflowOperations());
const body = (await (await app.request('/api/runs/attention')).json()) as { items: unknown[] };
console.log(JSON.stringify(body.items));
