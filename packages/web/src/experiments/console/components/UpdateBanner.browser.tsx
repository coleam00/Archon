import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { UpdateBanner } from './UpdateBanner';
import { set } from '../store/cache';
import { K } from '../store/keys';

const container = document.createElement('div');
document.body.append(container);
let root = createRoot(container);
const update = {
  updateAvailable: true,
  currentVersion: '0.11.1',
  latestVersion: '0.12.0',
  releaseUrl: 'https://example.com/release',
};
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}
try {
  localStorage.clear();
  set(K.updateCheck, update);
  flushSync(() => {
    root.render(<UpdateBanner />);
  });
  assert(container.textContent?.includes('0.12.0'), 'banner did not appear');
  assert(
    container.querySelector('a')?.href === 'https://archon.diy/getting-started/updating/',
    'missing update guide link'
  );
  const dismiss = container.querySelector<HTMLButtonElement>(
    '[aria-label="Dismiss update notice"]'
  );
  if (!dismiss) throw new Error('missing dismiss button');
  flushSync(() => {
    dismiss.click();
  });
  assert(container.textContent === '', 'click did not hide the banner');
  root.unmount();
  root = createRoot(container);
  flushSync(() => {
    root.render(<UpdateBanner />);
  });
  assert(container.textContent === '', 'dismissal did not survive remount');
  flushSync(() => {
    set(K.updateCheck, { ...update, latestVersion: '0.13.0' });
  });
  assert(container.textContent?.includes('0.13.0'), 'new release did not appear');
  flushSync(() => {
    set(K.updateCheck, { ...update, updateAvailable: false });
  });
  assert(container.textContent === '', 'banner appeared without an update');
  root.unmount();
  void fetch('/result', { method: 'POST', body: 'passed' });
} catch (error) {
  void fetch('/result', { method: 'POST', body: String(error) });
}
