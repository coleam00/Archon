import { afterEach, expect, test } from 'bun:test';
import { getMetricViews, getMetrics } from './metrics';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function captureUrls(): string[] {
  const urls: string[] = [];
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL) => {
      urls.push(String(input));
      return Promise.resolve(Response.json({ window: {}, metrics: [], refused: [] }));
    },
    { preconnect: originalFetch.preconnect }
  );
  return urls;
}

test('getMetrics sends the window, and the project only when scoped', async () => {
  const urls = captureUrls();
  await getMetrics({ since: '7d' });
  await getMetrics({ since: '30d', codebaseId: 'cb-1' });
  expect(urls).toEqual(['/api/metrics?since=7d', '/api/metrics?since=30d&codebaseId=cb-1']);
});

test('getMetricViews sends the project only when scoped', async () => {
  const urls = captureUrls();
  await getMetricViews({});
  await getMetricViews({ codebaseId: 'cb-1' });
  expect(urls).toEqual(['/api/metric-views', '/api/metric-views?codebaseId=cb-1']);
});
