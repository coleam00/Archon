import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, test, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { OllamaInstanceHealthIndicator } from '../../../src/components/settings/OllamaInstanceHealthIndicator'
import type { HealthIndicatorProps, OllamaInstance } from '../../../src/components/settings/types/OllamaTypes'

// Mock the ollamaService
vi.mock('../../../src/services/ollamaService', () => ({
  ollamaService: {
    testConnection: vi.fn(),
  },
}))

// Mock the ToastContext
const mockShowToast = vi.fn()
vi.mock('../../../src/contexts/ToastContext', () => ({
  useToast: () => ({
    showToast: mockShowToast,
  }),
}))

describe('OllamaInstanceHealthIndicator', () => {
  const mockHealthyInstance: OllamaInstance = {
    id: 'healthy-instance',
    name: 'Healthy Instance',
    baseUrl: 'http://localhost:11434',
    instanceType: 'chat',
    isEnabled: true,
    isPrimary: true,
    healthStatus: {
      isHealthy: true,
      lastChecked: new Date('2024-01-15T10:00:00Z'),
      responseTimeMs: 150,
    },
    loadBalancingWeight: 100,
    modelsAvailable: 8,
    responseTimeMs: 150,
  }

  const mockUnhealthyInstance: OllamaInstance = {
    id: 'unhealthy-instance',
    name: 'Unhealthy Instance',
    baseUrl: 'http://unreachable:11434',
    instanceType: 'embedding',
    isEnabled: true,
    isPrimary: false,
    healthStatus: {
      isHealthy: false,
      lastChecked: new Date('2024-01-15T09:30:00Z'),
      error: 'Connection timeout after 5 seconds',
    },
    loadBalancingWeight: 80,
    modelsAvailable: 0,
  }

  const mockOnRefresh = vi.fn()

  const defaultProps: HealthIndicatorProps = {
    instance: mockHealthyInstance,
    onRefresh: mockOnRefresh,
    showDetails: true,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    // Mock successful health check by default
    const { ollamaService } = require('../../../src/services/ollamaService')
    ollamaService.testConnection.mockResolvedValue({
      isHealthy: true,
      responseTime: 150,
    })
  })

  test('renders health indicator with healthy instance', () => {
    render(<OllamaInstanceHealthIndicator {...defaultProps} />)

    expect(screen.getByText('Healthy Instance')).toBeInTheDocument()
    expect(screen.getByText('localhost:11434')).toBeInTheDocument()
    expect(screen.getByText('Online')).toBeInTheDocument()
    expect(screen.getByText('150ms')).toBeInTheDocument()
    expect(screen.getByText('8')).toBeInTheDocument() // Models count
    expect(screen.getByText('Primary')).toBeInTheDocument()
  })

  test('renders health indicator with unhealthy instance', () => {
    render(
      <OllamaInstanceHealthIndicator
        {...defaultProps}
        instance={mockUnhealthyInstance}
      />
    )

    expect(screen.getByText('Unhealthy Instance')).toBeInTheDocument()
    expect(screen.getByText('unreachable:11434')).toBeInTheDocument()
    expect(screen.getByText('Offline')).toBeInTheDocument()
    expect(screen.getByText('Connection Error:')).toBeInTheDocument()
    expect(screen.getByText('Connection timeout after 5 seconds')).toBeInTheDocument()
    expect(screen.queryByText('Primary')).not.toBeInTheDocument()
  })

  test('renders compact mode correctly', () => {
    render(
      <OllamaInstanceHealthIndicator
        {...defaultProps}
        showDetails={false}
      />
    )

    // Should show only status badge and refresh button
    expect(screen.getByText('Online')).toBeInTheDocument()
    expect(screen.getByTitle('Refresh health status for Healthy Instance')).toBeInTheDocument()

    // Should not show detailed information
    expect(screen.queryByText('Response Time:')).not.toBeInTheDocument()
    expect(screen.queryByText('Models:')).not.toBeInTheDocument()
  })

  test('displays correct instance type icons', () => {
    const testCases = [
      { instanceType: 'chat', expectedIcon: '💬' },
      { instanceType: 'embedding', expectedIcon: '🔢' },
      { instanceType: 'both', expectedIcon: '🔄' },
    ]

    testCases.forEach(({ instanceType, expectedIcon }) => {
      const instance = {
        ...mockHealthyInstance,
        instanceType: instanceType as 'chat' | 'embedding' | 'both',
      }

      const { rerender } = render(
        <OllamaInstanceHealthIndicator
          instance={instance}
          onRefresh={mockOnRefresh}
          showDetails={true}
        />
      )

      expect(screen.getByText(expectedIcon)).toBeInTheDocument()
      
      // Clean up for next iteration
      rerender(<div />)
    })
  })

  test('displays instance type badges correctly', () => {
    // Test chat instance
    const chatInstance = { ...mockHealthyInstance, instanceType: 'chat' as const }
    const { rerender } = render(
      <OllamaInstanceHealthIndicator
        instance={chatInstance}
        onRefresh={mockOnRefresh}
        showDetails={true}
      />
    )
    expect(screen.getByText('chat')).toBeInTheDocument()

    // Test embedding instance
    const embeddingInstance = { ...mockHealthyInstance, instanceType: 'embedding' as const }
    rerender(
      <OllamaInstanceHealthIndicator
        instance={embeddingInstance}
        onRefresh={mockOnRefresh}
        showDetails={true}
      />
    )
    expect(screen.getByText('embedding')).toBeInTheDocument()

    // Test both instance - should not show specific badge
    const bothInstance = { ...mockHealthyInstance, instanceType: 'both' as const }
    rerender(
      <OllamaInstanceHealthIndicator
        instance={bothInstance}
        onRefresh={mockOnRefresh}
        showDetails={true}
      />
    )
    expect(screen.queryByText('both')).not.toBeInTheDocument()
    expect(screen.queryByText('chat')).not.toBeInTheDocument()
    expect(screen.queryByText('embedding')).not.toBeInTheDocument()
  })

  test('triggers health check refresh when refresh button is clicked', async () => {
    render(<OllamaInstanceHealthIndicator {...defaultProps} />)

    const refreshButton = screen.getByTitle('Refresh health status for Healthy Instance')
    fireEvent.click(refreshButton)

    // Should show loading state
    await waitFor(() => {
      expect(screen.getByText('Checking...')).toBeInTheDocument()
    })

    // Should call testConnection
    const { ollamaService } = require('../../../src/services/ollamaService')
    expect(ollamaService.testConnection).toHaveBeenCalledWith('http://localhost:11434')

    // Should call onRefresh callback
    await waitFor(() => {
      expect(mockOnRefresh).toHaveBeenCalledWith('healthy-instance')
    })

    // Should show success toast
    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith(
        'Health check successful for Healthy Instance (150ms)',
        'success'
      )
    })
  })

  test('handles refresh failure correctly', async () => {
    const { ollamaService } = require('../../../src/services/ollamaService')
    ollamaService.testConnection.mockResolvedValue({
      isHealthy: false,
      error: 'Connection refused',
    })

    render(<OllamaInstanceHealthIndicator {...defaultProps} />)

    const refreshButton = screen.getByTitle('Refresh health status for Healthy Instance')
    fireEvent.click(refreshButton)

    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith(
        'Health check failed for Healthy Instance: Connection refused',
        'error'
      )
    })
  })

  test('handles refresh exception correctly', async () => {
    const { ollamaService } = require('../../../src/services/ollamaService')
    ollamaService.testConnection.mockRejectedValue(new Error('Network error'))

    render(<OllamaInstanceHealthIndicator {...defaultProps} />)

    const refreshButton = screen.getByTitle('Refresh health status for Healthy Instance')
    fireEvent.click(refreshButton)

    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith(
        'Failed to check health for Healthy Instance: Network error',
        'error'
      )
    })
  })

  test('disables refresh button during refresh', async () => {
    // Mock a delayed response
    const { ollamaService } = require('../../../src/services/ollamaService')
    ollamaService.testConnection.mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve({ isHealthy: true }), 100))
    )

    render(<OllamaInstanceHealthIndicator {...defaultProps} />)

    const refreshButton = screen.getByTitle('Refresh health status for Healthy Instance')
    
    // Button should be enabled initially
    expect(refreshButton).not.toBeDisabled()
    
    fireEvent.click(refreshButton)

    // Button should be disabled during refresh
    await waitFor(() => {
      expect(refreshButton).toBeDisabled()
    })

    // Wait for refresh to complete
    await waitFor(() => {
      expect(refreshButton).not.toBeDisabled()
    }, { timeout: 200 })
  })

  test('formats response time colors correctly', () => {
    const testCases = [
      { responseTimeMs: 50, expectedClass: 'text-green-600' },
      { responseTimeMs: 300, expectedClass: 'text-yellow-600' },
      { responseTimeMs: 800, expectedClass: 'text-red-600' },
    ]

    testCases.forEach(({ responseTimeMs, expectedClass }) => {
      const instance = {
        ...mockHealthyInstance,
        healthStatus: {
          ...mockHealthyInstance.healthStatus,
          responseTimeMs,
        },
        responseTimeMs,
      }

      const { container, rerender } = render(
        <OllamaInstanceHealthIndicator
          instance={instance}
          onRefresh={mockOnRefresh}
          showDetails={true}
        />
      )

      const responseTimeElement = container.querySelector(`.${expectedClass}`)
      expect(responseTimeElement).toBeInTheDocument()
      expect(responseTimeElement).toHaveTextContent(`${responseTimeMs}ms`)

      // Clean up for next iteration
      rerender(<div />)
    })
  })

  test('formats last checked time correctly', () => {
    const testCases = [
      { 
        lastChecked: new Date(Date.now() - 30 * 1000), // 30 seconds ago
        expectedText: 'Just now'
      },
      { 
        lastChecked: new Date(Date.now() - 5 * 60 * 1000), // 5 minutes ago
        expectedText: '5m ago'
      },
      { 
        lastChecked: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
        expectedText: '2h ago'
      },
      { 
        lastChecked: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), // 3 days ago
        expectedText: '3d ago'
      },
    ]

    testCases.forEach(({ lastChecked, expectedText }) => {
      const instance = {
        ...mockHealthyInstance,
        healthStatus: {
          ...mockHealthyInstance.healthStatus,
          lastChecked,
        },
      }

      const { rerender } = render(
        <OllamaInstanceHealthIndicator
          instance={instance}
          onRefresh={mockOnRefresh}
          showDetails={true}
        />
      )

      expect(screen.getByText(`Last checked: ${expectedText}`)).toBeInTheDocument()

      // Clean up for next iteration
      rerender(<div />)
    })
  })

  test('shows load balancing weight when different from default', () => {
    const instance = {
      ...mockHealthyInstance,
      loadBalancingWeight: 75,
    }

    render(
      <OllamaInstanceHealthIndicator
        instance={instance}
        onRefresh={mockOnRefresh}
        showDetails={true}
      />
    )

    expect(screen.getByText('Load balancing weight: 75%')).toBeInTheDocument()
  })

  test('hides load balancing weight when default value', () => {
    const instance = {
      ...mockHealthyInstance,
      loadBalancingWeight: 100, // Default value
    }

    render(
      <OllamaInstanceHealthIndicator
        instance={instance}
        onRefresh={mockOnRefresh}
        showDetails={true}
      />
    )

    expect(screen.queryByText('Load balancing weight:')).not.toBeInTheDocument()
  })

  test('shows spinning refresh icon during refresh', async () => {
    render(<OllamaInstanceHealthIndicator {...defaultProps} />)

    const refreshButton = screen.getByTitle('Refresh health status for Healthy Instance')
    fireEvent.click(refreshButton)

    // Check for spinning animation class
    await waitFor(() => {
      const refreshIcon = refreshButton.querySelector('svg')
      expect(refreshIcon).toHaveClass('animate-spin')
    })
  })

  test('renders without optional properties', () => {
    const minimalInstance: OllamaInstance = {
      id: 'minimal-instance',
      name: 'Minimal Instance',
      baseUrl: 'http://localhost:11434',
      instanceType: 'chat',
      isEnabled: true,
      isPrimary: false,
      healthStatus: {
        isHealthy: true,
        lastChecked: new Date(),
      },
    }

    render(
      <OllamaInstanceHealthIndicator
        instance={minimalInstance}
        onRefresh={mockOnRefresh}
        showDetails={true}
      />
    )

    expect(screen.getByText('Minimal Instance')).toBeInTheDocument()
    expect(screen.getByText('Online')).toBeInTheDocument()
    // Should not show response time or models count when not available
    expect(screen.queryByText('Response Time:')).not.toBeInTheDocument()
    expect(screen.queryByText('Models:')).not.toBeInTheDocument()
  })

  test('handles undefined response time gracefully', () => {
    const instance = {
      ...mockHealthyInstance,
      healthStatus: {
        ...mockHealthyInstance.healthStatus,
        responseTimeMs: undefined,
      },
      responseTimeMs: undefined,
    }

    render(
      <OllamaInstanceHealthIndicator
        instance={instance}
        onRefresh={mockOnRefresh}
        showDetails={true}
      />
    )

    // Should still render without errors
    expect(screen.getByText('Healthy Instance')).toBeInTheDocument()
    expect(screen.queryByText('Response Time:')).not.toBeInTheDocument()
  })

  test('prevents multiple concurrent refresh operations', async () => {
    const { ollamaService } = require('../../../src/services/ollamaService')
    // Mock a slow response
    ollamaService.testConnection.mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve({ isHealthy: true }), 100))
    )

    render(<OllamaInstanceHealthIndicator {...defaultProps} />)

    const refreshButton = screen.getByTitle('Refresh health status for Healthy Instance')
    
    // Click refresh multiple times quickly
    fireEvent.click(refreshButton)
    fireEvent.click(refreshButton)
    fireEvent.click(refreshButton)

    // Should only call testConnection once
    await waitFor(() => {
      expect(ollamaService.testConnection).toHaveBeenCalledTimes(1)
    })
  })

  test('renders accessibility attributes correctly', () => {
    render(<OllamaInstanceHealthIndicator {...defaultProps} />)

    const refreshButton = screen.getByTitle('Refresh health status for Healthy Instance')
    expect(refreshButton).toHaveAttribute('title', 'Refresh health status for Healthy Instance')

    const instanceTypeIcon = screen.getByText('💬')
    expect(instanceTypeIcon).toHaveAttribute('title', 'Instance type: chat')
  })
})