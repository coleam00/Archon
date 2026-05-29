/**
 * Health command — runtime health check against the running server.
 *
 * Distinct from `archon doctor` (which verifies the local environment setup);
 * `health` is a runtime status check via `GET /api/health`. Returns a non-zero
 * exit code when the server is unreachable or reports a non-ok status.
 */
import { createApiClient } from '../api-client';

interface HealthResponse {
  status: string;
  adapter: string;
  concurrency: Record<string, unknown>;
  runningWorkflows: number;
  version?: string;
  is_docker: boolean;
  activePlatforms?: string[];
}

export async function healthCommand(json?: boolean, serverUrl?: string): Promise<number> {
  const api = createApiClient(serverUrl);
  const health = await api.get<HealthResponse>('/api/health');

  if (json) {
    console.log(JSON.stringify(health, null, 2));
  } else {
    console.log(`Status:            ${health.status}`);
    if (health.version) console.log(`Version:           ${health.version}`);
    console.log(`Adapter:           ${health.adapter}`);
    if (typeof health.concurrency.active === 'number') {
      console.log(`Active convos:     ${String(health.concurrency.active)}`);
    }
    console.log(`Running workflows: ${String(health.runningWorkflows)}`);
    if (health.activePlatforms) {
      console.log(`Active platforms:  ${health.activePlatforms.join(', ') || '(none)'}`);
    }
    console.log(`Docker:            ${String(health.is_docker)}`);
  }

  // Reachable + ok → 0; any other status → 1. (Unreachable throws upstream → exit 1.)
  return health.status === 'ok' ? 0 : 1;
}
