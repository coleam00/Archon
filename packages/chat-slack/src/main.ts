import { serveChat } from '@archon/chat-contract';
import { SlackPlugin } from './plugin';

export async function run(plugin = new SlackPlugin()): Promise<void> {
  try {
    await serveChat(plugin);
  } finally {
    await plugin.stop();
  }
}

if (import.meta.main) await run();
