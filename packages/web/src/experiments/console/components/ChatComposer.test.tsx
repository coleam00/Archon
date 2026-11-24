import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatComposer } from './ChatComposer';

const noop = (): void => undefined;

test('Stop takes the place of Send only while a reply is in flight', () => {
  const busy = renderToStaticMarkup(<ChatComposer onSend={noop} disabled onStop={noop} />);
  expect(busy).toContain('aria-label="Stop response"');
  expect(busy).not.toContain('Send');

  const idle = renderToStaticMarkup(<ChatComposer onSend={noop} disabled={false} onStop={noop} />);
  expect(idle).not.toContain('Stop response');
  expect(idle).toContain('Send');

  // Before the chat exists there is nothing to stop.
  const creating = renderToStaticMarkup(<ChatComposer onSend={noop} disabled />);
  expect(creating).not.toContain('Stop response');
});
