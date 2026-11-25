import type { components } from './api.generated';
import { requestJson, buildApiUrl } from '../experiments/console/lib/http';

export function apiHttpTypeChecks(): void {
  const health: Promise<components['schemas']['HealthResponse']> = requestJson(
    '/api/health',
    'get'
  );
  const conv: Promise<components['schemas']['CreateConversationResponse']> = requestJson(
    '/api/conversations',
    'post',
    { body: { codebaseId: 'p1' } }
  );
  requestJson('/api/conversations/{id}/message', 'post', {
    params: { id: 'web-1' },
    body: { message: 'go' },
  });
  requestJson('/api/conversations/{id}/message', 'post', {
    params: { id: 'web-1' },
    body: new FormData(),
  });
  requestJson('/api/dashboard/runs', 'get', { query: { limit: '5', codebaseId: 'p1' } });
  // @ts-expect-error unknown route
  requestJson('/api/nope', 'get');
  // @ts-expect-error unsupported method
  requestJson('/api/health', 'post');
  // @ts-expect-error cannot choose a response
  requestJson<{ madeUp: boolean }>('/api/health', 'get');
  // @ts-expect-error required path
  requestJson('/api/conversations/{id}/message', 'post', { body: { message: 'go' } });
  // @ts-expect-error required body
  requestJson('/api/conversations/{id}/message', 'post', { params: { id: 'web-1' } });
  // @ts-expect-error required field
  requestJson('/api/conversations/{id}/message', 'post', { params: { id: 'web-1' }, body: {} });
  requestJson('/api/conversations/{id}/message', 'post', {
    params: { id: 'web-1' },
    // @ts-expect-error wrong field
    body: { message: 1 },
  });
  // @ts-expect-error unsupported query
  requestJson('/api/dashboard/runs', 'get', { query: { imaginary: true } });
  // @ts-expect-error query cannot widen path
  requestJson('/api/health', 'get', { query: { codebaseId: 'p1' } });
  // @ts-expect-error form unsupported
  requestJson('/api/codebases', 'post', { body: new FormData() });
  // @ts-expect-error arbitrary request body unsupported
  requestJson('/api/workflows/runs/{runId}/cancel', 'post', { params: { runId: 'r1' }, body: {} });
  void health;
  void conv;

  requestJson('/api/conversations', 'post');
  buildApiUrl('/api/artifacts/{runId}/{filename}', 'get', {
    params: { runId: 'r', filename: 'nested/a.md' },
  });
  // @ts-expect-error artifact success is text, not JSON
  requestJson('/api/artifacts/{runId}/{filename}', 'get', {
    params: { runId: 'r', filename: 'a.md' },
  });
  // @ts-expect-error URL helpers also reject unsupported methods
  buildApiUrl('/api/health', 'post');
  // @ts-expect-error missing path parameter
  buildApiUrl('/api/artifacts/{runId}/{filename}', 'get', { params: { runId: 'r' } });
  // @ts-expect-error transport method cannot be overridden
  requestJson('/api/health', 'get', { method: 'post' });
}
