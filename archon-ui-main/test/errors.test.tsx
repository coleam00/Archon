import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, test, expect, vi } from 'vitest'
import React from 'react'
import { credentialsService } from '../src/services/credentialsService'

describe('Error Handling Tests', () => {
  test('api error simulation', () => {
    const MockApiComponent = () => {
      const [error, setError] = React.useState('')
      const [loading, setLoading] = React.useState(false)
      
      const fetchData = async () => {
        setLoading(true)
        try {
          // Simulate API error
          throw new Error('Network error')
        } catch (err) {
          setError('Failed to load data')
        } finally {
          setLoading(false)
        }
      }
      
      return (
        <div>
          <button onClick={fetchData}>Load Data</button>
          {loading && <div>Loading...</div>}
          {error && <div role="alert">{error}</div>}
        </div>
      )
    }
    
    render(<MockApiComponent />)
    
    fireEvent.click(screen.getByText('Load Data'))
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load data')
  })

  test('timeout error simulation', async () => {
    const MockTimeoutComponent = () => {
      const [status, setStatus] = React.useState('idle')
      
      const handleTimeout = () => {
        setStatus('loading')
        setTimeout(() => {
          setStatus('timeout')
        }, 100)
      }
      
      return (
        <div>
          <button onClick={handleTimeout}>Start Request</button>
          {status === 'loading' && <div>Loading...</div>}
          {status === 'timeout' && <div role="alert">Request timed out</div>}
        </div>
      )
    }
    
    render(<MockTimeoutComponent />)
    
    fireEvent.click(screen.getByText('Start Request'))
    expect(screen.getByText('Loading...')).toBeInTheDocument()
    
    const alert = await screen.findByRole('alert', {}, { timeout: 500 })
    expect(alert).toHaveTextContent('Request timed out')
  })

  test('form validation errors', () => {
    const MockFormErrors = () => {
      const [values, setValues] = React.useState({ name: '', email: '' })
      const [errors, setErrors] = React.useState<string[]>([])
      
      const validate = () => {
        const newErrors: string[] = []
        if (!values.name) newErrors.push('Name is required')
        if (!values.email) newErrors.push('Email is required')
        if (values.email && !values.email.includes('@')) {
          newErrors.push('Invalid email format')
        }
        setErrors(newErrors)
      }
      
      return (
        <div>
          <input
            placeholder="Name"
            value={values.name}
            onChange={(e) => setValues({ ...values, name: e.target.value })}
          />
          <input
            placeholder="Email"
            value={values.email}
            onChange={(e) => setValues({ ...values, email: e.target.value })}
          />
          <button onClick={validate}>Submit</button>
          {errors.length > 0 && (
            <div role="alert">
              {errors.map((error, index) => (
                <div key={index}>{error}</div>
              ))}
            </div>
          )}
        </div>
      )
    }
    
    render(<MockFormErrors />)
    
    // Submit empty form
    fireEvent.click(screen.getByText('Submit'))
    
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Name is required')
    expect(alert).toHaveTextContent('Email is required')
  })

  test('connection error recovery', () => {
    const MockConnection = () => {
      const [connected, setConnected] = React.useState(true)
      const [error, setError] = React.useState('')
      
      const handleDisconnect = () => {
        setConnected(false)
        setError('Connection lost')
      }
      
      const handleReconnect = () => {
        setConnected(true)
        setError('')
      }
      
      return (
        <div>
          <div>Status: {connected ? 'Connected' : 'Disconnected'}</div>
          {error && <div role="alert">{error}</div>}
          <button onClick={handleDisconnect}>Simulate Disconnect</button>
          <button onClick={handleReconnect}>Reconnect</button>
        </div>
      )
    }
    
    render(<MockConnection />)
    
    expect(screen.getByText('Status: Connected')).toBeInTheDocument()
    
    fireEvent.click(screen.getByText('Simulate Disconnect'))
    expect(screen.getByText('Status: Disconnected')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Connection lost')
    
    fireEvent.click(screen.getByText('Reconnect'))
    expect(screen.getByText('Status: Connected')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test('user friendly error messages', () => {
    const MockErrorMessages = () => {
      const [errorType, setErrorType] = React.useState('')
      
      const getErrorMessage = (type: string) => {
        switch (type) {
          case '401':
            return 'Please log in to continue'
          case '403':
            return "You don't have permission to access this"
          case '404':
            return "We couldn't find what you're looking for"
          case '500':
            return 'Something went wrong on our end'
          default:
            return ''
        }
      }
      
      return (
        <div>
          <button onClick={() => setErrorType('401')}>401 Error</button>
          <button onClick={() => setErrorType('403')}>403 Error</button>
          <button onClick={() => setErrorType('404')}>404 Error</button>
          <button onClick={() => setErrorType('500')}>500 Error</button>
          {errorType && (
            <div role="alert">{getErrorMessage(errorType)}</div>
          )}
        </div>
      )
    }
    
    render(<MockErrorMessages />)
    
    fireEvent.click(screen.getByText('401 Error'))
    expect(screen.getByRole('alert')).toHaveTextContent('Please log in to continue')
    
    fireEvent.click(screen.getByText('404 Error'))
    expect(screen.getByRole('alert')).toHaveTextContent("We couldn't find what you're looking for")
    
    fireEvent.click(screen.getByText('500 Error'))
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong on our end')
  })
})

describe('CredentialsService Error Handling', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    global.fetch = vi.fn() as any
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  test('should handle network errors with context', async () => {
    const mockError = new Error('Network request failed')
    ;(global.fetch as any).mockRejectedValueOnce(mockError)
    
    await expect(credentialsService.createCredential({
      key: 'TEST_KEY',
      value: 'test',
      is_encrypted: false,
      category: 'test'
    })).rejects.toThrow(/Network error while creating credential 'test_key'/)
  })

  test('should preserve context in error messages', async () => {
    const mockError = new Error('database error')
    ;(global.fetch as any).mockRejectedValueOnce(mockError)
    
    await expect(credentialsService.updateCredential({
      key: 'OPENAI_API_KEY',
      value: 'sk-test',
      is_encrypted: true,
      category: 'api_keys'
    })).rejects.toThrow(/Updating credential 'OPENAI_API_KEY' failed/)
  })
})