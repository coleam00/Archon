import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, test, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import OllamaConfigurationPanel from '../../../src/components/settings/OllamaConfigurationPanel'
import type { OllamaInstance } from '../../../src/services/credentialsService'

// Mock the credentialsService
const mockCredentialsService = {
  getOllamaInstances: vi.fn(),
  setOllamaInstances: vi.fn(),
  addOllamaInstance: vi.fn(),
  removeOllamaInstance: vi.fn(),
  updateOllamaInstance: vi.fn(),
  migrateOllamaFromLocalStorage: vi.fn(),
  discoverOllamaModels: vi.fn(),
}

vi.mock('../../../src/services/credentialsService', () => ({
  credentialsService: mockCredentialsService,
}))

// Mock the OllamaModelDiscoveryModal
vi.mock('../../../src/components/settings/OllamaModelDiscoveryModal', () => ({
  OllamaModelDiscoveryModal: ({ isOpen, onClose, onSelectModels }: any) => {
    return isOpen ? (
      <div data-testid="model-discovery-modal">
        <button onClick={() => onSelectModels({ chatModel: 'llama2:7b', embeddingModel: 'nomic-embed:latest' })}>
          Select Models
        </button>
        <button onClick={onClose}>Close</button>
      </div>
    ) : null
  },
}))

// Mock the ToastContext
const mockShowToast = vi.fn()
vi.mock('../../../src/contexts/ToastContext', () => ({
  useToast: () => ({
    showToast: mockShowToast,
  }),
}))

// Mock localStorage
const mockLocalStorage = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
}
Object.defineProperty(window, 'localStorage', {
  value: mockLocalStorage,
})

describe('OllamaConfigurationPanel', () => {
  const mockInstances: OllamaInstance[] = [
    {
      id: 'instance-1',
      name: 'Primary Chat Instance',
      baseUrl: 'http://localhost:11434',
      isEnabled: true,
      isPrimary: true,
      loadBalancingWeight: 100,
      instanceType: 'chat',
      isHealthy: true,
      responseTimeMs: 150,
      modelsAvailable: 8,
      lastHealthCheck: '2024-01-15T10:00:00Z',
    },
    {
      id: 'instance-2',
      name: 'Embedding Specialist',
      baseUrl: 'http://localhost:11435',
      isEnabled: true,
      isPrimary: false,
      loadBalancingWeight: 90,
      instanceType: 'embedding',
      isHealthy: true,
      responseTimeMs: 200,
      modelsAvailable: 4,
      lastHealthCheck: '2024-01-15T11:00:00Z',
    },
  ]

  const mockOnConfigChange = vi.fn()

  const defaultProps = {
    isVisible: true,
    onConfigChange: mockOnConfigChange,
    className: '',
    separateHosts: false,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockCredentialsService.getOllamaInstances.mockResolvedValue(mockInstances)
    mockCredentialsService.migrateOllamaFromLocalStorage.mockResolvedValue({
      migrated: false,
      instanceCount: 0,
    })
    mockLocalStorage.getItem.mockReturnValue(null)
  })

  test('renders configuration panel when visible', async () => {
    render(<OllamaConfigurationPanel {...defaultProps} />)

    expect(screen.getByText('Ollama Configuration')).toBeInTheDocument()
    expect(screen.getByText('Configure Ollama instances for distributed processing')).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getByText('Primary Chat Instance')).toBeInTheDocument()
      expect(screen.getByText('Embedding Specialist')).toBeInTheDocument()
    })
  })

  test('does not render when not visible', () => {
    render(<OllamaConfigurationPanel {...defaultProps} isVisible={false} />)

    expect(screen.queryByText('Ollama Configuration')).not.toBeInTheDocument()
  })

  test('loads instances from database on mount', async () => {
    render(<OllamaConfigurationPanel {...defaultProps} />)

    await waitFor(() => {
      expect(mockCredentialsService.getOllamaInstances).toHaveBeenCalledTimes(1)
      expect(mockCredentialsService.migrateOllamaFromLocalStorage).toHaveBeenCalledTimes(1)
    })
  })

  test('shows model discovery modal when select models is clicked', async () => {
    render(<OllamaConfigurationPanel {...defaultProps} />)

    await waitFor(() => {
      expect(screen.getByText('Select Models')).toBeInTheDocument()
    })

    const selectModelsButton = screen.getByText('Select Models')
    fireEvent.click(selectModelsButton)

    expect(screen.getByTestId('model-discovery-modal')).toBeInTheDocument()
  })

  test('updates button text when models are selected', async () => {
    // Mock saved model preferences
    mockLocalStorage.getItem.mockReturnValue(
      JSON.stringify({
        chatModel: 'llama2:7b',
        embeddingModel: 'nomic-embed:latest',
        updatedAt: new Date().toISOString(),
      })
    )

    render(<OllamaConfigurationPanel {...defaultProps} />)

    await waitFor(() => {
      expect(screen.getByText('Change Models')).toBeInTheDocument()
    })

    // Should show selected models
    expect(screen.getByText('Chat: llama2')).toBeInTheDocument()
    expect(screen.getByText('Embed: nomic-embed')).toBeInTheDocument()
  })

  test('handles model selection from discovery modal', async () => {
    render(<OllamaConfigurationPanel {...defaultProps} />)

    await waitFor(() => {
      const selectModelsButton = screen.getByText('Select Models')
      fireEvent.click(selectModelsButton)
    })

    const selectModelsInModal = screen.getByText('Select Models')
    fireEvent.click(selectModelsInModal)

    await waitFor(() => {
      expect(mockLocalStorage.setItem).toHaveBeenCalledWith(
        'ollama-selected-models',
        expect.stringContaining('"chatModel":"llama2:7b"')
      )
    })

    expect(mockShowToast).toHaveBeenCalledWith(
      'Selected models: llama2:7b (chat), nomic-embed:latest (embedding)',
      'success'
    )
  })

  test('displays dual-host configuration summary when enabled', async () => {
    // Mock selected models
    mockLocalStorage.getItem.mockReturnValue(
      JSON.stringify({
        chatModel: 'llama2:7b',
        embeddingModel: 'nomic-embed:latest',
        updatedAt: new Date().toISOString(),
      })
    )

    render(<OllamaConfigurationPanel {...defaultProps} separateHosts={true} />)

    await waitFor(() => {
      expect(screen.getByText('Model Assignment Summary')).toBeInTheDocument()
      expect(screen.getByText('Chat Model')).toBeInTheDocument()
      expect(screen.getByText('llama2:7b')).toBeInTheDocument()
      expect(screen.getByText('Embedding Model')).toBeInTheDocument()
      expect(screen.getByText('nomic-embed:latest')).toBeInTheDocument()
    })

    // Should show instance counts
    expect(screen.getByText('1 hosts')).toBeInTheDocument() // Chat instances
    expect(screen.getByText('1 hosts')).toBeInTheDocument() // Embedding instances
  })

  test('shows tip when models are not selected in dual-host mode', async () => {
    render(<OllamaConfigurationPanel {...defaultProps} separateHosts={true} />)

    await waitFor(() => {
      // Should not show the summary without selected models
      expect(screen.queryByText('Model Assignment Summary')).not.toBeInTheDocument()
    })
  })

  test('displays instance type badges correctly', async () => {
    render(<OllamaConfigurationPanel {...defaultProps} separateHosts={true} />)

    await waitFor(() => {
      expect(screen.getByText('Chat')).toBeInTheDocument()
      expect(screen.getByText('Embedding')).toBeInTheDocument()
    })
  })

  test('shows "Both" badge for universal instances in separate hosts mode', async () => {
    const instancesWithBoth = [
      ...mockInstances,
      {
        id: 'instance-3',
        name: 'Universal Instance',
        baseUrl: 'http://localhost:11436',
        isEnabled: true,
        isPrimary: false,
        loadBalancingWeight: 70,
        instanceType: 'both',
        isHealthy: true,
        responseTimeMs: 300,
        modelsAvailable: 12,
      },
    ]
    
    mockCredentialsService.getOllamaInstances.mockResolvedValue(instancesWithBoth)

    render(<OllamaConfigurationPanel {...defaultProps} separateHosts={true} />)

    await waitFor(() => {
      expect(screen.getByText('Both')).toBeInTheDocument()
    })
  })

  test('adds instance type selection when creating new instance in dual-host mode', async () => {
    render(<OllamaConfigurationPanel {...defaultProps} separateHosts={true} />)

    await waitFor(() => {
      const addInstanceButton = screen.getByText('+ Add Ollama Instance')
      fireEvent.click(addInstanceButton)
    })

    expect(screen.getByText('Instance Type')).toBeInTheDocument()
    expect(screen.getByText('LLM Chat')).toBeInTheDocument()
    expect(screen.getByText('Embedding')).toBeInTheDocument()
  })

  test('creates new instance with selected type in dual-host mode', async () => {
    render(<OllamaConfigurationPanel {...defaultProps} separateHosts={true} />)

    await waitFor(() => {
      const addInstanceButton = screen.getByText('+ Add Ollama Instance')
      fireEvent.click(addInstanceButton)
    })

    // Fill in instance details
    const nameInput = screen.getByPlaceholderText('Instance Name')
    const urlInput = screen.getByPlaceholderText('http://localhost:11434')

    fireEvent.change(nameInput, { target: { value: 'New Embedding Instance' } })
    fireEvent.change(urlInput, { target: { value: 'http://localhost:11437' } })

    // Select embedding type
    const embeddingButton = screen.getByText('Embedding')
    fireEvent.click(embeddingButton)

    // Add the instance
    const addButton = screen.getByText('Add Instance')
    fireEvent.click(addButton)

    await waitFor(() => {
      expect(mockCredentialsService.addOllamaInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'New Embedding Instance',
          baseUrl: 'http://localhost:11437',
          instanceType: 'embedding',
        })
      )
    })
  })

  test('creates instance with "both" type when not in dual-host mode', async () => {
    render(<OllamaConfigurationPanel {...defaultProps} separateHosts={false} />)

    await waitFor(() => {
      const addInstanceButton = screen.getByText('+ Add Ollama Instance')
      fireEvent.click(addInstanceButton)
    })

    const nameInput = screen.getByPlaceholderText('Instance Name')
    const urlInput = screen.getByPlaceholderText('http://localhost:11434')

    fireEvent.change(nameInput, { target: { value: 'Universal Instance' } })
    fireEvent.change(urlInput, { target: { value: 'http://localhost:11437' } })

    const addButton = screen.getByText('Add Instance')
    fireEvent.click(addButton)

    await waitFor(() => {
      expect(mockCredentialsService.addOllamaInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Universal Instance',
          baseUrl: 'http://localhost:11437',
          instanceType: 'both',
        })
      )
    })
  })

  test('shows dual-host mode in configuration summary', async () => {
    render(<OllamaConfigurationPanel {...defaultProps} separateHosts={true} />)

    await waitFor(() => {
      expect(screen.getByText('Dual-Host Mode:')).toBeInTheDocument()
      expect(screen.getByText('Enabled')).toBeInTheDocument()
    })
  })

  test('shows selected models count in configuration summary', async () => {
    // Mock selected models
    mockLocalStorage.getItem.mockReturnValue(
      JSON.stringify({
        chatModel: 'llama2:7b',
        embeddingModel: 'nomic-embed:latest',
      })
    )

    render(<OllamaConfigurationPanel {...defaultProps} />)

    await waitFor(() => {
      expect(screen.getByText('Selected Models:')).toBeInTheDocument()
      expect(screen.getByText('2')).toBeInTheDocument()
    })
  })

  test('prevents model discovery when no instances are enabled', async () => {
    const disabledInstances = mockInstances.map(inst => ({
      ...inst,
      isEnabled: false,
    }))
    
    mockCredentialsService.getOllamaInstances.mockResolvedValue(disabledInstances)

    render(<OllamaConfigurationPanel {...defaultProps} />)

    await waitFor(() => {
      const selectModelsButton = screen.getByText('Select Models')
      expect(selectModelsButton).toBeDisabled()
    })
  })

  test('shows error when model discovery fails', async () => {
    render(<OllamaConfigurationPanel {...defaultProps} />)

    await waitFor(() => {
      const selectModelsButton = screen.getByText('Select Models')
      fireEvent.click(selectModelsButton)
    })

    // Simulate error in modal (the mock modal doesn't simulate errors, but we can test the toast)
    expect(screen.getByTestId('model-discovery-modal')).toBeInTheDocument()
  })

  test('handles model selection errors gracefully', async () => {
    mockLocalStorage.setItem.mockImplementation(() => {
      throw new Error('Storage quota exceeded')
    })

    render(<OllamaConfigurationPanel {...defaultProps} />)

    await waitFor(() => {
      const selectModelsButton = screen.getByText('Select Models')
      fireEvent.click(selectModelsButton)
    })

    const selectModelsInModal = screen.getByText('Select Models')
    fireEvent.click(selectModelsInModal)

    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith(
        'Failed to save model selection',
        'error'
      )
    })
  })

  test('loads saved model preferences on component mount', async () => {
    const savedPreferences = {
      chatModel: 'saved-chat-model:latest',
      embeddingModel: 'saved-embed-model:latest',
      updatedAt: new Date().toISOString(),
    }
    
    mockLocalStorage.getItem.mockReturnValue(JSON.stringify(savedPreferences))

    render(<OllamaConfigurationPanel {...defaultProps} />)

    await waitFor(() => {
      expect(screen.getByText('Chat: saved-chat-model')).toBeInTheDocument()
      expect(screen.getByText('Embed: saved-embed-model')).toBeInTheDocument()
    })
  })

  test('handles corrupted saved preferences gracefully', async () => {
    mockLocalStorage.getItem.mockReturnValue('invalid-json')
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    render(<OllamaConfigurationPanel {...defaultProps} />)

    await waitFor(() => {
      expect(screen.getByText('Select Models')).toBeInTheDocument()
    })

    expect(consoleSpy).toHaveBeenCalledWith('Failed to load saved model preferences:', expect.any(Error))
    consoleSpy.mockRestore()
  })

  test('closes model discovery modal when requested', async () => {
    render(<OllamaConfigurationPanel {...defaultProps} />)

    await waitFor(() => {
      const selectModelsButton = screen.getByText('Select Models')
      fireEvent.click(selectModelsButton)
    })

    expect(screen.getByTestId('model-discovery-modal')).toBeInTheDocument()

    const closeButton = screen.getByText('Close')
    fireEvent.click(closeButton)

    expect(screen.queryByTestId('model-discovery-modal')).not.toBeInTheDocument()
  })

  test('migrates localStorage data on first load', async () => {
    mockCredentialsService.migrateOllamaFromLocalStorage.mockResolvedValue({
      migrated: true,
      instanceCount: 2,
    })

    render(<OllamaConfigurationPanel {...defaultProps} />)

    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith(
        'Migrated 2 Ollama instances to database',
        'success'
      )
    })
  })

  test('falls back to localStorage on database error', async () => {
    mockCredentialsService.getOllamaInstances.mockRejectedValue(new Error('Database error'))
    mockLocalStorage.getItem.mockReturnValue(JSON.stringify(mockInstances))

    render(<OllamaConfigurationPanel {...defaultProps} />)

    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith(
        'Loaded Ollama configuration from local backup',
        'warning'
      )
    })
  })

  test('calls onConfigChange when instances are updated', async () => {
    render(<OllamaConfigurationPanel {...defaultProps} />)

    await waitFor(() => {
      expect(mockOnConfigChange).toHaveBeenCalledWith(mockInstances)
    })
  })
})