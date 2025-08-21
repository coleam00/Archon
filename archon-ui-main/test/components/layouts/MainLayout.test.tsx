import { render, screen } from '@testing-library/react'
import { describe, test, expect, vi } from 'vitest'
import { MainLayout } from '@/components/layouts/MainLayout'
import { BrowserRouter } from 'react-router-dom'

// Mock the child components
vi.mock('@/components/layouts/SideNavigation', () => ({
  SideNavigation: () => <nav data-testid="side-navigation">Side Navigation</nav>
}))

vi.mock('@/components/DisconnectScreenOverlay', () => ({
  DisconnectScreenOverlay: () => null // Usually hidden
}))

// Mock contexts
vi.mock('@/contexts/SettingsContext', () => ({
  useSettings: () => ({
    settings: {
      enableProjects: true,
      theme: 'dark'
    },
    updateSettings: vi.fn()
  })
}))

describe('MainLayout Component', () => {
  const renderWithRouter = (children: React.ReactNode) => {
    return render(
      <BrowserRouter>
        {children}
      </BrowserRouter>
    )
  }

  test('renders children correctly', () => {
    renderWithRouter(
      <MainLayout>
        <div>Page content</div>
      </MainLayout>
    )
    
    expect(screen.getByText('Page content')).toBeInTheDocument()
  })

  test('renders side navigation', () => {
    renderWithRouter(
      <MainLayout>
        <div>Content</div>
      </MainLayout>
    )
    
    expect(screen.getByTestId('side-navigation')).toBeInTheDocument()
  })

  test('applies layout structure classes', () => {
    const { container } = renderWithRouter(
      <MainLayout>
        <div>Content</div>
      </MainLayout>
    )
    
    // Check for flex layout
    const layoutContainer = container.querySelector('.flex')
    expect(layoutContainer).toBeInTheDocument()
    
    // Check for main content area
    const mainContent = container.querySelector('main')
    expect(mainContent).toBeInTheDocument()
    expect(mainContent?.className).toContain('flex-1')
  })

  test('renders multiple children', () => {
    renderWithRouter(
      <MainLayout>
        <div>First child</div>
        <div>Second child</div>
        <section>Third child</section>
      </MainLayout>
    )
    
    expect(screen.getByText('First child')).toBeInTheDocument()
    expect(screen.getByText('Second child')).toBeInTheDocument()
    expect(screen.getByText('Third child')).toBeInTheDocument()
  })

  test('maintains responsive layout', () => {
    const { container } = renderWithRouter(
      <MainLayout>
        <div>Responsive content</div>
      </MainLayout>
    )
    
    const mainContent = container.querySelector('main')
    expect(mainContent?.className).toContain('overflow-x-hidden')
    expect(mainContent?.className).toContain('overflow-y-auto')
  })

  test('applies dark mode background classes', () => {
    const { container } = renderWithRouter(
      <MainLayout>
        <div>Dark mode content</div>
      </MainLayout>
    )
    
    const layoutContainer = container.firstChild as HTMLElement
    expect(layoutContainer.className).toContain('bg-gray-50')
    expect(layoutContainer.className).toContain('dark:bg-black')
  })

  test('renders empty children gracefully', () => {
    const { container } = renderWithRouter(
      <MainLayout>
        {null}
        {undefined}
        {false}
      </MainLayout>
    )
    
    // Should still render the layout structure
    expect(container.querySelector('.flex')).toBeInTheDocument()
    expect(screen.getByTestId('side-navigation')).toBeInTheDocument()
  })

  test('handles complex nested components', () => {
    renderWithRouter(
      <MainLayout>
        <div className="page-container">
          <header>
            <h1>Page Title</h1>
          </header>
          <section>
            <article>
              <p>Article content</p>
            </article>
          </section>
        </div>
      </MainLayout>
    )
    
    expect(screen.getByText('Page Title')).toBeInTheDocument()
    expect(screen.getByText('Article content')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument()
  })

  test('preserves child component props', () => {
    renderWithRouter(
      <MainLayout>
        <div 
          id="test-id" 
          className="custom-class"
          data-testid="custom-content"
        >
          Custom content
        </div>
      </MainLayout>
    )
    
    const customDiv = screen.getByTestId('custom-content')
    expect(customDiv).toHaveAttribute('id', 'test-id')
    expect(customDiv).toHaveClass('custom-class')
    expect(customDiv).toHaveTextContent('Custom content')
  })
})