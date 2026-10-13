import { resolve } from 'node:path';
import { ChatStartError, connectChat } from '@archon/chat-contract';
import { descriptor } from '../descriptor';

export async function smoke(command: string[]): Promise<void> {
  const child = Bun.spawn(command, {
    env: { ...process.env, SLACK_BOT_TOKEN: '', SLACK_APP_TOKEN: '' },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const deadline = setTimeout(() => child.kill(), 10000);
  try {
    const chat = await connectChat(
      {
        readable: child.stdout,
        writable: new WritableStream({
          async write(value) {
            child.stdin.write(value);
            await child.stdin.flush();
          },
          async close() {
            await child.stdin.end();
          },
        }),
      },
      descriptor
    );
    try {
      let failure: unknown;
      try {
        await chat.start();
      } catch (error) {
        failure = error;
      }
      if (!(failure instanceof ChatStartError) || failure.retryable)
        throw new Error('Missing Slack tokens must fail chat/start non-retryably');
    } finally {
      await chat.close();
    }
    if ((await child.exited) !== 0) throw new Error('Slack plugin did not shut down cleanly');
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) child.kill();
  }
}

if (import.meta.main) {
  const binary = process.argv[2];
  if (!binary) throw new Error('Usage: smoke.ts <Slack plugin binary>');
  await smoke([resolve(binary)]);
  console.log('Slack plugin initializes without credentials and refuses start without tokens.');
}
