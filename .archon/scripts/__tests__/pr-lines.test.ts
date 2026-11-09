/** The lines a merged pull request records: added lines split by test path, never counted short. */
import { expect, it } from 'bun:test';
import { addedLines } from '../../workflows/sdlc/.shared/pr-lines';

it('counts added lines in test and production files, and skips a pull request it cannot count fully', () => {
  const patch = '@@ -1,2 +1,3 @@\n context\n-old\n+new\n+more';
  const files = [
    { path: 'src/a.ts', status: 'modified', patch },
    { path: 'src/a.test.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+test' },
    { path: 'packages/x/__tests__/b.ts', status: 'modified', patch },
    { path: 'gone.bin', status: 'removed', patch: null },
  ];
  expect(addedLines(files)).toEqual({ test: 3, production: 2 });
  expect(addedLines([...files, { path: 'logo.png', status: 'added', patch: null }])).toEqual({
    reason: 'the forge reports no patch for logo.png',
  });
});
