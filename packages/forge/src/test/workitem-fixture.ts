/** Fake GitHub transport shared by owner and pack integration tests. */
export function workItemFixture(path = 'owner/repo') {
  const repo = { host: 'github.com', path };
  const makeItem = (number: number, body = '') => ({
    number,
    html_url: `https://github.com/${path}/issues/${String(number)}`,
    title: 'Work item',
    body,
    state: 'open',
    labels: [] as { name: string }[],
  });
  const items = [makeItem(42)];
  items[0].labels = [{ name: 'unrelated-label' }, { name: 'archon-blocked' }];
  const definitions: { name: string; color: string; description: string }[] = [];
  const calls: { method: string; path: string; body: unknown }[] = [];
  const state = { mode: '', written: false };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const endpoint = decodeURIComponent(url.pathname);
      const method = request.method;
      const payload: unknown = method === 'POST' ? await request.json() : undefined;
      calls.push({ method, path: url.pathname + url.search, body: payload });
      if (request.headers.get('Authorization') !== 'Bearer fixture-secret')
        return new Response('', { status: 401 });
      const base = `/repos/${path}`;
      if (!endpoint.startsWith(base + '/')) return new Response('', { status: 404 });
      const fail = () =>
        new Response('fixture-secret reflected transport failure', { status: 502 });
      const page = <T>(values: T[]) => {
        const n = Number(url.searchParams.get('page') ?? 1);
        return values.slice((n - 1) * 100, n * 100);
      };
      if (endpoint === `${base}/issues`) {
        if (method === 'POST') {
          const body = payload as { title: string; body: string };
          const item = makeItem(Math.max(0, ...items.map(value => value.number)) + 1, body.body);
          item.title = body.title;
          if (state.mode === 'missing_marker') item.body = 'lost marker';
          items.push(item);
          state.written = true;
          if (state.mode === 'write_then_fail') return fail();
          if (state.mode === 'wrong_create')
            return Response.json({ ...item, html_url: 'https://github.com/wrong/repo/issues/43' });
          return Response.json(item);
        }
        return Response.json(page(items));
      }
      const issue = items.find(item => endpoint === `${base}/issues/${String(item.number)}`);
      if (issue) {
        if (state.mode === 'read_failure' && state.written) return fail();
        return Response.json({
          ...issue,
          ...(state.mode === 'wrong_before' || (state.mode === 'wrong_after' && state.written)
            ? { html_url: 'https://github.com/wrong/repo/issues/42' }
            : {}),
          ...(state.mode === 'is_pr' ? { pull_request: {} } : {}),
          ...(state.mode === 'malformed_labels' ? { labels: [{}] } : {}),
        });
      }
      if (endpoint === `${base}/labels`) {
        if (method === 'GET') return Response.json(page(definitions));
        if (state.mode === 'partial_create' && definitions.length) return fail();
        const definition = payload as (typeof definitions)[number];
        definitions.push(definition);
        return Response.json(definition);
      }
      if (endpoint.startsWith(`${base}/labels/`)) {
        const definition = definitions.find(value => endpoint === `${base}/labels/${value.name}`);
        return definition ? Response.json(definition) : new Response('', { status: 404 });
      }
      const target = items.find(item =>
        endpoint.startsWith(`${base}/issues/${String(item.number)}/labels`)
      );
      if (!target) return new Response('', { status: 404 });
      if (!state.written && state.mode === 'concurrent_unrelated')
        target.labels.push({ name: 'area:concurrent/cli,api' });
      if (!state.written && state.mode === 'concurrent_pack')
        target.labels.push({ name: 'archon-close' });
      if (method === 'POST' && state.mode !== 'noop_write') {
        for (const name of (payload as { labels: string[] }).labels)
          if (!target.labels.some(label => label.name === name)) target.labels.push({ name });
      }
      if (method === 'DELETE') {
        if (state.mode === 'partial_remove') return fail();
        if (!['noop_write', 'retain_stale'].includes(state.mode))
          target.labels = target.labels.filter(
            label => endpoint !== `${base}/issues/${String(target.number)}/labels/${label.name}`
          );
      }
      if (state.mode === 'drop_unrelated')
        target.labels = target.labels.filter(label => label.name !== 'unrelated-label');
      state.written = true;
      if (state.mode === 'write_then_fail') return fail();
      return method === 'DELETE'
        ? new Response(null, { status: 204 })
        : Response.json(target.labels);
    },
  });
  return { repo, items, definitions, calls, state, server, makeItem };
}
