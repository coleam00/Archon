import { describe, expect, test } from 'bun:test';
import { getSSEStreamUrl, SSE_BASE_URL } from '@/lib/api';

describe('getSSEStreamUrl', () => {
  test('builds dashboard SSE URL from shared SSE base URL', () => {
    expect(getSSEStreamUrl('__dashboard__')).toBe(`${SSE_BASE_URL}/api/stream/__dashboard__`);
  });

  test('builds conversation SSE URL from shared SSE base URL', () => {
    expect(getSSEStreamUrl(encodeURIComponent('conv/123'))).toBe(
      `${SSE_BASE_URL}/api/stream/conv%2F123`
    );
  });
});
