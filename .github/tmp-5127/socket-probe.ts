// TEMPORARY (#5127): remove before the pull request is marked ready.
// Reproduces the detached-timeout test's ready signal outside the test. A listener in this
// process records every socket event; a separate Bun process connects the way hold.ts does.
// Mode `end` is the old signal (socket.end(pid) in open, resolved by the listener's end).
// Mode `line` is the new one (pid plus newline written in open, resolved in data).
const iterations = Number(process.argv[2] ?? 200);
type Mode = 'end' | 'line';
const clients: Record<Mode, string> = {
  end: 'socket.end(String(process.pid));',
  line: 'socket.write(process.pid + String.fromCharCode(10));',
};

async function attempt(mode: Mode): Promise<string> {
  const events: string[] = [];
  let signal = '';
  const done = Promise.withResolvers<void>();
  const listener = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open: () => void events.push('open'),
      data: (_socket, data) => {
        events.push('data');
        signal += data.toString();
        if (mode === 'line' && signal.includes('\n')) done.resolve();
      },
      end: () => {
        events.push('end');
        if (mode === 'end') done.resolve();
      },
      close: (_socket, error) => void events.push(error ? `close(${error})` : 'close'),
      error: (_socket, error) => void events.push(`error(${error})`),
    },
  });
  const client = Bun.spawn(
    [
      process.execPath,
      '-e',
      `await Bun.connect({ hostname: '127.0.0.1', port: ${listener.port}, socket: { open: socket => { ${clients[mode]} }, data: () => {} } }); setInterval(() => {}, 1000);`,
    ],
    { stdout: 'ignore', stderr: 'pipe' }
  );
  const outcome = await Promise.race([
    done.promise.then(() => 'ok'),
    Bun.sleep(5000).then(() => 'stalled'),
    client.exited.then(code => `client exited ${code}`),
  ]);
  const snapshot = events.join(' ');
  client.kill();
  await client.exited;
  listener.stop(true);
  return outcome === 'ok' ? 'ok' : `${outcome} [events: ${snapshot || 'none'}] signal=${JSON.stringify(signal)}`;
}

let lineFailed = false;
for (const mode of ['end', 'line'] as const) {
  const tally = new Map<string, number>();
  for (let i = 0; i < iterations; i++) {
    const result = await attempt(mode);
    tally.set(result, (tally.get(result) ?? 0) + 1);
    if (result !== 'ok') console.log(`${mode} #${i}: ${result}`);
  }
  console.log(`mode ${mode} on ${process.platform}:`, Object.fromEntries(tally));
  if (mode === 'line' && tally.size > 1) lineFailed = true;
}
process.exit(lineFailed ? 1 : 0);
