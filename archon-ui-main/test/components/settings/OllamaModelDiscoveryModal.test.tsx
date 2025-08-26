import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, test, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { OllamaModelDiscoveryModal } from '../../../src/components/settings/OllamaModelDiscoveryModal'
import type { ModelDiscoveryModalProps, OllamaInstance } from '../../../src/components/settings/types/OllamaTypes'

// Mock the ollamaService
vi.mock('../../../src/services/ollamaService', () => ({
  ollamaService: {
    discoverModels: vi.fn(),
    testConnection: vi.fn(),
    getModelCapabilities: vi.fn(),
  },
}))

// Mock the ToastContext
const mockShowToast = vi.fn()
vi.mock('../../../src/contexts/ToastContext', () => ({
  useToast: () => ({
    showToast: mockShowToast,
  }),
}))

describe('OllamaModelDiscoveryModal', () => {
  const mockInstances: OllamaInstance[] = [
    {
      id: 'instance-1',
      name: 'Primary Chat Instance',
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
    },
    {
      id: 'instance-2',
      name: 'Embedding Specialist',
      baseUrl: 'http://localhost:11435',
      instanceType: 'embedding',
      isEnabled: true,
      isPrimary: false,
      healthStatus: {
        isHealthy: true,
        lastChecked: new Date('2024-01-15T11:00:00Z'),
        responseTimeMs: 200,
      },
      loadBalancingWeight: 90,
      modelsAvailable: 4,
    },
  ]

  const mockDiscoveredModels = {
    total_models: 3,
    chat_models: [
      {
        name: 'llama2:7b',
        instance_url: 'http://localhost:11434',
        size: 3825819519,
        parameters: { family: 'llama', parameter_size: '7B' },
      },
      {
        name: 'mistral:instruct',
        instance_url: 'http://localhost:11434',
        size: 4109364224,
        parameters: { family: 'mistral', parameter_size: '7B' },
      },
    ],
    embedding_models: [
      {
        name: 'nomic-embed-text:latest',
        instance_url: 'http://localhost:11435',
        dimensions: 768,
        size: 274301568,
      },
    ],
    host_status: {
      'http://localhost:11434': {
        status: 'online',
        models_count: 2,
      },
      'http://localhost:11435': {
        status: 'online', 
        models_count: 1,
      },
    },
    discovery_errors: [],
    unique_model_names: ['llama2', 'mistral', 'nomic-embed-text'],
  }

  const defaultProps: ModelDiscoveryModalProps = {
    isOpen: true,
    onClose: vi.fn(),
    onSelectModels: vi.fn(),
    instances: mockInstances,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    const { ollamaService } = require('../../../src/services/ollamaService')
    ollamaService.discoverModels.mockResolvedValue(mockDiscoveredModels)
  })

  test('renders modal when open', async () => {
    render(<OllamaModelDiscoveryModal {...defaultProps} />)
    
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Discover Ollama Models')).toBeInTheDocument()
    expect(screen.getByText('Select models from your enabled Ollama instances')).toBeInTheDocument()
  })

  test('does not render modal when closed', () => {
    render(<OllamaModelDiscoveryModal {...defaultProps} isOpen={false} />)
    
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  test('starts model discovery on mount', async () => {
    render(<OllamaModelDiscoveryModal {...defaultProps} />)
    
    // Should show loading state initially
    expect(screen.getByText('Discovering models...')).toBeInTheDocument()
    
    // Wait for discovery to complete
    await waitFor(() => {
      expect(screen.getByText('Discovery Results (3 models found)')).toBeInTheDocument()
    })

    const { ollamaService } = require('../../../src/services/ollamaService')
    expect(ollamaService.discoverModels).toHaveBeenCalledWith({
      instanceUrls: ['http://localhost:11434', 'http://localhost:11435'],
      includeCapabilities: true,
    })
  })

  test('displays discovered models correctly', async () => {
    render(<OllamaModelDiscoveryModal {...defaultProps} />)
    
    await waitFor(() => {
      expect(screen.getByText('Discovery Results (3 models found)')).toBeInTheDocument()
    })

    // Check chat models
    expect(screen.getByText('llama2:7b')).toBeInTheDocument()
    expect(screen.getByText('mistral:instruct')).toBeInTheDocument()
    
    // Check embedding model
    expect(screen.getByText('nomic-embed-text:latest')).toBeInTheDocument()
    expect(screen.getByText('768 dimensions')).toBeInTheDocument()
  })

  test('filters models by search query', async () => {
    render(<OllamaModelDiscoveryModal {...defaultProps} />)
    
    await waitFor(() => {
      expect(screen.getByText('Discovery Results (3 models found)')).toBeInTheDocument()
    })

    // Enter search query
    const searchInput = screen.getByPlaceholderText('Search models...')
    fireEvent.change(searchInput, { target: { value: 'llama' } })

    // Should only show llama model
    await waitFor(() => {
      expect(screen.getByText('llama2:7b')).toBeInTheDocument()
      expect(screen.queryByText('mistral:instruct')).not.toBeInTheDocument()
      expect(screen.queryByText('nomic-embed-text:latest')).not.toBeInTheDocument()
    })
  })

  test('filters models by type', async () => {
    render(<OllamaModelDiscoveryModal {...defaultProps} />)
    
    await waitFor(() => {
      expect(screen.getByText('Discovery Results (3 models found)')).toBeInTheDocument()
    })

    // Click "Embedding Only" filter
    const embeddingFilter = screen.getByText('Embedding Only')
    fireEvent.click(embeddingFilter)

    // Should only show embedding models
    await waitFor(() => {
      expect(screen.queryByText('llama2:7b')).not.toBeInTheDocument()
      expect(screen.queryByText('mistral:instruct')).not.toBeInTheDocument()
      expect(screen.getByText('nomic-embed-text:latest')).toBeInTheDocument()
    })
  })

  test('sorts models by different criteria', async () => {
    render(<OllamaModelDiscoveryModal {...defaultProps} />)
    
    await waitFor(() => {
      expect(screen.getByText('Discovery Results (3 models found)')).toBeInTheDocument()
    })

    // Change sort order to size
    const sortSelect = screen.getByDisplayValue('Name (A-Z)')
    fireEvent.change(sortSelect, { target: { value: 'size' } })

    // Models should be reordered (larger models first)
    await waitFor(() => {
      const modelCards = screen.getAllByTestId(/^model-card-/)
      const firstModel = within(modelCards[0]).getByRole('heading', { level: 3 })
      // mistral:instruct is larger (4109364224 bytes) than llama2:7b (3825819519 bytes)
      expect(firstModel).toHaveTextContent('mistral:instruct')
    })
  })

  test('selects and deselects models', async () => {
    render(<OllamaModelDiscoveryModal {...defaultProps} />)
    
    await waitFor(() => {
      expect(screen.getByText('Discovery Results (3 models found)')).toBeInTheDocument()
    })

    // Select a chat model
    const llamaCard = screen.getByTestId('model-card-llama2:7b')
    const selectChatButton = within(llamaCard).getByText('Select for Chat')
    fireEvent.click(selectChatButton)

    // Button should change to "Selected for Chat"
    await waitFor(() => {
      expect(within(llamaCard).getByText('Selected for Chat')).toBeInTheDocument()
    })

    // Select an embedding model
    const embedCard = screen.getByTestId('model-card-nomic-embed-text:latest')
    const selectEmbedButton = within(embedCard).getByText('Select for Embedding')
    fireEvent.click(selectEmbedButton)

    await waitFor(() => {
      expect(within(embedCard).getByText('Selected for Embedding')).toBeInTheDocument()
    })

    // Deselect chat model
    const deselectChatButton = within(llamaCard).getByText('Selected for Chat')
    fireEvent.click(deselectChatButton)

    await waitFor(() => {
      expect(within(llamaCard).getByText('Select for Chat')).toBeInTheDocument()
    })
  })

  test('tests model capabilities', async () => {
    const { ollamaService } = require('../../../src/services/ollamaService')
    ollamaService.getModelCapabilities.mockResolvedValue({
      supports_chat: true,
      supports_embedding: false,
      error: null,
    })

    render(<OllamaModelDiscoveryModal {...defaultProps} />)
    
    await waitFor(() => {
      expect(screen.getByText('Discovery Results (3 models found)')).toBeInTheDocument()
    })

    // Test model capabilities
    const llamaCard = screen.getByTestId('model-card-llama2:7b')
    const testButton = within(llamaCard).getByText('Test')
    fireEvent.click(testButton)

    await waitFor(() => {
      expect(ollamaService.getModelCapabilities).toHaveBeenCalledWith(
        'llama2:7b',
        'http://localhost:11434'
      )
    })

    // Should show success toast
    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith(
        'Model test successful: llama2:7b supports chat operations',
        'success'
      )
    })
  })

  test('handles model test failure', async () => {
    const { ollamaService } = require('../../../src/services/ollamaService')
    ollamaService.getModelCapabilities.mockResolvedValue({
      supports_chat: false,
      supports_embedding: false,
      error: 'Model not found',
    })

    render(<OllamaModelDiscoveryModal {...defaultProps} />)
    
    await waitFor(() => {
      expect(screen.getByText('Discovery Results (3 models found)')).toBeInTheDocument()
    })

    const llamaCard = screen.getByTestId('model-card-llama2:7b')
    const testButton = within(llamaCard).getByText('Test')
    fireEvent.click(testButton)

    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith(
        'Model test failed: Model not found',
        'error'
      )
    })
  })

  test('confirms selection and calls onSelectModels', async () => {
    const mockOnSelectModels = vi.fn()
    render(
      <OllamaModelDiscoveryModal
        {...defaultProps}
        onSelectModels={mockOnSelectModels}
      />
    )
    
    await waitFor(() => {
      expect(screen.getByText('Discovery Results (3 models found)')).toBeInTheDocument()
    })

    // Select models
    const llamaCard = screen.getByTestId('model-card-llama2:7b')
    fireEvent.click(within(llamaCard).getByText('Select for Chat'))

    const embedCard = screen.getByTestId('model-card-nomic-embed-text:latest')
    fireEvent.click(within(embedCard).getByText('Select for Embedding'))

    // Confirm selection
    const confirmButton = screen.getByText('Confirm Selection')
    fireEvent.click(confirmButton)

    expect(mockOnSelectModels).toHaveBeenCalledWith({
      chatModel: 'llama2:7b',
      embeddingModel: 'nomic-embed-text:latest',
    })
  })

  test('handles discovery errors gracefully', async () => {
    const { ollamaService } = require('../../../src/services/ollamaService')
    ollamaService.discoverModels.mockRejectedValue(new Error('Connection failed'))

    render(<OllamaModelDiscoveryModal {...defaultProps} />)

    await waitFor(() => {
      expect(screen.getByText('Model Discovery Failed')).toBeInTheDocument()
      expect(screen.getByText('Connection failed')).toBeInTheDocument()
    })

    // Should show retry button
    const retryButton = screen.getByText('Retry Discovery')
    expect(retryButton).toBeInTheDocument()

    // Clicking retry should attempt discovery again
    fireEvent.click(retryButton)
    expect(ollamaService.discoverModels).toHaveBeenCalledTimes(2)
  })

  test('shows partial results with discovery errors', async () => {
    const { ollamaService } = require('../../../src/services/ollamaService')
    const partialResults = {
      ...mockDiscoveredModels,
      discovery_errors: ['Failed to connect to http://localhost:11436'],
    }
    ollamaService.discoverModels.mockResolvedValue(partialResults)

    render(<OllamaModelDiscoveryModal {...defaultProps} />)

    await waitFor(() => {
      expect(screen.getByText('Discovery Results (3 models found)')).toBeInTheDocument()
    })

    // Should show error warning
    expect(screen.getByText('Some hosts had errors during discovery:')).toBeInTheDocument()
    expect(screen.getByText('Failed to connect to http://localhost:11436')).toBeInTheDocument()
  })

  test('displays instance health status', async () => {
    render(<OllamaModelDiscoveryModal {...defaultProps} />)

    await waitFor(() => {
      expect(screen.getByText('Discovery Results (3 models found)')).toBeInTheDocument()
    })

    // Check instance status indicators
    expect(screen.getByText('Primary Chat Instance')).toBeInTheDocument()
    expect(screen.getByText('Embedding Specialist')).toBeInTheDocument()
    
    // Should show healthy status indicators
    const healthyBadges = screen.getAllByText('Online')
    expect(healthyBadges).toHaveLength(2)
  })

  test('closes modal when cancel is clicked', () => {
    const mockOnClose = vi.fn()
    render(<OllamaModelDiscoveryModal {...defaultProps} onClose={mockOnClose} />)

    const cancelButton = screen.getByText('Cancel')
    fireEvent.click(cancelButton)

    expect(mockOnClose).toHaveBeenCalledTimes(1)
  })

  test('closes modal when X button is clicked', () => {
    const mockOnClose = vi.fn()
    render(<OllamaModelDiscoveryModal {...defaultProps} onClose={mockOnClose} />)

    const closeButton = screen.getByRole('button', { name: 'Close modal' })
    fireEvent.click(closeButton)

    expect(mockOnClose).toHaveBeenCalledTimes(1)
  })

  test('prevents selection confirmation without any models selected', async () => {
    render(<OllamaModelDiscoveryModal {...defaultProps} />)
    
    await waitFor(() => {
      expect(screen.getByText('Discovery Results (3 models found)')).toBeInTheDocument()
    })

    const confirmButton = screen.getByText('Confirm Selection')
    expect(confirmButton).toBeDisabled()
  })

  test('enables confirmation button when models are selected', async () => {
    render(<OllamaModelDiscoveryModal {...defaultProps} />)
    
    await waitFor(() => {
      expect(screen.getByText('Discovery Results (3 models found)')).toBeInTheDocument()
    })

    // Initially disabled
    const confirmButton = screen.getByText('Confirm Selection')
    expect(confirmButton).toBeDisabled()

    // Select a model
    const llamaCard = screen.getByTestId('model-card-llama2:7b')
    fireEvent.click(within(llamaCard).getByText('Select for Chat'))

    // Should now be enabled
    await waitFor(() => {
      expect(confirmButton).not.toBeDisabled()
    })
  })

  test('handles no instances provided', () => {
    render(<OllamaModelDiscoveryModal {...defaultProps} instances={[]} />)

    expect(screen.getByText('No Enabled Instances')).toBeInTheDocument()
    expect(screen.getByText('No enabled Ollama instances found. Please configure and enable at least one instance.')).toBeInTheDocument()
  })

  test('shows model size in human-readable format', async () => {
    render(<OllamaModelDiscoveryModal {...defaultProps} />)
    
    await waitFor(() => {
      expect(screen.getByText('Discovery Results (3 models found)')).toBeInTheDocument()
    })

    // Should show sizes in GB format
    expect(screen.getByText('3.8 GB')).toBeInTheDocument() // llama2:7b
    expect(screen.getByText('3.9 GB')).toBeInTheDocument() // mistral:instruct  
    expect(screen.getByText('274 MB')).toBeInTheDocument() // nomic-embed-text
  })

  test('displays model parameters information', async () => {
    render(<OllamaModelDiscoveryModal {...defaultProps} />)
    
    await waitFor(() => {
      expect(screen.getByText('Discovery Results (3 models found)')).toBeInTheDocument()
    })

    // Should show parameter information
    expect(screen.getByText('7B parameters')).toBeInTheDocument() // For both llama and mistral
  })

  test('handles keyboard navigation', async () => {
    render(<OllamaModelDiscoveryModal {...defaultProps} />)
    
    await waitFor(() => {
      expect(screen.getByText('Discovery Results (3 models found)')).toBeInTheDocument()
    })

    const modal = screen.getByRole('dialog')
    
    // Should be able to focus elements within modal
    const searchInput = screen.getByPlaceholderText('Search models...')
    expect(searchInput).toBeInTheDocument()
    
    // Escape key should close modal
    fireEvent.keyDown(modal, { key: 'Escape', code: 'Escape' })
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1)
  })
})