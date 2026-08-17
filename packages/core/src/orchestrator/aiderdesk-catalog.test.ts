import { describe, expect, it, beforeEach, mock } from 'bun:test';
import {
  bootstrapAiderDeskAgentCatalog,
  getBootAiderDeskCatalog,
  validateAiderDeskWorkflowModel,
  _clearBootCatalogForTests,
  type FetchFn,
} from './aiderdesk-catalog';

/** Build a JSON response with the standard content-type. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('aiderdesk-catalog', () => {
  beforeEach(() => {
    _clearBootCatalogForTests();
  });

  describe('bootstrapAiderDeskAgentCatalog', () => {
    it('fetches /api/agent-profiles and caches the name list', async () => {
      const rec: Array<{ url: string; init?: RequestInit }> = [];
      const fetchImpl: FetchFn = (async (url: string, init?: RequestInit) => {
        rec.push({ url: url as string, init });
        return jsonResponse([
          { id: 'a', name: 'Aider' },
          { id: 'b', name: 'Poe' },
          { id: 'c', name: 'Codenomicron' },
        ]);
      }) as FetchFn;

      const result = await bootstrapAiderDeskAgentCatalog(fetchImpl, 'http://localhost:24337');

      expect(result).not.toBeNull();
      expect(result!.names).toEqual(['Aider', 'Poe', 'Codenomicron']);
      expect(rec[0].url).toBe('http://localhost:24337/api/agent-profiles');
      expect(rec[0].init?.method).toBe('GET');
    });

    it('returns null and clears the cache on non-2xx', async () => {
      const fetchImpl: FetchFn = (async () =>
        new Response('not found', { status: 404 })) as FetchFn;

      const result = await bootstrapAiderDeskAgentCatalog(fetchImpl, 'http://x');
      expect(result).toBeNull();
      expect(getBootAiderDeskCatalog()).toBeNull();
    });

    it('returns null on non-array JSON payload', async () => {
      const fetchImpl: FetchFn = (async () => jsonResponse({ foo: 'bar' })) as FetchFn;

      const result = await bootstrapAiderDeskAgentCatalog(fetchImpl, 'http://x');
      expect(result).toBeNull();
    });

    it('returns null on network error (no throw)', async () => {
      const fetchImpl: FetchFn = (async () => {
        throw new Error('ECONNREFUSED');
      }) as FetchFn;

      const result = await bootstrapAiderDeskAgentCatalog(fetchImpl, 'http://x');
      expect(result).toBeNull();
    });
  });

  describe('validateAiderDeskWorkflowModel — with empty catalog', () => {
    it('fault-free: empty/missing model + null cache → returns null (no error)', () => {
      expect(validateAiderDeskWorkflowModel(undefined)).toBeNull();
      expect(validateAiderDeskWorkflowModel('')).toBeNull();
      expect(validateAiderDeskWorkflowModel('Aider')).toBeNull(); // null cache → fail-open
    });
  });

  describe('validateAiderDeskWorkflowModel — with populated cache', () => {
    beforeEach(async () => {
      const fetchImpl: FetchFn = (async () =>
        jsonResponse([
          { id: 'a', name: 'Aider' },
          { id: 'b', name: 'Poe' },
          { id: 'c', name: 'Codenomicron' },
          { id: 'd', name: 'Power Tools' },
        ])) as FetchFn;
      await bootstrapAiderDeskAgentCatalog(fetchImpl, 'http://x');
    });

    it('matching name → null (no error)', () => {
      expect(validateAiderDeskWorkflowModel('Aider')).toBeNull();
      expect(validateAiderDeskWorkflowModel('Poe')).toBeNull();
      expect(validateAiderDeskWorkflowModel('Power Tools')).toBeNull();
    });

    it('missing profile → boot error message with known names', () => {
      const err = validateAiderDeskWorkflowModel('AiderXyz');
      expect(err).not.toBeNull();
      expect(err).toContain("'AiderXyz'");
      expect(err).toContain('Aider');
      expect(err).toContain('Power Tools');
    });

    it('does NOT validate when boot fetch failed (null cache)', async () => {
      _clearBootCatalogForTests();
      const fail: FetchFn = (async () => new Response('offline', { status: 500 })) as FetchFn;
      await bootstrapAiderDeskAgentCatalog(fail, 'http://x');
      // Even an explicit miss is fail-open because the catalog cannot be trusted.
      expect(validateAiderDeskWorkflowModel('NoSuchProfile')).toBeNull();
    });

    it('case-sensitive: "aider" (lowercase) misses despite catalog having "Aider"', () => {
      const err = validateAiderDeskWorkflowModel('aider');
      expect(err).not.toBeNull();
      expect(err).toContain("'aider'");
    });
  });
});

// Touch the mock import so unused-symbol tree-shaker doesn't drop it.
void mock;
