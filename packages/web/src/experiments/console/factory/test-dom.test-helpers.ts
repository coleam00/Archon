import { afterAll } from 'bun:test';
import { Window } from 'happy-dom';
import { act, type ReactElement } from 'react';

/** The attention stream and live reads open an EventSource; nothing streams in a test. */
class QuietEventSource {
  onmessage: unknown = null;
  onerror: unknown = null;
  readyState = 0;
  close(): void {
    this.readyState = 2;
  }
}

/** A mounted tree and the way to take it down again. */
export interface Mounted {
  container: HTMLElement;
  unmount: () => Promise<void>;
}

/**
 * Installs a happy-dom window as the test file's globals, with a quiet EventSource and a fetch
 * that throws (every read should come from the cache the test sets; a test that serves requests
 * assigns its own `globalThis.fetch`). Everything is restored after the file. Call it at the top
 * level, before anything renders: react-dom must load after `window` exists.
 */
export async function installDom(): Promise<{
  dom: Window;
  mount: (tree: ReactElement) => Promise<Mounted>;
  settle: () => Promise<void>;
}> {
  const dom = new Window({ url: 'http://localhost' });
  const globals = {
    window: dom,
    document: dom.document,
    EventSource: QuietEventSource,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = new Map(
    Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  );
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL): Promise<Response> => {
      throw new Error(`the test fetched ${String(input)}`);
    },
    { preconnect: originalFetch.preconnect }
  );
  const { createRoot } = await import('react-dom/client');

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    await dom.happyDOM.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  async function mount(tree: ReactElement): Promise<Mounted> {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(tree));
    return {
      container,
      unmount: async (): Promise<void> => {
        await act(async () => root.unmount());
        container.remove();
      },
    };
  }

  /** Lets pending promises and zero-delay timers run inside act. */
  const settle = (): Promise<void> =>
    act(async () => new Promise(resolve => setTimeout(resolve, 0)));

  return { dom, mount, settle };
}
