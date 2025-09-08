import { expect, afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Set required environment variables for tests
process.env.ARCHON_SERVER_PORT = '8181'

// Mock import.meta.env for tests
Object.defineProperty(import.meta, 'env', {
  value: {
    DEV: true,
    PROD: false,
    VITE_HOST: 'localhost',
    VITE_PORT: '8181',
    VITE_ALLOWED_HOSTS: '',
  },
  configurable: true,
})

// Clean up after each test
afterEach(() => {
  cleanup()
})

// Simple mocks only - fetch
global.fetch = vi.fn(() =>
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
    status: 200,
    headers: new Headers(),
  } as Response)
) as any

// Mock localStorage
const localStorageMock = {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
}
Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
})

// Mock DOM methods that might not exist in test environment
Element.prototype.scrollIntoView = vi.fn()
window.HTMLElement.prototype.scrollIntoView = vi.fn()

// Mock lucide-react icons - simple implementation
vi.mock('lucide-react', () => ({
  Trash2: () => 'Trash2',
  X: () => 'X',
  AlertCircle: () => 'AlertCircle',
  Loader2: () => 'Loader2',
  BookOpen: () => 'BookOpen',
  Settings: () => 'Settings',
  WifiOff: () => 'WifiOff',
  ChevronDown: () => 'ChevronDown',
  ChevronRight: () => 'ChevronRight',
  Plus: () => 'Plus',
  Search: () => 'Search',
  Activity: () => 'Activity',
  CheckCircle2: () => 'CheckCircle2',
  ListTodo: () => 'ListTodo',
  MoreHorizontal: () => 'MoreHorizontal',
  Pin: () => 'Pin',
  PinOff: () => 'PinOff',
  Clipboard: () => 'Clipboard',
  // Add more icons as needed
}))

// Mock ResizeObserver
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}))