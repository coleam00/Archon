import { describe, expect, test } from 'bun:test';
import { serializeLoggedError } from './log-error-serializer';

describe('serializeLoggedError', () => {
  test('drops the failed request a vendor SDK error carries', () => {
    // grammy GrammyError: payload holds the chat id (the user's id in a private
    // chat) and the message text.
    const grammy = Object.assign(new Error('Call to sendMessage failed! (400: Bad Request)'), {
      name: 'GrammyError',
      error_code: 400,
      method: 'sendMessage',
      payload: { chat_id: 123456789, text: 'Help @alice' },
    });
    // discord.js DiscordAPIError: requestBody holds the message content.
    const discord = Object.assign(new Error('Invalid Form Body'), {
      name: 'DiscordAPIError[50035]',
      code: 50035,
      requestBody: { files: undefined, json: { content: 'Help @alice' } },
    });
    // Octokit RequestError: request holds the comment body.
    const octokit = Object.assign(new Error('Validation Failed'), {
      name: 'HttpError',
      status: 422,
      request: { method: 'POST', url: 'https://api.github.com/x', body: '{"body":"Help @alice"}' },
    });

    const logged = JSON.stringify([grammy, discord, octokit].map(serializeLoggedError));

    expect(logged).not.toContain('alice');
    expect(logged).not.toContain('123456789');
    expect(serializeLoggedError(grammy)).toMatchObject({ name: 'GrammyError', error_code: 400 });
    expect(serializeLoggedError(discord)).toMatchObject({ code: 50035 });
    expect(serializeLoggedError(octokit)).toMatchObject({ status: 422 });
  });

  test('keeps an ordinary error intact', () => {
    const err = Object.assign(new Error('spawn failed'), { code: 'ENOENT' });
    expect(serializeLoggedError(err)).toMatchObject({
      type: 'Error',
      message: 'spawn failed',
      code: 'ENOENT',
    });
  });
});
