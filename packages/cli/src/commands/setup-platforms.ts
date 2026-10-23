/**
 * The chat-adapter step of `archon setup`: choosing platforms and collecting
 * Telegram and Slack credentials and the bot display name.
 */
import { confirm, isCancel, log, multiselect, note, password, text } from '@clack/prompts';
import {
  cancelSetup,
  type SetupConfig,
  type SlackConfig,
  type TelegramConfig,
} from './setup-shared';
import { createPlatformSelection, SETUP_PLATFORMS } from './setup-platform-selection';

/**
 * Collect platform selection
 */
export async function collectPlatforms(): Promise<SetupConfig['platforms']> {
  const platforms = await multiselect({
    message:
      'Which chat adapters do you want to connect? (all optional — Archon works as CLI + skill without any)\n(↑↓ navigate, space select, enter confirm)',
    options: [...SETUP_PLATFORMS],
    required: false,
  });

  if (isCancel(platforms)) cancelSetup();

  return createPlatformSelection(platform => platforms.includes(platform));
}

/**
 * Collect Telegram credentials
 */
export async function collectTelegramConfig(): Promise<TelegramConfig> {
  note(
    'SECURITY: Telegram bots are public by default — anyone can DM your bot.\n' +
      'Set TELEGRAM_ALLOWED_USER_IDS to restrict access to your user ID only.\n\n' +
      'To find your user ID:\n' +
      '1. Open Telegram and search for @userinfobot\n' +
      '2. Send any message — it replies with your user ID (a number)',
    'Telegram Security'
  );

  note(
    'Telegram Bot Setup\n\n' +
      'Step 1: Create your bot\n' +
      '1. Open Telegram and search for @BotFather\n' +
      '2. Send /newbot\n' +
      '3. Choose a display name (e.g., "My Archon Bot")\n' +
      '4. Choose a username (must end in "bot")\n' +
      '5. Copy the token BotFather gives you',
    'Telegram Setup'
  );

  const botToken = await password({
    message: 'Enter your Telegram Bot Token:',
    validate: value => {
      if (!value?.includes(':')) {
        return 'Please enter a valid bot token (format: 123456:ABC...)';
      }
      return undefined;
    },
  });

  if (isCancel(botToken)) cancelSetup();

  // Do NOT set required: true — clack's text() blocks the enter key when
  // required is true and the value is empty, which traps the user. Validate
  // post-hoc with a warning instead.
  const allowedUserIds = await text({
    message: 'Enter allowed Telegram user IDs (comma-separated):',
    placeholder: '123456789,987654321',
  });

  if (isCancel(allowedUserIds)) cancelSetup();

  if (!allowedUserIds?.trim()) {
    log.warning(
      'No allowlist set — your Telegram bot will accept messages from ANYONE.\n' +
        'Add TELEGRAM_ALLOWED_USER_IDS to ~/.archon/.env after setup to restrict access.'
    );
  }

  return {
    botToken,
    allowedUserIds: allowedUserIds || '',
  };
}

/**
 * Collect Slack credentials
 */
export async function collectSlackConfig(): Promise<SlackConfig> {
  note(
    'Slack App Setup\n\n' +
      'Slack setup requires creating an app at api.slack.com/apps\n\n' +
      '1. Create a new app "From scratch"\n' +
      '2. Enable Socket Mode:\n' +
      '   - Settings -> Socket Mode -> Enable\n' +
      '   - Generate an App-Level Token (xapp-...)\n' +
      '3. Add Bot Token Scopes (OAuth & Permissions):\n' +
      '   - app_mentions:read, chat:write, channels:history\n' +
      '   - channels:join, im:history, im:write, im:read\n' +
      '4. Subscribe to Bot Events (Event Subscriptions):\n' +
      '   - app_mention, message.im\n' +
      '5. Install to Workspace\n' +
      '   - Copy the Bot User OAuth Token (xoxb-...)\n' +
      '6. Invite bot to your channel: /invite @YourBotName\n' +
      '7. Install the Slack plugin, then restart the server:\n' +
      '   archon plugin add coleam00/Archon/plugins/chat-slack\n\n' +
      'Get your user ID: Click profile -> ... -> Copy member ID',
    'Slack Setup'
  );

  const botToken = await password({
    message: 'Enter your Slack Bot Token (xoxb-...):',
    validate: value => {
      if (!value?.startsWith('xoxb-')) {
        return 'Please enter a valid bot token (starts with xoxb-)';
      }
      return undefined;
    },
  });

  if (isCancel(botToken)) cancelSetup();

  const appToken = await password({
    message: 'Enter your Slack App Token (xapp-...):',
    validate: value => {
      if (!value?.startsWith('xapp-')) {
        return 'Please enter a valid app token (starts with xapp-)';
      }
      return undefined;
    },
  });

  if (isCancel(appToken)) cancelSetup();

  const allowedUserIds = await text({
    message: 'Enter allowed Slack user IDs (comma-separated, or leave empty for all):',
    placeholder: 'U12345678,U87654321',
  });

  if (isCancel(allowedUserIds)) cancelSetup();

  return {
    botToken,
    appToken,
    allowedUserIds: allowedUserIds || '',
  };
}

/**
 * Collect bot display name
 */
export async function collectBotDisplayName(): Promise<string> {
  const customName = await confirm({
    message: 'Do you want to set a custom bot display name? (Default: Archon)',
  });

  if (isCancel(customName)) cancelSetup();

  if (!customName) {
    return 'Archon';
  }

  const name = await text({
    message: 'Enter the bot display name:',
    placeholder: 'Archon',
    validate: value => {
      if (!value) return 'Name is required';
      return undefined;
    },
  });

  if (isCancel(name)) cancelSetup();

  return name;
}
