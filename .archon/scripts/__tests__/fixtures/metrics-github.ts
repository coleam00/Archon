let failOnce = false;
let statuses: number[] = [];

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/reset' && request.method === 'POST') {
      failOnce = (await request.json()).failOnce === true;
      statuses = [];
      return Response.json({});
    }
    if (url.pathname === '/calls') return Response.json(statuses);
    if (url.pathname !== '/api/v3/repos/example/repo/pulls/42' ||
        request.method !== 'GET' || request.headers.get('authorization') !== 'Bearer fixture-token') {
      return new Response('unexpected request', { status: 400 });
    }
    const status = failOnce && statuses.length === 0 ? 503 : 200;
    statuses.push(status);
    if (status === 503) return Response.json({}, { status });
    return Response.json({
      number: 42, node_id: 'PR_42', html_url: `${url.origin}/example/repo/pull/42`,
      title: 'A pull request', body: '', state: 'open', draft: false, merged: false,
      created_at: '2026-11-10T12:00:00Z', merged_at: null, closed_at: null,
      head: { ref: 'build/widget', sha: 'a'.repeat(40), repo: { full_name: 'example/repo' } },
      base: { ref: 'dev', sha: 'b'.repeat(40) },
    });
  },
});
console.log(server.url.origin);
