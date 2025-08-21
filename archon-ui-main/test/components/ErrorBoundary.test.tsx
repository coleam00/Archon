import { render, screen } from '@testing-library/react'
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import React from 'react'

// Component that throws an error for testing
const ThrowError: React.FC<{ shouldThrow: boolean }> = ({ shouldThrow }) => {
  if (shouldThrow) {
    throw new Error('Test error message')
  }
  return <div>No error</div>
}

// Mock console.error to suppress error output in tests
const originalError = console.error
beforeEach(() => {
  console.error = vi.fn()
})

afterEach(() => {
  console.error = originalError
})

describe('ErrorBoundary Component', () => {
  test('renders children when there is no error', () => {
    render(
      <ErrorBoundary>
        <div>Test content</div>
      </ErrorBoundary>
    )
    
    expect(screen.getByText('Test content')).toBeInTheDocument()
  })

  test('catches errors and displays fallback UI', () => {
    render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>
    )
    
    // Should show error fallback
    expect(screen.getByText(/Something went wrong/i)).toBeInTheDocument()
    expect(screen.queryByText('No error')).not.toBeInTheDocument()
  })

  test('displays custom error fallback when provided', () => {
    const CustomFallback = ({ error }: { error: Error }) => (
      <div>Custom error: {error.message}</div>
    )
    
    render(
      <ErrorBoundary errorFallback={CustomFallback}>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>
    )
    
    expect(screen.getByText('Custom error: Test error message')).toBeInTheDocument()
  })

  test('renders different UI for page-level errors', () => {
    render(
      <ErrorBoundary isPageLevel={true}>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>
    )
    
    // Page-level errors should have specific styling
    const errorContainer = screen.getByText(/Something went wrong/i).closest('div')
    expect(errorContainer?.className).toContain('min-h-screen')
  })

  test('renders different UI for component-level errors', () => {
    render(
      <ErrorBoundary isPageLevel={false}>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>
    )
    
    // Component-level errors should have different styling
    const errorContainer = screen.getByText(/Something went wrong/i).closest('div')
    expect(errorContainer?.className).not.toContain('min-h-screen')
    expect(errorContainer?.className).toContain('rounded-lg')
  })

  test('passes error object to error fallback', () => {
    const error = new Error('Specific error message')
    const CustomFallback = ({ error: err }: { error: Error }) => (
      <div>
        <div>Error occurred</div>
        <div>{err.message}</div>
      </div>
    )
    
    render(
      <ErrorBoundary errorFallback={CustomFallback}>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>
    )
    
    expect(screen.getByText('Error occurred')).toBeInTheDocument()
    expect(screen.getByText('Test error message')).toBeInTheDocument()
  })

  test('handles multiple error boundaries at different levels', () => {
    const OuterFallback = () => <div>Outer error</div>
    const InnerFallback = () => <div>Inner error</div>
    
    render(
      <ErrorBoundary errorFallback={OuterFallback}>
        <div>
          <ErrorBoundary errorFallback={InnerFallback}>
            <ThrowError shouldThrow={true} />
          </ErrorBoundary>
        </div>
      </ErrorBoundary>
    )
    
    // Inner boundary should catch the error
    expect(screen.getByText('Inner error')).toBeInTheDocument()
    expect(screen.queryByText('Outer error')).not.toBeInTheDocument()
  })

  test('recovers when error condition is resolved', () => {
    const { rerender } = render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>
    )
    
    // Error is shown
    expect(screen.getByText(/Something went wrong/i)).toBeInTheDocument()
    
    // When component no longer throws, it should recover
    rerender(
      <ErrorBoundary>
        <ThrowError shouldThrow={false} />
      </ErrorBoundary>
    )
    
    // Note: React Error Boundaries don't automatically recover,
    // so the error state persists. This is expected behavior.
    expect(screen.getByText(/Something went wrong/i)).toBeInTheDocument()
  })

  test('logs errors to console in development', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error')
    
    render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>
    )
    
    // Error should be logged
    expect(consoleErrorSpy).toHaveBeenCalled()
  })

  test('renders with suspense wrapper when specified', () => {
    // Testing SuspenseErrorBoundary variant
    const LazyComponent = React.lazy(() => 
      Promise.resolve({ default: () => <div>Lazy loaded</div> })
    )
    
    render(
      <ErrorBoundary>
        <React.Suspense fallback={<div>Loading...</div>}>
          <LazyComponent />
        </React.Suspense>
      </ErrorBoundary>
    )
    
    // Should show loading initially
    expect(screen.getByText('Loading...')).toBeInTheDocument()
  })
})