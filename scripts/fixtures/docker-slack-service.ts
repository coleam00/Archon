// Runs only on the upgrade test's isolated Docker network, as slack.com.
const bot = 'xoxb-upgrade-test';
const app = 'xapp-upgrade-test';
let delivered = false;
Bun.serve({
  port: 443,
  tls: { cert: Bun.file('/test-tls/cert.pem'), key: Bun.file('/test-tls/key.pem') },
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === '/socket') {
      return server.upgrade(request)
        ? undefined
        : new Response('upgrade required', { status: 400 });
    }
    if (url.pathname === '/delivered') {
      const result = delivered;
      delivered = false;
      return Response.json({ delivered: result });
    }
    const method = url.pathname.replace('/api/', '');
    const body = new URLSearchParams(await request.text());
    const token = request.headers.get('authorization')?.replace('Bearer ', '') ?? body.get('token');
    if (token !== (method === 'apps.connections.open' ? app : bot))
      return Response.json({ ok: false, error: 'invalid_auth' });
    if (method === 'auth.test')
      return Response.json({
        ok: true,
        bot_id: 'BTEST',
        user_id: 'UTEST',
        team_id: 'TTEST',
        url: 'https://test.slack.com/',
      });
    if (method === 'apps.connections.open')
      return Response.json({ ok: true, url: 'wss://slack.com/socket' });
    if (method === 'chat.postMessage') {
      delivered = body.get('channel') === 'CTEST' && body.get('text') === 'Docker upgrade delivery';
      return Response.json({ ok: true, channel: 'CTEST', ts: '1.0' });
    }
    return Response.json({ ok: false, error: `unexpected_method_${method}` });
  },
  websocket: {
    open(ws) {
      ws.send(JSON.stringify({ type: 'hello', num_connections: 1, debug_info: {} }));
    },
    message(ws, message) {
      const frame = JSON.parse(String(message));
      if (frame.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    },
  },
});
