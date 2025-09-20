import { describe, it, expect } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { KnowledgeFilterProvider, useKnowledgeFilter } from '../KnowledgeFilterContext';
import type { KnowledgeFilter } from '../../types';

// Test component that uses the context
function TestComponent() {
  const { currentFilter, searchQuery, typeFilter, setSearchQuery, setTypeFilter } = useKnowledgeFilter();

  return (
    <div>
      <div data-testid="current-filter">{JSON.stringify(currentFilter)}</div>
      <div data-testid="search-query">{searchQuery}</div>
      <div data-testid="type-filter">{typeFilter}</div>
      <button
        data-testid="update-search"
        onClick={() => setSearchQuery('test search')}
      >
        Update Search
      </button>
      <button
        data-testid="update-type"
        onClick={() => setTypeFilter('technical')}
      >
        Update Type
      </button>
    </div>
  );
}

function TestComponentWithoutProvider() {
  const hook = useKnowledgeFilter();
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
        page: 1,
        per_page: 100
      });

      const searchQuery = screen.getByTestId('search-query');
      const typeFilter = screen.getByTestId('type-filter');

      expect(searchQuery.textContent).toBe('');
      expect(typeFilter.textContent).toBe('all');
    });

    it('should update search query when setSearchQuery is called', async () => {
      const user = userEvent.setup();

      render(
        <KnowledgeFilterProvider>
          <TestComponent />
        </KnowledgeFilterProvider>
      );

      const updateButton = screen.getByTestId('update-search');

      await act(async () => {
        await user.click(updateButton);
      });

      const filterDisplay = screen.getByTestId('current-filter');
      const updatedFilter = JSON.parse(filterDisplay.textContent || '{}');
      const searchQuery = screen.getByTestId('search-query');

      expect(searchQuery.textContent).toBe('test search');
      expect(updatedFilter).toEqual({
        search: 'test search',
        page: 1,
        per_page: 100
      });
    });

    it('should update type filter when setTypeFilter is called', async () => {
      const user = userEvent.setup();

      render(
        <KnowledgeFilterProvider>
          <TestComponent />
        </KnowledgeFilterProvider>
      );

      const updateButton = screen.getByTestId('update-type');

      await act(async () => {
        await user.click(updateButton);
      });

      const filterDisplay = screen.getByTestId('current-filter');
      const updatedFilter = JSON.parse(filterDisplay.textContent || '{}');
      const typeFilter = screen.getByTestId('type-filter');

      expect(typeFilter.textContent).toBe('technical');
      expect(updatedFilter).toEqual({
        knowledge_type: 'technical',
        page: 1,
        per_page: 100
      });
    });

    it('should merge search and type updates correctly', async () => {
      const user = userEvent.setup();

      render(
        <KnowledgeFilterProvider>
          <TestComponent />
        </KnowledgeFilterProvider>
      );

      // Update search first
      await act(async () => {
        await user.click(screen.getByTestId('update-search'));
      });

      // Then update type
      await act(async () => {
        await user.click(screen.getByTestId('update-type'));
      });

      const filterDisplay = screen.getByTestId('current-filter');
      const finalFilter = JSON.parse(filterDisplay.textContent || '{}');

      expect(finalFilter).toEqual({
        search: 'test search',
        knowledge_type: 'technical',
        page: 1,
        per_page: 100
      });
    });
  });

  describe('useKnowledgeFilter', () => {
    it('should throw error when used outside provider', () => {
      // Suppress console.error for this test
      const originalError = console.error;
      console.error = () => {};

      expect(() => {
        render(<TestComponentWithoutProvider />);
      }).toThrow('useKnowledgeFilter must be used within a KnowledgeFilterProvider');

      console.error = originalError;
    });

    it('should maintain filter state across re-renders', async () => {
      let renderCount = 0;

      const TestRerenderComponent = () => {
        renderCount++;
        const { currentFilter, setSearchQuery } = useKnowledgeFilter();

        return (
          <div>
            <div data-testid="render-count">{renderCount}</div>
            <div data-testid="filter-state">{JSON.stringify(currentFilter)}</div>
            <button
              data-testid="trigger-update"
              onClick={() => setSearchQuery('persistent')}
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
      await act(async () => {
        await user.click(screen.getByTestId('trigger-update'));
      });

      const filterState = screen.getByTestId('filter-state');
      const currentFilter = JSON.parse(filterState.textContent || '{}');

      expect(currentFilter.search).toBe('persistent');
      expect(renderCount).toBeGreaterThan(1);
    });
  });
});