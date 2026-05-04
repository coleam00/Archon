import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { getSSEStreamUrl, SSE_BASE_URL } from '@/lib/api';

const apiSource = fs.readFileSync(path.join(import.meta.dir, 'api.ts'), 'utf8');

describe('getSSEBaseUrl source contract', () => {
  test('guards window access during module initialization', () => {
    expect(apiSource).toContain("typeof window !== 'undefined'");
    expect(apiSource).toContain("window.location.hostname");
  });
});

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
