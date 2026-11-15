/**
 * Sends one start to the real run route, with the real engine behind it, and prints the
 * answer as JSON. Runs as its own process so ARCHON_HOME selects a scratch home and
 * database before anything opens them.
 *
 * Usage: bun run-route-start.fixture.ts <workflow>
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import { setPlatformPolicies } from '@archon/core/platforms/registry';
import { registerHostProviders } from '@archon/core/providers/register-host-providers';
import { defaultPlatformPolicies } from '@archon/adapters/platform-policies';
import type { WebAdapter } from '../adapters/web';
import { registerWorkflowRunLaunchRoute } from '../routes/api.workflow-run-launch';

// The two host registrations the server makes at boot before any workflow is discovered.
await registerHostProviders();
setPlatformPolicies(defaultPlatformPolicies);

const workflow = process.argv[2];
let dispatched = 0;
const app = new OpenAPIHono();
registerWorkflowRunLaunchRoute(app, {
  // Never reached by a refused start; an admitted one only records its conversation id.
  webAdapter: { setConversationDbId: () => undefined } as unknown as WebAdapter,
  dispatchToOrchestrator: async () => {
    dispatched += 1;
    return { accepted: true, status: 'started' };
  },
});
const response = await app.request(`/api/workflows/${workflow}/run`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ conversationId: 'web-start-refusal', message: '' }),
});
console.log(JSON.stringify({ status: response.status, body: await response.json(), dispatched }));
