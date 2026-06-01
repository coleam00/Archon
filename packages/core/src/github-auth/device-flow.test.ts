import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  startDeviceFlow,
  pollDeviceFlow,
  pollDeviceFlowOnce,
  refreshUserToken,
  fetchGithubUser,
  DeviceFlowError,
} from './device-flow';

// Minimal fetch stub: queue JSON bodies; each fetch() shifts the next one.
const realFetch = globalThis.fetch;
let queue: Array<{ ok?: boolean; status?: number; body: unknown }> = [];
let calls: Array<{ url: string; body: string }> = [];

function enqueue(body: unknown, init: { ok?: boolean; status?: number } = {}): void {
  queue.push({ ok: init.ok ?? true, status: init.status ?? 200, body });
}

const noSleep = async (): Promise<void> => {};

beforeEach(() => {
  queue = [];
  calls = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') });
    const next = queue.shift();
    if (!next) throw new Error('fetch called more times than queued');
    return {
      ok: next.ok,
      status: next.status,
      json: async () => next.body,
    } as Response;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('device-flow', () => {
  describe('startDeviceFlow', () => {
    test('returns the parsed device code response', async () => {
      enqueue({
        device_code: 'dc',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      });
      const res = await startDeviceFlow('Iv1.client');
      expect(res.user_code).toBe('ABCD-1234');
      expect(calls[0]?.body).toContain('client_id=Iv1.client');
    });

    test('throws DeviceFlowError when the body carries an error', async () => {
      enqueue({ error: 'device_flow_disabled' });
      await expect(startDeviceFlow('Iv1.client')).rejects.toBeInstanceOf(DeviceFlowError);
    });
  });

  describe('pollDeviceFlow', () => {
    test('keeps polling on authorization_pending, then returns the token', async () => {
      enqueue({ error: 'authorization_pending' });
      enqueue({ access_token: 'ghu_x', token_type: 'bearer', scope: '', expires_in: 28800 });
      const token = await pollDeviceFlow('Iv1.client', 'dc', 5, { sleep: noSleep });
      expect(token.access_token).toBe('ghu_x');
      expect(calls.length).toBe(2);
      expect(calls[0]?.body).toContain(
        'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code'
      );
    });

    test('honors slow_down by continuing to poll', async () => {
      enqueue({ error: 'slow_down', interval: 10 });
      enqueue({ access_token: 'ghu_y', token_type: 'bearer', scope: '' });
      const token = await pollDeviceFlow('Iv1.client', 'dc', 5, { sleep: noSleep });
      expect(token.access_token).toBe('ghu_y');
    });

    test('throws DeviceFlowError on access_denied', async () => {
      enqueue({ error: 'access_denied' });
      await expect(pollDeviceFlow('Iv1.client', 'dc', 5, { sleep: noSleep })).rejects.toMatchObject(
        {
          code: 'access_denied',
        }
      );
    });

    test('throws when aborted before polling', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      await expect(
        pollDeviceFlow('Iv1.client', 'dc', 5, { sleep: noSleep, signal: ctrl.signal })
      ).rejects.toMatchObject({ code: 'aborted' });
    });
  });

  // pollDeviceFlowOnce is the non-blocking variant the web poll endpoint calls
  // directly (the browser owns the retry cadence). pollDeviceFlow exercises it
  // via its loop, but the discriminated PollOnceResult branches are surfaced
  // verbatim only here.
  describe('pollDeviceFlowOnce', () => {
    test('returns pending on authorization_pending', async () => {
      enqueue({ error: 'authorization_pending' });
      const r = await pollDeviceFlowOnce('Iv1.client', 'dc');
      expect(r.status).toBe('pending');
    });

    test('returns slow_down with the server-supplied interval', async () => {
      enqueue({ error: 'slow_down', interval: 15 });
      const r = await pollDeviceFlowOnce('Iv1.client', 'dc');
      expect(r).toMatchObject({ status: 'slow_down', interval: 15 });
    });

    test('defaults slow_down interval to 5 when absent', async () => {
      enqueue({ error: 'slow_down' });
      const r = await pollDeviceFlowOnce('Iv1.client', 'dc');
      expect(r).toMatchObject({ status: 'slow_down', interval: 5 });
    });

    test('returns authorized with the token on success', async () => {
      enqueue({ access_token: 'ghu_x', token_type: 'bearer', scope: '', expires_in: 28800 });
      const r = await pollDeviceFlowOnce('Iv1.client', 'dc');
      expect(r).toMatchObject({ status: 'authorized', token: { access_token: 'ghu_x' } });
    });

    test('returns error with the raw code for terminal states', async () => {
      enqueue({ error: 'expired_token' });
      const r = await pollDeviceFlowOnce('Iv1.client', 'dc');
      expect(r).toMatchObject({ status: 'error', code: 'expired_token' });
    });
  });

  describe('refreshUserToken', () => {
    test('returns a fresh token pair', async () => {
      enqueue({
        access_token: 'ghu_new',
        token_type: 'bearer',
        scope: '',
        expires_in: 28800,
        refresh_token: 'ghr_new',
        refresh_token_expires_in: 15897600,
      });
      const t = await refreshUserToken('Iv1.client', 'ghr_old');
      expect(t.access_token).toBe('ghu_new');
      expect(t.refresh_token).toBe('ghr_new');
      expect(calls[0]?.body).toContain('grant_type=refresh_token');
    });

    test('throws DeviceFlowError on error body', async () => {
      enqueue({ error: 'bad_refresh_token' });
      await expect(refreshUserToken('Iv1.client', 'ghr_old')).rejects.toBeInstanceOf(
        DeviceFlowError
      );
    });
  });

  describe('fetchGithubUser', () => {
    test('parses id/login/name/email', async () => {
      enqueue({ id: 42, login: 'alice', name: 'Alice Liddell', email: 'alice@example.com' });
      const u = await fetchGithubUser('ghu_x');
      expect(u).toEqual({
        id: 42,
        login: 'alice',
        name: 'Alice Liddell',
        email: 'alice@example.com',
      });
    });

    test('throws on non-ok response', async () => {
      enqueue({}, { ok: false, status: 401 });
      await expect(fetchGithubUser('ghu_x')).rejects.toBeInstanceOf(DeviceFlowError);
    });
  });
});
