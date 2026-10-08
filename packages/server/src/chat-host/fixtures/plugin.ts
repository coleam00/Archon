import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { serveChat, ChatStartError } from '@archon/chat-contract';
import { descriptor } from './descriptor';

const [mode, file] = process.argv.slice(2);
if (file) appendFileSync(file, `${String(process.pid)}\n`);
await serveChat({
  descriptor: mode === 'mismatch' ? { ...descriptor, version: '2' } : descriptor,
  async start(ctx) {
    if (mode === 'traffic') {
      await ctx.inbound({
        conversationId: 'thread',
        text: 'hello',
        sender: { platformUserId: 'starter' },
      });
      await ctx.runAction({
        runId: 'run',
        action: 'cancel',
        sender: { platformUserId: 'starter' },
      });
    }
    console.error('SECRET_TOKEN USER_MESSAGE');
    if (mode === 'nonretry') throw new ChatStartError('SECRET_TOKEN USER_MESSAGE', false);
    if (mode === 'retry') throw new ChatStartError('SECRET_TOKEN USER_MESSAGE', true);
    if (mode === 'crash') setTimeout(() => process.exit(1), 20);
    if (mode === 'descendant') {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      });
      appendFileSync(file, `child:${String(child.pid)}\n`);
      setInterval(() => undefined, 1000);
    }
  },
  async send() {
    if (mode === 'senderror') throw new Error('SECRET_TOKEN USER_MESSAGE');
    if (mode === 'hang') await new Promise(() => undefined);
  },
  async resultFooter(): Promise<void> {
    return undefined;
  },
  async onRunEvent(): Promise<void> {
    return undefined;
  },
});
