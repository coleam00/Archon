import React, { useEffect, useState, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import {
  X,
  Copy,
  Check,
  Code as CodeIcon,
  FileText,
  TagIcon,
  Info,
  Search,
  ChevronRight,
  FileCode,
} from 'lucide-react'
import Prism from 'prismjs'
import 'prismjs/components/prism-javascript'
import 'prismjs/components/prism-jsx'
import 'prismjs/components/prism-typescript'
import 'prismjs/components/prism-tsx'
import 'prismjs/components/prism-css'
import 'prismjs/components/prism-python'
import 'prismjs/components/prism-java'
import 'prismjs/components/prism-json'
import 'prismjs/components/prism-markdown'
import 'prismjs/components/prism-yaml'
import 'prismjs/components/prism-bash'
import 'prismjs/components/prism-sql'
import 'prismjs/components/prism-graphql'
import 'prismjs/themes/prism-tomorrow.css'
import { Button } from '../ui/Button'
import { Badge } from '../ui/Badge'
import { copyToClipboard } from '../../features/shared/utils/clipboard'

export interface CodeExample {
  id: string
  title: string
  description: string
  language: string
  code: string
  tags?: string[]
}

interface CodeViewerModalProps {
  examples: CodeExample[]
  onClose: () => void
  isLoading?: boolean
}

export const CodeViewerModal: React.FC<CodeViewerModalProps> = ({
  examples,
  onClose,
  isLoading = false,
}) => {
  const [activeTab, setActiveTab] = useState<'code' | 'metadata'>('code')
  const [activeExampleIndex, setActiveExampleIndex] = useState(0)
  const [copied, setCopied] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  // Filter examples based on search query
  const filteredExamples = useMemo(() => {
    if (!searchQuery.trim()) return examples

    const query = searchQuery.toLowerCase()
    return examples.filter((example) => {
      return (
        example.title.toLowerCase().includes(query) ||
        example.description.toLowerCase().includes(query) ||
        example.code.toLowerCase().includes(query) ||
        example.tags?.some((tag) => tag.toLowerCase().includes(query))
      )
    })
  }, [examples, searchQuery])

  const activeExample = filteredExamples[activeExampleIndex] || examples[0]

  // Handle escape key to close modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      // Arrow key navigation
      if (e.key === 'ArrowDown' && activeExampleIndex < filteredExamples.length - 1) {
        setActiveExampleIndex(activeExampleIndex + 1)
      }
      if (e.key === 'ArrowUp' && activeExampleIndex > 0) {
        setActiveExampleIndex(activeExampleIndex - 1)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, activeExampleIndex, filteredExamples.length])

  // Apply syntax highlighting
  useEffect(() => {
    if (activeExample) {
      Prism.highlightAll()
    }
  }, [activeExample, activeExampleIndex])

  // Reset active index when search changes
  useEffect(() => {
    setActiveExampleIndex(0)
  }, [searchQuery])

  const handleCopyCode = async () => {
    if (activeExample) {
      const result = await copyToClipboard(activeExample.code)
      if (result.success) {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      } else {
        console.error('Failed to copy to clipboard:', result.error)
      }
    }
  }

  // Using React Portal to render the modal at the root level
  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 flex items-center justify-center z-50 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        className="relative bg-gray-900/95 border border-gray-800 rounded-xl w-full max-w-7xl h-[85vh] flex overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Pink accent line at the top */}
        <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-pink-500 to-purple-500 shadow-[0_0_20px_5px_rgba(236,72,153,0.5)]"></div>
        
        {/* Sidebar */}
        <div className={`${sidebarCollapsed ? 'w-0' : 'w-80'} transition-all duration-300 bg-gray-950/50 border-r border-gray-800 flex flex-col overflow-hidden`}>
          {/* Sidebar Header */}
          <div className="p-4 border-b border-gray-800">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-pink-400">
                Code Examples ({filteredExamples.length})
              </h3>
              <button
                onClick={() => setSidebarCollapsed(true)}
                className="text-gray-500 hover:text-white p-1 rounded transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            
            {/* Search */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-500" />
              <input
                type="text"
                placeholder="Search examples..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-3 py-2 bg-gray-900/70 border border-gray-800 rounded-lg text-sm text-gray-300 placeholder-gray-600 focus:outline-none focus:border-pink-500/50 focus:ring-1 focus:ring-pink-500/20 transition-all"
              />
            </div>
          </div>
          
          {/* Example List */}
          <div className="flex-1 overflow-y-auto p-2">
            {filteredExamples.length === 0 ? (
              <div className="text-gray-500 text-sm text-center py-8">
                No examples found
              </div>
            ) : (
              filteredExamples.map((example, index) => (
                <button
                  key={example.id}
                  onClick={() => setActiveExampleIndex(index)}
                  className={`w-full text-left p-3 mb-1 rounded-lg transition-all duration-200 ${
                    index === activeExampleIndex
                      ? 'bg-pink-500/20 border border-pink-500/40 shadow-[0_0_15px_rgba(236,72,153,0.2)]'
                      : 'hover:bg-gray-800/50 border border-transparent'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <FileCode className={`w-4 h-4 mt-0.5 flex-shrink-0 ${
                      index === activeExampleIndex ? 'text-pink-400' : 'text-gray-500'
                    }`} />
                    <div className="flex-1 min-w-0">
                      <div className={`text-sm font-medium ${
                        index === activeExampleIndex ? 'text-pink-300' : 'text-gray-300'
                      } line-clamp-1`}>
                        {example.title}
                      </div>
                      <div className="text-xs text-gray-500 line-clamp-2 mt-0.5">
                        {example.description}
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge color="gray" variant="outline" className="text-xs">
                          {example.language}
                        </Badge>
                        {example.tags && example.tags.length > 0 && (
                          <span className="text-xs text-gray-600">
                            +{example.tags.length} tags
                          </span>
                        )}
                      </div>
                    </div>
                    {index === activeExampleIndex && (
                      <ChevronRight className="w-4 h-4 text-pink-400 flex-shrink-0" />
                    )}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
        
        {/* Sidebar Toggle Button */}
        {sidebarCollapsed && (
          <button
            onClick={() => setSidebarCollapsed(false)}
            className="absolute left-4 top-20 bg-gray-900/90 border border-gray-800 rounded-lg p-2 text-gray-400 hover:text-white hover:bg-gray-800/90 transition-all shadow-lg"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        )}
        
        {/* Main Content */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex justify-between items-center p-6 border-b border-gray-800">
            <div className="flex-1">
              <h2 className="text-2xl font-bold text-pink-400">
                {activeExample?.title || 'Code Example'}
              </h2>
              <p className="text-gray-400 mt-1 max-w-2xl line-clamp-2">
                {activeExample?.description || 'No description available'}
              </p>
            </div>
            <button
              onClick={onClose}
              className="text-gray-500 hover:text-white bg-gray-900/50 border border-gray-800 rounded-full p-2 transition-colors ml-4"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          
          {/* Toolbar */}
          <div className="flex justify-between items-center p-4 border-b border-gray-800">
            <div className="flex items-center gap-2">
              <Badge color="pink" variant="outline" className="text-xs">
                {activeExample?.language || 'unknown'}
              </Badge>
              {activeExample?.tags?.map((tag) => (
                <Badge
                  key={tag}
                  color="gray"
                  variant="outline"
                  className="flex items-center gap-1 text-xs"
                >
                  <TagIcon className="w-3 h-3" />
                  {tag}
                </Badge>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">
                {activeExampleIndex + 1} of {filteredExamples.length}
              </span>
              <Button
                variant="outline"
                accentColor="pink"
                size="sm"
                onClick={handleCopyCode}
              >
                {copied ? (
                  <>
                    <Check className="w-4 h-4 mr-2" />
                    <span>Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-4 h-4 mr-2" />
                    <span>Copy Code</span>
                  </>
                )}
              </Button>
            </div>
          </div>
          
          {/* Tabs */}
          <div className="flex border-b border-gray-800">
            <TabButton
              active={activeTab === 'code'}
              onClick={() => setActiveTab('code')}
              icon={<CodeIcon className="w-4 h-4" />}
              label="Code"
              color="pink"
            />
            <TabButton
              active={activeTab === 'metadata'}
              onClick={() => setActiveTab('metadata')}
              icon={<Info className="w-4 h-4" />}
              label="Metadata"
              color="pink"
            />
          </div>
          
          {/* Content */}
          <div className="flex-1 overflow-auto">
            {isLoading ? (
              <div className="h-full flex items-center justify-center">
                <div className="text-center">
                  <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-pink-400 mx-auto mb-4"></div>
                  <p className="text-gray-400">Loading code examples...</p>
                </div>
              </div>
            ) : !activeExample || examples.length === 0 ? (
              <div className="h-full flex items-center justify-center">
                <div className="text-center">
                  <CodeIcon className="w-12 h-12 text-gray-600 mx-auto mb-4" />
                  <p className="text-gray-400">No code examples available</p>
                </div>
              </div>
            ) : activeTab === 'code' && activeExample && (
              <div className="h-full p-4">
                <div className="bg-[#2d2d2d] rounded-lg border border-gray-800 h-full overflow-auto">
                  <pre className="p-4 text-sm">
                    <code
                      className={`language-${activeExample.language || 'javascript'}`}
                    >
                      {activeExample.code}
                    </code>
                  </pre>
                </div>
              </div>
            )}
            {activeTab === 'metadata' && activeExample && (
              <div className="h-full p-4">
                <div className="bg-gray-900/70 rounded-lg border border-gray-800 p-6 h-full overflow-auto">
                  <h3 className="text-lg font-medium text-pink-400 mb-4">
                    {activeExample.title} Metadata
                  </h3>
                  <p className="text-gray-300 mb-6">
                    {activeExample.description}
                  </p>
                  
                  <div className="space-y-6">
                    <div>
                      <h4 className="text-sm font-medium text-gray-400 mb-2">
                        Language
                      </h4>
                      <div className="flex items-center gap-2">
                        <Badge color="pink" variant="outline">
                          {activeExample.language}
                        </Badge>
                        <span className="text-sm text-gray-500">
                          Syntax highlighting for {activeExample.language}
                        </span>
                      </div>
                    </div>
                    
                    <div>
                      <h4 className="text-sm font-medium text-gray-400 mb-2">
                        Code Statistics
                      </h4>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="bg-gray-800/50 rounded-lg p-3">
                          <div className="text-2xl font-bold text-pink-400">
                            {activeExample.code.split('\n').length}
                          </div>
                          <div className="text-xs text-gray-500">Lines of code</div>
                        </div>
                        <div className="bg-gray-800/50 rounded-lg p-3">
                          <div className="text-2xl font-bold text-pink-400">
                            {activeExample.code.length}
                          </div>
                          <div className="text-xs text-gray-500">Characters</div>
                        </div>
                      </div>
                    </div>
                    
                    {activeExample.tags && activeExample.tags.length > 0 && (
                      <div>
                        <h4 className="text-sm font-medium text-gray-400 mb-2">
                          Tags
                        </h4>
                        <div className="flex flex-wrap gap-2">
                          {activeExample.tags.map((tag) => (
                            <Badge key={tag} color="pink" variant="outline">
                              {tag}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  )
}

interface TabButtonProps {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
  color: string
}

const TabButton: React.FC<TabButtonProps> = ({
  active,
  onClick,
  icon,
  label,
  color,
}) => {
  const colorMap: Record<string, string> = {
    green: 'text-green-400 border-green-500',
    blue: 'text-blue-400 border-blue-500',
    pink: 'text-pink-400 border-pink-500',
    purple: 'text-purple-400 border-purple-500',
  }
  
  const activeColor = colorMap[color] || 'text-pink-400 border-pink-500'
  
  return (
    <button
      onClick={onClick}
      className={`
        px-6 py-3 flex items-center gap-2 transition-all duration-300 relative
        ${active ? activeColor : 'text-gray-400 hover:text-gray-200 border-transparent'}
      `}
    >
      {icon}
      {label}
      {active && (
        <div className={`absolute bottom-0 left-0 right-0 h-0.5 ${color === 'pink' ? 'bg-pink-500' : 'bg-green-500'}`}></div>
      )}
    </button>
  )
}