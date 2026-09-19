import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { BriefModal } from './BriefModal';
import type { ConversationSummary } from '../primitives/conversation';

/** The callbacks are not what these tests assert on — only the markup is. */
const noop = (): void => {
  /* intentionally does nothing */
};

const conv = (over: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: 'web-1',
  dbId: 'db-1',
  title: 'Console chat rail',
  platformType: 'web',
  lastActivityAt: null,
  color: null,
  archived: false,
  brief: null,
  briefUpdatedAt: null,
  briefPinned: false,
  ...over,
});

const render = (over: Partial<ConversationSummary> = {}, props = {}): string =>
  renderToStaticMarkup(
    <BriefModal conversation={conv(over)} onClose={noop} onSave={noop} {...props} />
  );

describe('BriefModal', () => {
  test('reads the three parts under their own labels', () => {
    const html = render({
      brief: '{"doing":"Building the rail","where":"Half done","left":"Deploy it"}',
    });
    expect(html).toContain('WHAT WE ARE DOING');
    expect(html).toContain('Building the rail');
    expect(html).toContain('WHERE WE ARE');
    expect(html).toContain('Half done');
    // Escaped by the renderer — the label's apostrophe is not a bug.
    expect(html).toContain('WHAT&#x27;S LEFT');
    expect(html).toContain('Deploy it');
  });

  test('a part nobody wrote is absent, not an empty labelled box', () => {
    const html = render({ brief: '{"doing":"Building the rail"}' });
    expect(html).toContain('WHAT WE ARE DOING');
    expect(html).not.toContain('WHERE WE ARE');
  });

  test('free text written before the three-part shape is still readable', () => {
    const html = render({ brief: 'We are building the rail.' });
    expect(html).toContain('We are building the rail.');
  });

  test('with no summary it opens in the editor, not on a dead end', () => {
    const html = render();
    // All three boxes, so the shape of a summary is visible before writing one.
    expect(html).toContain('WHAT WE ARE DOING');
    expect(html).toContain('Leave empty if it does not apply');
    expect(html).toContain('Save');
  });

  test('the card can open an existing summary straight into the editor', () => {
    const html = render({ brief: '{"doing":"Rail"}' }, { startEditing: true });
    expect(html).toContain('<textarea');
    expect(html).toContain('editing');
  });

  test('says who wrote it, and when', () => {
    const html = render({
      brief: '{"doing":"Rail"}',
      briefPinned: true,
      briefUpdatedAt: new Date(Date.now() - 120_000).toISOString(),
    });
    expect(html).toContain('yours');
    expect(html).toContain('2m ago');
  });

  test('an old summary says so rather than looking current', () => {
    const html = render({
      brief: '{"doing":"Rail"}',
      briefUpdatedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    });
    expect(html).toContain('may be stale');
  });

  test('Refresh appears only when the caller can actually send', () => {
    expect(render({ brief: '{"doing":"Rail"}' })).not.toContain('Refresh');
    expect(render({ brief: '{"doing":"Rail"}' }, { onRefresh: noop })).toContain('Refresh');
  });

  test('the title names the chat so the modal is never ambiguous', () => {
    expect(render({ brief: '{"doing":"Rail"}' })).toContain('Console chat rail');
  });
});
