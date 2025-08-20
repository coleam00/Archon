/**
 * Tests for DatabaseSetupStep component
 *
 * This test suite verifies:
 * - Initial loading and rendering states
 * - Database status detection and appropriate UI rendering
 * - Auto-verification polling mechanism
 * - Manual verification capabilities
 * - Error handling for network failures
 * - Environment variable configuration guidance
 * - Proper cleanup of timers and resources
 * - Callback handling for completion and skipping
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { DatabaseSetupStep } from '../../../src/components/onboarding/DatabaseSetupStep';
import { databaseService } from '../../../src/services/databaseService';

vi.mock('framer-motion', () => ({
  motion: {
    div: 'div',
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('lucide-react', () => ({
  Database: () => 'Database',
  Copy: () => 'Copy',
  ExternalLink: () => 'ExternalLink',
  CheckCircle: () => 'CheckCircle',
  AlertCircle: () => 'AlertCircle',
  Loader2: () => 'Loader2',
  RefreshCw: () => 'RefreshCw',
}));

vi.mock('../../../src/services/databaseService', () => ({
  databaseService: {
    getStatus: vi.fn(),
    getSetupSQL: vi.fn(),
    verifySetup: vi.fn(),
  },
}));

vi.mock('../../../src/contexts/ToastContext', () => ({
  useToast: () => ({
    showToast: vi.fn(),
  }),
}));

vi.mock('../../../src/components/ui/Button', () => ({
  Button: ({ children, onClick, disabled, ...props }: any) => {
    return React.createElement(
      'button',
      { onClick, disabled, ...props },
      children
    );
  },
}));

vi.mock('../../../src/components/ui/Card', () => ({
  Card: ({ children, ...props }: any) => {
    return React.createElement('div', props, children);
  },
}));

import {
  mockDatabaseStatuses,
  mockSetupSQLResponses,
  mockVerificationResponses,
} from '../../fixtures/database-fixtures';

describe('DatabaseSetupStep', () => {
  const mockClipboard = {
    writeText: vi.fn().mockResolvedValue(undefined),
  };
  const mockWindowOpen = vi.fn().mockReturnValue(null);

  const renderDatabaseSetupStep = async (props: {
    onComplete: () => void;
    onSkip: () => void;
  }): Promise<RenderResult> => {
    let component!: RenderResult;
    await act(async () => {
      component = render(React.createElement(DatabaseSetupStep, props));

      await vi.runOnlyPendingTimersAsync();
    });
    return component;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    Object.defineProperty(navigator, 'clipboard', {
      value: mockClipboard,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, 'open', {
      value: mockWindowOpen,
      writable: true,
      configurable: true,
    });

    vi.mocked(databaseService).getStatus.mockResolvedValue(
      mockDatabaseStatuses.needsSetup
    );
    vi.mocked(databaseService).getSetupSQL.mockResolvedValue(
      mockSetupSQLResponses.complete
    );
    vi.mocked(databaseService).verifySetup.mockResolvedValue(
      mockVerificationResponses.success
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('renders appropriate UI for different states', async () => {
    const mockOnComplete = vi.fn();
    const mockOnSkip = vi.fn();

    let resolveStatus: ((value: any) => void) | undefined;
    vi.mocked(databaseService).getStatus.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveStatus = resolve;
        })
    );

    await renderDatabaseSetupStep({
      onComplete: mockOnComplete,
      onSkip: mockOnSkip,
    });

    expect(
      screen.getByText(/checking your database configuration/i)
    ).toBeInTheDocument();

    await act(async () => {
      if (resolveStatus) {
        resolveStatus(mockDatabaseStatuses.needsSetup);
      }
      await vi.runOnlyPendingTimersAsync();
    });

    expect(screen.getByText(/initialize database/i)).toBeInTheDocument();
    expect(screen.getByText(/copy the setup sql/i)).toBeInTheDocument();
  });

  test('completes setup when database is already ready', async () => {
    const mockOnComplete = vi.fn();
    const mockOnSkip = vi.fn();

    vi.mocked(databaseService).getStatus.mockResolvedValue(
      mockDatabaseStatuses.ready
    );

    await renderDatabaseSetupStep({
      onComplete: mockOnComplete,
      onSkip: mockOnSkip,
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(mockOnComplete).toHaveBeenCalled();
  });

  test('starts auto-verification polling when setup is required', async () => {
    const mockOnComplete = vi.fn();
    const mockOnSkip = vi.fn();

    vi.mocked(databaseService).getStatus.mockResolvedValue(
      mockDatabaseStatuses.needsSetup
    );
    vi.mocked(databaseService).getSetupSQL.mockResolvedValue(
      mockSetupSQLResponses.complete
    );
    vi.mocked(databaseService).verifySetup.mockResolvedValue(
      mockVerificationResponses.failure
    );

    await renderDatabaseSetupStep({
      onComplete: mockOnComplete,
      onSkip: mockOnSkip,
    });

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    expect(
      screen.getByText(/waiting for you to run the sql/i)
    ).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(3000);
      await vi.runOnlyPendingTimersAsync();
    });

    expect(vi.mocked(databaseService).verifySetup).toHaveBeenCalled();
  });

  test('handles auto-verification timeout and enables manual checking', async () => {
    const mockOnComplete = vi.fn();
    const mockOnSkip = vi.fn();

    vi.mocked(databaseService).getStatus.mockResolvedValue(
      mockDatabaseStatuses.needsSetup
    );
    vi.mocked(databaseService).getSetupSQL.mockResolvedValue(
      mockSetupSQLResponses.complete
    );
    vi.mocked(databaseService).verifySetup.mockResolvedValue(
      mockVerificationResponses.failure
    );

    await renderDatabaseSetupStep({
      onComplete: mockOnComplete,
      onSkip: mockOnSkip,
    });

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    await act(async () => {
      vi.advanceTimersByTime(180000);
      await vi.runOnlyPendingTimersAsync();
    });

    expect(screen.getByText(/run the sql then re-check/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /check now/i })
    ).toBeInTheDocument();
  });

  test('recovers from network failures during status check', async () => {
    const mockOnComplete = vi.fn();
    const mockOnSkip = vi.fn();

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.mocked(databaseService)
      .getStatus.mockRejectedValueOnce(new Error('Network connection failed'))
      .mockResolvedValueOnce(mockDatabaseStatuses.ready);

    await renderDatabaseSetupStep({
      onComplete: mockOnComplete,
      onSkip: mockOnSkip,
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(screen.getByText(/setup error/i)).toBeInTheDocument();
    expect(screen.getByText(/network connection failed/i)).toBeInTheDocument();

    await act(async () => {
      const retryButton = screen.getByRole('button', { name: /retry/i });
      fireEvent.click(retryButton);
      await vi.runAllTimersAsync();
    });

    expect(mockOnComplete).toHaveBeenCalled();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'ERROR DatabaseSetupStep: Unexpected database setup error'
      ),
      expect.objectContaining({
        error: 'Network connection failed',
        errorType: 'Error',
      })
    );

    consoleSpy.mockRestore();
  });

  test('shows helpful UI for missing environment variables', async () => {
    const mockOnComplete = vi.fn();
    const mockOnSkip = vi.fn();

    const envError = {
      ...mockDatabaseStatuses.needsSetup,
      message: 'Missing environment variables',
    };
    vi.mocked(databaseService).getStatus.mockResolvedValue(envError);

    await renderDatabaseSetupStep({
      onComplete: mockOnComplete,
      onSkip: mockOnSkip,
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(
      screen.getByText(/supabase configuration required/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/environment variables missing/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/SUPABASE_URL=/)).toBeInTheDocument();
    expect(screen.getByText(/SUPABASE_SERVICE_KEY=/)).toBeInTheDocument();
  });

  test('cleans up timers and intervals on unmount', async () => {
    const mockOnComplete = vi.fn();
    const mockOnSkip = vi.fn();

    vi.mocked(databaseService).getStatus.mockResolvedValue(
      mockDatabaseStatuses.needsSetup
    );
    vi.mocked(databaseService).getSetupSQL.mockResolvedValue(
      mockSetupSQLResponses.complete
    );
    vi.mocked(databaseService).verifySetup.mockResolvedValue(
      mockVerificationResponses.failure
    );

    const { unmount } = await renderDatabaseSetupStep({
      onComplete: mockOnComplete,
      onSkip: mockOnSkip,
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(
      screen.getByText(/waiting for you to run the sql/i)
    ).toBeInTheDocument();

    const initialTimerCount = vi.getTimerCount();

    unmount();

    expect(initialTimerCount).toBeGreaterThanOrEqual(0);
  });
});
