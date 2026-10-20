import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ChatStartError, connectChat } from '../../packages/chat-contract/src/index';
import { loadChatPlugins } from '../../packages/core/src/platforms/chat-plugins';
import { chatReceiptSchema } from '../../packages/plugin-manifest/src/index';
import { readReceipts, receiptPath } from '../../packages/plugin-manifest/src/store';
import { inspectChatPlugin } from '../../packages/cli/src/commands/inspect-chat-plugin';
import { IMAGE_SLACK_PLUGIN } from '../../packages/cli/src/commands/image-chat-plugin';

const pluginsDir = '/.archon/plugins';
const receiptFile = receiptPath(pluginsDir, IMAGE_SLACK_PLUGIN);
const mode = process.argv[2];
if (mode === 'absent') {
  if ((await readReceipts(pluginsDir)).length) throw new Error('Expected no installed plugins');
} else if (mode === 'fingerprint') {
  console.log(
    createHash('sha256')
      .update(await readFile(receiptFile))
      .digest('hex')
  );
} else {
  const receipt = chatReceiptSchema.parse(JSON.parse(await readFile(receiptFile, 'utf8')));
  const imageReceipt = chatReceiptSchema.parse(
    JSON.parse(await readFile(receiptPath('/opt/archon/image-plugins', IMAGE_SLACK_PLUGIN), 'utf8'))
  );
  if (receipt.tag !== imageReceipt.tag || receipt.commit !== imageReceipt.commit)
    throw new Error('Image release provenance was not preserved');
  const executable = join(pluginsDir, receipt.manifest.executable);
  const file = receipt.files.find(entry => entry.path === receipt.manifest.executable);
  if (
    !file ||
    file.sha256 !==
      createHash('sha256')
        .update(await readFile(executable))
        .digest('hex')
  )
    throw new Error('Executable digest does not match receipt');
  for (const path of [receiptFile, executable]) {
    if ((await stat(path)).uid !== 1001) throw new Error(`Not owned by appuser: ${path}`);
  }
  const selected = await loadChatPlugins(pluginsDir);
  if (
    selected.length !== 1 ||
    selected[0]?.argv[0] !== executable ||
    !isDeepStrictEqual(selected[0]?.descriptor, receipt.descriptor)
  )
    throw new Error('Runtime did not select installed Slack');
  if (!isDeepStrictEqual(await inspectChatPlugin(executable), receipt.descriptor))
    throw new Error('Installed binary descriptor does not match receipt');
  if (mode === 'real' || mode === 'live') {
    const child = Bun.spawn([executable], {
      env:
        mode === 'live'
          ? {
              ...process.env,
              SLACK_BOT_TOKEN: 'xoxb-upgrade-test',
              SLACK_APP_TOKEN: 'xapp-upgrade-test',
            }
          : { ...process.env, SLACK_BOT_TOKEN: '', SLACK_APP_TOKEN: '' },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const timer = setTimeout(() => child.kill(), 10_000);
    try {
      const chat = await connectChat(
        {
          readable: child.stdout,
          writable: new WritableStream({
            async write(bytes) {
              child.stdin.write(bytes);
              await child.stdin.flush();
            },
            async close() {
              await child.stdin.end();
            },
          }),
        },
        receipt.descriptor
      );
      try {
        if (mode === 'live') {
          await chat.start();
          await chat.send({ conversationId: 'CTEST', text: 'Docker upgrade delivery' });
          const response = await fetch('https://slack.com/delivered');
          const result = await response.json();
          if (!result.delivered) throw new Error('Actual Slack binary did not deliver the message');
        } else {
          let failure: unknown;
          try {
            await chat.start();
          } catch (error) {
            failure = error;
          }
          if (!(failure instanceof ChatStartError) || failure.retryable)
            throw new Error('Real Slack must refuse missing tokens non-retryably');
        }
      } finally {
        await chat.close();
      }
      if ((await child.exited) !== 0) throw new Error('Slack failed graceful protocol shutdown');
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
    }
  }
  console.log(`Verified ${receipt.id}@${receipt.tag} (commit ${receipt.commit}) offline`);
}
