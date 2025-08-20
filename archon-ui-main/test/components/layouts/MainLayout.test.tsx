import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, act } from '@testing-library/react';

/**
 * Test suite for MainLayout component, validating:
 * - Health check functionality
 * - Onboarding redirect logic
 * - Error handling
 * - Integration with database and credential services
 */

vi.mock('lucide-react', () => ({
  X: () => 'X',
}));

const mockNavigate = vi.fn();
const mockLocation = { pathname: '/' };

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useLocation: () => mockLocation,
}));

const mockShowToast = vi.fn();

vi.mock('../../../src/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}));

const mockRefreshSettings = vi.fn();

vi.mock('../../../src/contexts/SettingsContext', () => ({
  useSettings: () => ({
    refreshSettings: mockRefreshSettings,
    projectsEnabled: true,
    loading: false,
  }),
}));

vi.mock('../../../src/services/credentialsService', () => ({
  credentialsService: {
    baseUrl: 'http://localhost:8181',
    getCredentialsByCategory: vi.fn(),
  },
}));

vi.mock('../../../src/services/databaseService', () => ({
  databaseService: {
    getStatus: vi.fn(),
  },
}));

vi.mock('../../../src/utils/onboarding', () => ({
  isLmConfigured: vi.fn(),
}));

vi.mock('../../../src/components/layouts/SideNavigation', () => ({
  SideNavigation: () =>
    React.createElement(
      'div',
      { 'data-testid': 'side-navigation' },
      'SideNavigation'
    ),
}));

vi.mock('../../../src/components/layouts/ArchonChatPanel', () => ({
  ArchonChatPanel: () =>
    React.createElement(
      'div',
      { 'data-testid': 'archon-chat-panel' },
      'ArchonChatPanel'
    ),
}));

import { MainLayout } from '../../../src/components/layouts/MainLayout';
import { credentialsService } from '../../../src/services/credentialsService';
import { databaseService } from '../../../src/services/databaseService';
import { isLmConfigured } from '../../../src/utils/onboarding';

const mockDatabaseService = vi.mocked(databaseService);
const mockCredentialsService = vi.mocked(credentialsService);
const mockIsLmConfigured = vi.mocked(isLmConfigured);

describe('MainLayout Database Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    mockNavigate.mockClear();
    mockShowToast.mockClear();
    mockRefreshSettings.mockClear();
    mockLocation.pathname = '/';

    localStorage.getItem = vi.fn().mockReturnValue(null);
    localStorage.setItem = vi.fn();
    localStorage.removeItem = vi.fn();

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ready: true }),
    });

    vi.mocked(databaseService.getStatus).mockResolvedValue({
      setup_required: false,
      initialized: true,
      message: 'Database is configured',
    });

    vi.mocked(credentialsService.getCredentialsByCategory).mockResolvedValue([
      {
        key: 'OPENAI_API_KEY',
        value: 'test-key',
        is_encrypted: false,
        category: 'api_keys',
      },
    ]);

    vi.mocked(isLmConfigured).mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('Health Check Tests', () => {
    it('should skip health checks when on onboarding path', async () => {
      mockLocation.pathname = '/onboarding';

      render(<MainLayout>Test Content</MainLayout>);

      await act(async () => {
        vi.advanceTimersByTime(2000);
        await Promise.resolve();
      });

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should perform successful health check and set backend ready', async () => {
      mockLocation.pathname = '/dashboard';

      render(<MainLayout>Test Content</MainLayout>);

      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:8181/health',
        expect.objectContaining({
          method: 'GET',
        })
      );
    });

    it('should retry health check on failure with exponential backoff', async () => {
      global.fetch = vi
        .fn()
        .mockRejectedValueOnce(new Error('Connection failed'))
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ ready: true }),
        });

      mockLocation.pathname = '/dashboard';

      render(<MainLayout>Test Content</MainLayout>);

      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });

      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });

      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('Onboarding Redirect Tests', () => {
    it('should skip onboarding check when already on onboarding path', async () => {
      mockLocation.pathname = '/onboarding';

      render(<MainLayout>Test Content</MainLayout>);

      await act(async () => {
        vi.advanceTimersByTime(2000);
        await Promise.resolve();
      });

      expect(mockDatabaseService.getStatus).not.toHaveBeenCalled();
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('should skip onboarding when previously dismissed', async () => {
      localStorage.getItem = vi.fn().mockReturnValue('true');
      mockLocation.pathname = '/dashboard';

      render(<MainLayout>Test Content</MainLayout>);

      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersByTime(100);
        await Promise.resolve();
      });

      expect(localStorage.getItem).toHaveBeenCalledWith('onboardingDismissed');
      expect(mockDatabaseService.getStatus).toHaveBeenCalled();
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('should redirect to onboarding when database setup required', async () => {
      mockDatabaseService.getStatus.mockResolvedValue({
        setup_required: true,
        initialized: false,
        message: 'Database setup required',
      });

      mockLocation.pathname = '/dashboard';

      render(<MainLayout>Test Content</MainLayout>);

      await act(async () => {
        vi.advanceTimersByTime(2000);
        await Promise.resolve();
      });

      expect(mockDatabaseService.getStatus).toHaveBeenCalled();
      expect(mockNavigate).toHaveBeenCalledWith('/onboarding', {
        replace: true,
      });
    });

    it('should redirect when LM not configured', async () => {
      mockIsLmConfigured.mockReturnValue(false);
      mockLocation.pathname = '/dashboard';

      render(<MainLayout>Test Content</MainLayout>);

      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });

      await act(async () => {
        vi.advanceTimersByTime(100);
        await Promise.resolve();
      });

      expect(mockDatabaseService.getStatus).toHaveBeenCalled();
      expect(
        mockCredentialsService.getCredentialsByCategory
      ).toHaveBeenCalledWith('rag_strategy');
      expect(
        mockCredentialsService.getCredentialsByCategory
      ).toHaveBeenCalledWith('api_keys');
      expect(mockIsLmConfigured).toHaveBeenCalled();
      expect(mockNavigate).toHaveBeenCalledWith('/onboarding', {
        replace: true,
      });
    });
  });

  describe('Error Handling Tests', () => {
    it('should show toast and continue when database service fails', async () => {
      const error = new Error('Database connection failed');
      mockDatabaseService.getStatus.mockRejectedValue(error);

      mockLocation.pathname = '/dashboard';

      render(<MainLayout>Test Content</MainLayout>);

      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });

      await act(async () => {
        vi.advanceTimersByTime(100);
        await Promise.resolve();
      });
      expect(mockShowToast).toHaveBeenCalledWith(
        'Configuration check failed: Database connection failed. You can manually configure in Settings.',
        'warning'
      );

      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('should show toast when credentials service fails', async () => {
      const error = new Error('Failed to fetch credentials');
      mockCredentialsService.getCredentialsByCategory.mockRejectedValue(error);

      mockLocation.pathname = '/dashboard';

      render(<MainLayout>Test Content</MainLayout>);

      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });

      await act(async () => {
        vi.advanceTimersByTime(100);
        await Promise.resolve();
      });
      expect(mockShowToast).toHaveBeenCalledWith(
        'Configuration check failed: Failed to fetch credentials. You can manually configure in Settings.',
        'warning'
      );

      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('should handle network errors gracefully during health check', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: () => Promise.resolve({ ready: false, message: 'Network error' }),
      } as Response);

      mockLocation.pathname = '/dashboard';

      render(<MainLayout>Test Content</MainLayout>);

      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });

      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });

      expect(global.fetch).toHaveBeenCalled();
      expect(mockDatabaseService.getStatus).toHaveBeenCalled();
    });
  });

  describe('Integration Tests', () => {
    it('should complete full configuration check flow successfully', async () => {
      mockLocation.pathname = '/dashboard';

      render(<MainLayout>Test Content</MainLayout>);

      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });

      await act(async () => {
        vi.advanceTimersByTime(100);
        await Promise.resolve();
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:8181/health',
        expect.any(Object)
      );
      expect(mockDatabaseService.getStatus).toHaveBeenCalled();
      expect(
        mockCredentialsService.getCredentialsByCategory
      ).toHaveBeenCalledWith('rag_strategy');
      expect(
        mockCredentialsService.getCredentialsByCategory
      ).toHaveBeenCalledWith('api_keys');
      expect(mockIsLmConfigured).toHaveBeenCalled();
      expect(mockNavigate).not.toHaveBeenCalled();
    });
  });
});
