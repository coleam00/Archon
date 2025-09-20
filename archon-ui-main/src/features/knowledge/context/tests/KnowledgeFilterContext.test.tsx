import { describe, it, expect } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { KnowledgeFilterProvider, useCurrentKnowledgeFilter } from '../KnowledgeFilterContext';
import type { KnowledgeFilter } from '../../types';

// Test component that uses the context
function TestComponent() {
  const { currentFilter, updateFilter, isCurrentFilter } = useCurrentKnowledgeFilter();

  return (
    <div>
      <div data-testid="current-filter">{JSON.stringify(currentFilter)}</div>
      <div data-testid="is-default">{isCurrentFilter({ type: 'all', search: '', page: 1, per_page: 100 }).toString()}</div>
      <button
        data-testid="update-search"
        onClick={() => updateFilter({ search: 'test search' })}
      >
        Update Search
      </button>
      <button
        data-testid="update-type"
        onClick={() => updateFilter({ type: 'document' })}
      >
        Update Type
      </button>
      <button
        data-testid="update-pagination"
        onClick={() => updateFilter({ page: 2, per_page: 50 })}
      >
        Update Pagination
      </button>
    </div>
  );
}

function TestComponentWithoutProvider() {
  const hook = useCurrentKnowledgeFilter();
  return <div data-testid="hook-result">{JSON.stringify(hook)}</div>;
}

describe('KnowledgeFilterContext', () => {
  describe('KnowledgeFilterProvider', () => {
    it('should provide default filter state', () => {
      render(
        <KnowledgeFilterProvider>
          <TestComponent />
        </KnowledgeFilterProvider>
      );

      const filterDisplay = screen.getByTestId('current-filter');
      const defaultFilter = JSON.parse(filterDisplay.textContent || '{}');

      expect(defaultFilter).toEqual({
        type: 'all',
        search: '',
        page: 1,
        per_page: 100
      });
    });

    it('should accept custom initial filter', () => {
      const customFilter: KnowledgeFilter = {
        type: 'document',
        search: 'initial search',
        page: 2,
        per_page: 50
      };

      render(
        <KnowledgeFilterProvider initialFilter={customFilter}>
          <TestComponent />
        </KnowledgeFilterProvider>
      );

      const filterDisplay = screen.getByTestId('current-filter');
      const currentFilter = JSON.parse(filterDisplay.textContent || '{}');

      expect(currentFilter).toEqual(customFilter);
    });

    it('should update filter state when updateFilter is called', async () => {
      const user = userEvent.setup();

      render(
        <KnowledgeFilterProvider>
          <TestComponent />
        </KnowledgeFilterProvider>
      );

      const updateButton = screen.getByTestId('update-search');
      await user.click(updateButton);

      const filterDisplay = screen.getByTestId('current-filter');
      const updatedFilter = JSON.parse(filterDisplay.textContent || '{}');

      expect(updatedFilter).toEqual({
        type: 'all',
        search: 'test search',
        page: 1,
        per_page: 100
      });
    });

    it('should merge filter updates with existing state', async () => {
      const user = userEvent.setup();

      render(
        <KnowledgeFilterProvider>
          <TestComponent />
        </KnowledgeFilterProvider>
      );

      // Update search first
      await user.click(screen.getByTestId('update-search'));

      // Then update type
      await user.click(screen.getByTestId('update-type'));

      const filterDisplay = screen.getByTestId('current-filter');
      const finalFilter = JSON.parse(filterDisplay.textContent || '{}');

      expect(finalFilter).toEqual({
        type: 'document',
        search: 'test search',
        page: 1,
        per_page: 100
      });
    });

    it('should handle pagination updates correctly', async () => {
      const user = userEvent.setup();

      render(
        <KnowledgeFilterProvider>
          <TestComponent />
        </KnowledgeFilterProvider>
      );

      await user.click(screen.getByTestId('update-pagination'));

      const filterDisplay = screen.getByTestId('current-filter');
      const updatedFilter = JSON.parse(filterDisplay.textContent || '{}');

      expect(updatedFilter).toEqual({
        type: 'all',
        search: '',
        page: 2,
        per_page: 50
      });
    });
  });

  describe('useCurrentKnowledgeFilter', () => {
    it('should throw error when used outside provider', () => {
      // Suppress console.error for this test
      const originalError = console.error;
      console.error = () => {};

      expect(() => {
        render(<TestComponentWithoutProvider />);
      }).toThrow('useCurrentKnowledgeFilter must be used within a KnowledgeFilterProvider');

      console.error = originalError;
    });

    it('should correctly identify current filter', () => {
      render(
        <KnowledgeFilterProvider>
          <TestComponent />
        </KnowledgeFilterProvider>
      );

      const isDefaultDisplay = screen.getByTestId('is-default');
      expect(isDefaultDisplay.textContent).toBe('true');
    });

    it('should correctly identify non-current filter', async () => {
      const user = userEvent.setup();

      render(
        <KnowledgeFilterProvider>
          <TestComponent />
        </KnowledgeFilterProvider>
      );

      // Change the filter
      await user.click(screen.getByTestId('update-search'));

      const isDefaultDisplay = screen.getByTestId('is-default');
      expect(isDefaultDisplay.textContent).toBe('false');
    });

    it('should handle partial filter comparisons', () => {
      const TestPartialComponent = () => {
        const { isCurrentFilter } = useCurrentKnowledgeFilter();

        // Test with partial filter matching
        const isPartialMatch = isCurrentFilter({
          type: 'all',
          search: ''
        });

        return <div data-testid="partial-match">{isPartialMatch.toString()}</div>;
      };

      render(
        <KnowledgeFilterProvider>
          <TestPartialComponent />
        </KnowledgeFilterProvider>
      );

      const partialMatchDisplay = screen.getByTestId('partial-match');
      expect(partialMatchDisplay.textContent).toBe('true');
    });

    it('should maintain filter state across re-renders', async () => {
      let renderCount = 0;

      const TestRerenderComponent = () => {
        renderCount++;
        const { currentFilter, updateFilter } = useCurrentKnowledgeFilter();

        return (
          <div>
            <div data-testid="render-count">{renderCount}</div>
            <div data-testid="filter-state">{JSON.stringify(currentFilter)}</div>
            <button
              data-testid="trigger-update"
              onClick={() => updateFilter({ search: 'persistent' })}
            >
              Update
            </button>
          </div>
        );
      };

      const user = userEvent.setup();

      render(
        <KnowledgeFilterProvider>
          <TestRerenderComponent />
        </KnowledgeFilterProvider>
      );

      // Update the filter
      await user.click(screen.getByTestId('trigger-update'));

      const filterState = screen.getByTestId('filter-state');
      const currentFilter = JSON.parse(filterState.textContent || '{}');

      expect(currentFilter.search).toBe('persistent');
      expect(renderCount).toBeGreaterThan(1);
    });
  });

  describe('Filter Comparison Logic', () => {
    it('should handle deep equality correctly', () => {
      const TestDeepEqualityComponent = () => {
        const { isCurrentFilter } = useCurrentKnowledgeFilter();

        const exactMatch = isCurrentFilter({
          type: 'all',
          search: '',
          page: 1,
          per_page: 100
        });

        const differentType = isCurrentFilter({
          type: 'document',
          search: '',
          page: 1,
          per_page: 100
        });

        return (
          <div>
            <div data-testid="exact-match">{exactMatch.toString()}</div>
            <div data-testid="different-type">{differentType.toString()}</div>
          </div>
        );
      };

      render(
        <KnowledgeFilterProvider>
          <TestDeepEqualityComponent />
        </KnowledgeFilterProvider>
      );

      expect(screen.getByTestId('exact-match').textContent).toBe('true');
      expect(screen.getByTestId('different-type').textContent).toBe('false');
    });
  });
});