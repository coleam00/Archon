import { plugin } from 'bun';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

// Register happy-dom globally BEFORE any test module imports a library (e.g.,
// @testing-library/dom's `screen`) that captures `document` at module load.
if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// Stub `.module.css` imports — return a Proxy whose property access yields the key as a string.
// Tests must select by `data-*` attributes, NOT by class name, to stay robust under this stub.
plugin({
  name: 'css-stub',
  setup(build) {
    build.onLoad({ filter: /\.module\.css$/ }, () => ({
      loader: 'js',
      contents: 'export default new Proxy({}, { get: (_, k) => k });',
    }));
    // Plain `.css` imports (e.g., '@xyflow/react/dist/style.css') become no-ops.
    build.onLoad({ filter: /\.css$/ }, () => ({
      loader: 'js',
      contents: 'export default {};',
    }));
  },
});

// React Flow uses ResizeObserver for the canvas viewport; happy-dom doesn't ship it.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
