import { describe, test, expect, afterEach, spyOn } from 'bun:test';
import { updateConversation, deleteConversation } from './api';

// Regression tests for URL-encoding of platform conversation IDs in the web API
// client. Forge platform IDs (GitHub/Gitea) contain `/` and `#` characters
// (e.g. "owner/repo#42"); updateConversation and deleteConversation must encode
// them so the request hits /api/conversations/:id instead of splitting the path
// and 404ing. These exercise the CLIENT (the fetch URL), complementing the
// server-side decoding tests in packages/server/src/routes/api.conversations.test.ts.
// Ref: https://github.com/coleam00/Archon/issues/476

const FORGE_ID = 'Solvation-BV/Archon#42';
const ENCODED_URL = '/api/conversations/Solvation-BV%2FArchon%2342';

function mockFetchSuccess() {
  return spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

let fetchSpy: ReturnType<typeof mockFetchSuccess> | undefined;

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
});

describe('updateConversation — forge platform IDs with slashes and hashes', () => {
  test('PATCHes the URL-encoded conversation ID with the title body', async () => {
    fetchSpy = mockFetchSuccess();

    const result = await updateConversation(FORGE_ID, { title: 'New Title' });

    expect(result).toEqual({ success: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      ENCODED_URL,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ title: 'New Title' }),
      })
    );
  });
});

describe('deleteConversation — forge platform IDs with slashes and hashes', () => {
  test('DELETEs the URL-encoded conversation ID', async () => {
    fetchSpy = mockFetchSuccess();

    const result = await deleteConversation(FORGE_ID);

    expect(result).toEqual({ success: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      ENCODED_URL,
      expect.objectContaining({ method: 'DELETE' })
    );
  });
});
