import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { extractJiraKey, fetchJiraTicketContext } from './jira-context';

const CREDS = {
  JIRA_BASE_URL: 'https://example.atlassian.net',
  JIRA_USER: 'bot@example.com',
  JIRA_API_TOKEN: 'token123',
};

// Minimal fetch stub mirroring device-flow.test.ts.
const realFetch = globalThis.fetch;
let queue: Array<{ ok?: boolean; status?: number; body: unknown }> = [];
let calls: Array<{ url: string; headers: Record<string, string> }> = [];

function enqueue(body: unknown, init: { ok?: boolean; status?: number } = {}): void {
  queue.push({ ok: init.ok ?? true, status: init.status ?? 200, body });
}

beforeEach(() => {
  queue = [];
  calls = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const next = queue.shift();
    if (!next) throw new Error('fetch called more times than queued');
    return { ok: next.ok, status: next.status, json: async () => next.body } as Response;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('extractJiraKey', () => {
  test('extracts a key from free text', () => {
    expect(extractJiraKey('plan DEV-2602')).toBe('DEV-2602');
    expect(extractJiraKey('please fix MYTEAM-456 today')).toBe('MYTEAM-456');
  });

  test('returns undefined when no key is present', () => {
    expect(extractJiraKey('add dark mode to the settings page')).toBeUndefined();
  });

  test('does not match lowercase or number-only tokens', () => {
    expect(extractJiraKey('see issue dev-2602')).toBeUndefined();
    expect(extractJiraKey('ticket 12345')).toBeUndefined();
  });
});

describe('fetchJiraTicketContext', () => {
  test('returns undefined and does not fetch when no key is present', async () => {
    const result = await fetchJiraTicketContext('just a question', CREDS);
    expect(result).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  test('returns undefined and does not fetch when credentials are missing', async () => {
    const result = await fetchJiraTicketContext('fix DEV-1', {
      JIRA_BASE_URL: CREDS.JIRA_BASE_URL,
    });
    expect(result).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  test('fetches and formats a ticket with ADF description, components, labels', async () => {
    enqueue({
      key: 'DEV-2602',
      fields: {
        summary: 'Payment processor throws on null amount',
        issuetype: { name: 'Bug' },
        status: { name: 'To Do' },
        components: [{ name: 'payments' }, { name: 'api' }],
        labels: ['regression', 'p1'],
        description: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Crash when amount is null.' }],
            },
          ],
        },
      },
    });

    const result = await fetchJiraTicketContext('plan DEV-2602', CREDS);

    expect(result).toContain('Key: DEV-2602');
    expect(result).toContain('Summary: Payment processor throws on null amount');
    expect(result).toContain('Type: Bug');
    expect(result).toContain('Components: payments, api');
    expect(result).toContain('Labels: regression, p1');
    expect(result).toContain('Crash when amount is null.');

    // Hits the correct REST endpoint with basic auth.
    expect(calls[0].url).toBe(
      'https://example.atlassian.net/rest/api/3/issue/DEV-2602?fields=summary,description,issuetype,status,components,labels'
    );
    expect(calls[0].headers.Authorization).toBe(
      `Basic ${Buffer.from('bot@example.com:token123').toString('base64')}`
    );
  });

  test('trims a trailing slash on the base URL', async () => {
    enqueue({ key: 'DEV-1', fields: { summary: 's', issuetype: { name: 'Bug' } } });
    await fetchJiraTicketContext('DEV-1', { ...CREDS, JIRA_BASE_URL: 'https://x.atlassian.net/' });
    expect(calls[0].url).toBe(
      'https://x.atlassian.net/rest/api/3/issue/DEV-1?fields=summary,description,issuetype,status,components,labels'
    );
  });

  test('returns undefined on a non-200 response', async () => {
    enqueue({ errorMessages: ['Issue does not exist'] }, { ok: false, status: 404 });
    const result = await fetchJiraTicketContext('fix DEV-999', CREDS);
    expect(result).toBeUndefined();
  });

  test('returns undefined when the fetch throws', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    const result = await fetchJiraTicketContext('fix DEV-1', CREDS);
    expect(result).toBeUndefined();
  });

  test('omits empty optional fields', async () => {
    enqueue({ key: 'DEV-3', fields: { summary: 'just a summary', issuetype: { name: 'Bug' } } });
    const result = await fetchJiraTicketContext('DEV-3', CREDS);
    expect(result).toContain('Summary: just a summary');
    expect(result).not.toContain('Components:');
    expect(result).not.toContain('Labels:');
    expect(result).not.toContain('Description:');
  });
});
