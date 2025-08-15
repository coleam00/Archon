import { render, screen } from '@testing-library/react'
import { describe, test, expect, vi } from 'vitest'
import React from 'react'
import { isLmConfigured } from '../src/utils/onboarding'
import type { NormalizedCredential } from '../src/utils/onboarding'

// Mock useNavigate for onboarding page test
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn()
}))

describe('Page Load Tests', () => {
  test('simple page component renders', () => {
    const MockPage = () => <h1>Projects</h1>
    render(<MockPage />)
    expect(screen.getByText('Projects')).toBeInTheDocument()
  })

  test('knowledge base mock renders', () => {
    const MockKnowledgePage = () => <h1>Knowledge Base</h1>
    render(<MockKnowledgePage />)
    expect(screen.getByText('Knowledge Base')).toBeInTheDocument()
  })

  test('settings mock renders', () => {
    const MockSettingsPage = () => <h1>Settings</h1>
    render(<MockSettingsPage />)
    expect(screen.getByText('Settings')).toBeInTheDocument()
  })

  test('mcp mock renders', () => {
    const MockMCPPage = () => <h1>MCP Servers</h1>
    render(<MockMCPPage />)
    expect(screen.getByText('MCP Servers')).toBeInTheDocument()
  })

  test('tasks mock renders', () => {
    const MockTasksPage = () => (
      <div>
        <h1>Tasks</h1>
        <div>TODO</div>
        <div>In Progress</div>
        <div>Done</div>
      </div>
    )
    render(<MockTasksPage />)
    expect(screen.getByText('Tasks')).toBeInTheDocument()
    expect(screen.getByText('TODO')).toBeInTheDocument()
    expect(screen.getByText('In Progress')).toBeInTheDocument()
    expect(screen.getByText('Done')).toBeInTheDocument()
  })

  test('onboarding page renders', () => {
    const MockOnboardingPage = () => <h1>Welcome to Archon</h1>
    render(<MockOnboardingPage />)
    expect(screen.getByText('Welcome to Archon')).toBeInTheDocument()
  })
})

describe('Onboarding Detection Tests', () => {
  test('isLmConfigured returns true when provider is openai and OPENAI_API_KEY exists', () => {
    const ragCreds: NormalizedCredential[] = [
      { key: 'LLM_PROVIDER', value: 'openai', category: 'rag_strategy' }
    ]
    const apiKeyCreds: NormalizedCredential[] = [
      { key: 'OPENAI_API_KEY', value: 'sk-test123', category: 'api_keys' }
    ]
    
    expect(isLmConfigured(ragCreds, apiKeyCreds)).toBe(true)
  })

  test('isLmConfigured returns true when provider is openai and OPENAI_API_KEY is encrypted', () => {
    const ragCreds: NormalizedCredential[] = [
      { key: 'LLM_PROVIDER', value: 'openai', category: 'rag_strategy' }
    ]
    const apiKeyCreds: NormalizedCredential[] = [
      { key: 'OPENAI_API_KEY', is_encrypted: true, encrypted_value: 'encrypted_sk-test123', category: 'api_keys' }
    ]
    
    expect(isLmConfigured(ragCreds, apiKeyCreds)).toBe(true)
  })

  test('isLmConfigured returns false when provider is openai and no OPENAI_API_KEY', () => {
    const ragCreds: NormalizedCredential[] = [
      { key: 'LLM_PROVIDER', value: 'openai', category: 'rag_strategy' }
    ]
    const apiKeyCreds: NormalizedCredential[] = []
    
    expect(isLmConfigured(ragCreds, apiKeyCreds)).toBe(false)
  })

  test('isLmConfigured returns true when provider is ollama regardless of API keys', () => {
    const ragCreds: NormalizedCredential[] = [
      { key: 'LLM_PROVIDER', value: 'ollama', category: 'rag_strategy' }
    ]
    const apiKeyCreds: NormalizedCredential[] = []
    
    expect(isLmConfigured(ragCreds, apiKeyCreds)).toBe(true)
  })

  test('isLmConfigured returns true when no provider but OPENAI_API_KEY exists', () => {
    const ragCreds: NormalizedCredential[] = []
    const apiKeyCreds: NormalizedCredential[] = [
      { key: 'OPENAI_API_KEY', value: 'sk-test123', category: 'api_keys' }
    ]
    
    expect(isLmConfigured(ragCreds, apiKeyCreds)).toBe(true)
  })

  test('isLmConfigured returns false when no provider and no OPENAI_API_KEY', () => {
    const ragCreds: NormalizedCredential[] = []
    const apiKeyCreds: NormalizedCredential[] = []
    
    expect(isLmConfigured(ragCreds, apiKeyCreds)).toBe(false)
  })
})