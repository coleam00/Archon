/**
 * Test guard: adapter unit tests must never touch the live network.
 *
 * Preloaded for every `bun test` run in this package via `bunfig.toml`.
 *
 * Why this exists (#2186): adapter tests construct real production clients
 * (Octokit, or a bare `fetch` against a configured base URL) and drive
 * `handleWebhook()` end-to-end. When the client is not stubbed, the request is
 * actually issued — api.github.com, gitea.example.com, … — so the test's
 * outcome depends on an external host resolving and responding inside Bun's
 * 5000 ms per-test budget. On CI that surfaced as intermittent, identical
 * cross-OS timeouts at ~5001 ms that passed on a plain re-run, and cost
 * multiple issues (#2186, #2240) to diagnose.
 *
 * The guard converts that latent 5-second flake into an immediate, named
 * failure: "you forgot to stub the API client, and here is the URL you hit."
 *
 * Adapters swallow their own network errors by design (e.g. Gitea's
 * `fetchCommentHistory` catches and returns `[]`), so throwing from `fetch`
 * alone would be silently absorbed. Violations are therefore RECORDED and
 * re-raised from an `afterEach` hook, where nothing can catch them.
 *
 * Legitimately stubbing `globalThis.fetch` with `spyOn` still works — the spy
 * replaces this guard for the duration of the test and `mockRestore()` puts it
 * back.
 */
import { afterEach } from 'bun:test';

const violations: string[] = [];

/** First parameter of the ambient `fetch` — spelled this way because the DOM
 *  `RequestInfo` alias is not in this package's tsconfig `lib`. */
type FetchTarget = Parameters<typeof globalThis.fetch>[0];

function describeTarget(input: FetchTarget): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** `init.method` wins (that is fetch's own precedence), then a Request's own
 *  method, then the default. Getting this right matters: the whole point of the
 *  guard is that its message identifies the offending call precisely. */
function describeMethod(input: FetchTarget, init?: RequestInit): string {
  if (init?.method !== undefined) return init.method;
  if (typeof input !== 'string' && !(input instanceof URL)) return input.method;
  return 'GET';
}

globalThis.fetch = ((input: FetchTarget, init?: RequestInit): Promise<Response> => {
  const target = `${describeMethod(input, init)} ${describeTarget(input)}`;
  violations.push(target);
  return Promise.reject(
    new Error(`Blocked live network request from an adapter unit test: ${target}`)
  );
}) as typeof globalThis.fetch;

afterEach(() => {
  if (violations.length === 0) return;
  const hits = violations.splice(0, violations.length);
  throw new Error(
    `Adapter unit test attempted ${String(hits.length)} live network request(s):\n` +
      hits.map(hit => `  - ${hit}`).join('\n') +
      '\n\nStub the platform API client instead of letting the request escape ' +
      '(see createDedupAdapter in forge/github/adapter.test.ts for the pattern). ' +
      'Unit tests that reach an external host time out non-deterministically on CI — see #2186.'
  );
});
