import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { SegmentedControl } from './SegmentedControl';
import { SkeletonFigure, SkeletonGroup, SkeletonLine } from './Skeleton';
import { TabLink } from './TabLink';

const routed = (element: React.ReactElement): string =>
  renderToStaticMarkup(<MemoryRouter>{element}</MemoryRouter>);

test('a skeleton is shapes a screen reader skips, labelled once by its group, never "Loading…"', () => {
  const html = renderToStaticMarkup(
    <SkeletonGroup label="Loading the board">
      <SkeletonLine />
      <SkeletonFigure />
    </SkeletonGroup>
  );
  expect(html).toContain('role="status"');
  expect(html.match(/Loading the board/g)?.length).toBe(1);
  expect(html.match(/aria-hidden="true"/g)?.length).toBe(2);
  expect(html).not.toContain('Loading…');
});

test('a tab row and a segmented control each mark one active entry, as a link or a button', () => {
  const tabs = routed(
    <>
      <TabLink to="/a" active>
        A
      </TabLink>
      <TabLink to="/b" active={false}>
        B
      </TabLink>
    </>
  );
  expect(tabs.match(/aria-current="page"/g)?.length).toBe(1);
  const segments = (onSelect?: () => void) =>
    routed(
      <SegmentedControl
        label="Board view"
        active="table"
        segments={['pipeline', 'table'].map(key => ({
          key,
          label: key,
          ...(onSelect ? { onSelect } : { to: `?view=${key}` }),
        }))}
      />
    );
  expect(segments()).toContain('aria-label="Board view"');
  expect(segments().match(/aria-current="page"/g)?.length).toBe(1);
  expect(segments(() => undefined).match(/aria-pressed="true"/g)?.length).toBe(1);
});
