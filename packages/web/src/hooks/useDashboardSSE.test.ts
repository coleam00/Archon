import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { getSSEStreamUrl } from '@/lib/api';

const hookSource = fs.readFileSync(path.join(import.meta.dir, 'useDashboardSSE.ts'), 'utf8');

describe('useDashboardSSE source contract', () => {
  test('uses shared SSE URL helper for dashboard stream', () => {
    expect(hookSource).toContain("new EventSource(getSSEStreamUrl('__dashboard__'))");
    expect(hookSource).not.toContain("new EventSource('/api/stream/__dashboard__')");
    expect(getSSEStreamUrl('__dashboard__')).toContain('/api/stream/__dashboard__');
  });
});
