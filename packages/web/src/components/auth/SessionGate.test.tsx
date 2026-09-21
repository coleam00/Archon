import { afterEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { authStatusQuery } from '@/lib/auth-status';
import type { components } from '@/lib/api.generated';

let session: { user: { id: string } } | null = null;
mock.module('@/lib/auth-client', () => ({
  useSession: (): { data: typeof session; isPending: boolean } => ({
    data: session,
    isPending: false,
  }),
}));
const sessionGateComponent = (await import('./SessionGate')).SessionGate;
const clients: QueryClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  session = null;
});

function renderGate(status: components['schemas']['AuthStatusResponse'] | Error): string {
  const client = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  clients.push(client);
  if (status instanceof Error) {
    client.getQueryCache().build(client, { queryKey: authStatusQuery.queryKey }).setState({
      status: 'error',
      error: status,
      fetchStatus: 'idle',
    });
  } else {
    client.setQueryData(authStatusQuery.queryKey, status);
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        {createElement(sessionGateComponent, null, <p>Protected console</p>)}
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('Console authentication boundary', () => {
  test('solo installs render the console without a session', () => {
    expect(renderGate({ enabled: false, signup: 'disabled' })).toContain('Protected console');
  });
  test('enabled auth requires a session', () => {
    expect(renderGate({ enabled: true, signup: 'disabled' })).not.toContain('Protected console');
    session = { user: { id: 'operator' } };
    expect(renderGate({ enabled: true, signup: 'disabled' })).toContain('Protected console');
  });
  test('an auth-status failure offers retry without rendering protected content', () => {
    const html = renderGate(new Error('server unavailable'));
    expect(html).not.toContain('Protected console');
    expect(html).toContain('Could not check authentication');
    expect(html).toContain('Try again');
  });
});
