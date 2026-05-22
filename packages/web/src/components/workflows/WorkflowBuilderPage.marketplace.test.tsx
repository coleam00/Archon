/**
 * Verifies that WorkflowBuilderPage passes the hard-coded MARKETPLACE_URL down to
 * <WorkflowBuilder>. We stub @archon/workflow-studio-core to render the prop
 * value into the DOM so we can assert on it without spinning up the full
 * studio (ReactFlow, QueryClient, ApiClientProvider, position persistence).
 *
 * mock.module() is process-permanent in Bun; this file is the only one in the
 * web `src/components/` test batch that mocks any of these modules, so there
 * is no cross-file pollution risk.
 */
import { describe, it, expect, beforeAll, afterEach, mock } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { MemoryRouter } from 'react-router';

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

afterEach(() => {
  cleanup();
});

interface StubBuilderProps {
  marketplaceUrl?: string;
  showValidateButton?: boolean;
}

// Stub studio core: WorkflowBuilder renders its marketplaceUrl into an <a> so
// the test can assert on the value the page passed in.
mock.module('@archon/workflow-studio-core', () => {
  function useBuilderStore(selector?: (s: { workflow: null }) => unknown): unknown {
    const state = { workflow: null };
    return selector ? selector(state) : state;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (useBuilderStore as any).getState = (): { workflow: null } => ({ workflow: null });
  return {
    useBuilderStore,
    WorkflowBuilder: ({
      marketplaceUrl,
      showValidateButton,
    }: StubBuilderProps): React.ReactElement => (
      <div data-testid="studio-stub">
        <span data-testid="show-validate">{String(!!showValidateButton)}</span>
        {marketplaceUrl ? (
          <a href={marketplaceUrl} target="_blank" rel="noopener noreferrer">
            stub-marketplace-link
          </a>
        ) : null}
      </div>
    ),
  };
});

mock.module('@/contexts/ProjectContext', () => ({
  useProject: (): {
    codebases: { id: string; default_cwd: string }[];
    selectedProjectId: string;
  } => ({
    codebases: [{ id: 'p', default_cwd: '/tmp/repo' }],
    selectedProjectId: 'p',
  }),
}));

mock.module('@/hooks/use-workflow-hydration', () => ({
  useWorkflowHydration: (): { status: string; error: null } => ({
    status: 'loaded',
    error: null,
  }),
}));

mock.module('@/lib/web-workflow-api-client', () => ({
  createWebWorkflowApiClient: (): Record<string, never> => ({}),
}));

mock.module('@/lib/save-flow', () => ({
  runSaveFlow: async (): Promise<{ kind: 'saved'; name: string }> => ({
    kind: 'saved',
    name: 'unused',
  }),
}));

// Dynamic import after mock.module() registration above. Module alias is
// camelCase to satisfy @typescript-eslint/naming-convention for const bindings;
// the JSX tag uses member-expression syntax (PascalCase suffix is allowed).
const pageMod = await import('@/routes/WorkflowBuilderPage');

describe('WorkflowBuilderPage marketplace link', () => {
  it('renders an anchor with the canonical upstream marketplace URL', () => {
    render(
      <MemoryRouter initialEntries={['/workflows/builder']}>
        <pageMod.WorkflowBuilderPage />
      </MemoryRouter>
    );
    const anchor = screen.getByRole('link', { name: /stub-marketplace-link/i });
    expect(anchor.getAttribute('href')).toBe(
      'https://github.com/coleam00/Archon/blob/main/CONTRIBUTING.md#contributing-workflows-to-the-marketplace'
    );
    expect(anchor.getAttribute('target')).toBe('_blank');
    expect(screen.getByTestId('show-validate').textContent).toBe('true');
  });
});
