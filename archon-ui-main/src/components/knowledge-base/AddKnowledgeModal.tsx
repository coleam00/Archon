import { useState } from 'react';
import { 
  LinkIcon, 
  Upload, 
  BoxIcon, 
  Brain,
  Plus
} from 'lucide-react';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Badge } from '../ui/Badge';
import { GlassCrawlDepthSelector } from '../ui/GlassCrawlDepthSelector';
import { useToast } from '../../contexts/ToastContext';
import { knowledgeBaseService } from '../../services/knowledgeBaseService';
import { CrawlProgressData } from '../../types/crawl';

interface AddKnowledgeModalProps {
  onClose: () => void;
  onSuccess: () => void;
  onStartCrawl: (progressId: string, initialData: Partial<CrawlProgressData>) => void;
}

export const AddKnowledgeModal = ({
  onClose,
  onSuccess,
  onStartCrawl
}: AddKnowledgeModalProps) => {
  const [method, setMethod] = useState<'url' | 'file'>('url');
  const [url, setUrl] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [newTag, setNewTag] = useState('');
  const [knowledgeType, setKnowledgeType] = useState<'technical' | 'business'>('technical');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [crawlDepth, setCrawlDepth] = useState(2);
  const [showDepthTooltip, setShowDepthTooltip] = useState(false);
  const { showToast } = useToast();

  // URL validation function
  const validateUrl = async (url: string): Promise<{ isValid: boolean; error?: string; formattedUrl?: string }> => {
    try {
      let formattedUrl = url.trim();
      if (!formattedUrl.startsWith('http://') && !formattedUrl.startsWith('https://')) {
        formattedUrl = `https://${formattedUrl}`;
      }
      
      let urlObj;
      try {
        urlObj = new URL(formattedUrl);
      } catch {
        return { isValid: false, error: 'Please enter a valid URL format' };
      }
      
      const hostname = urlObj.hostname;
      if (!hostname || hostname === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
        return { isValid: true, formattedUrl };
      }
      
      if (!hostname.includes('.')) {
        return { isValid: false, error: 'Please enter a valid domain name' };
      }
      
      const parts = hostname.split('.');
      const tld = parts[parts.length - 1];
      if (tld.length < 2) {
        return { isValid: false, error: 'Please enter a valid domain with a proper extension' };
      }
      
      // Optional DNS check
      try {
        const response = await fetch(`https://dns.google/resolve?name=${hostname}&type=A`, {
          method: 'GET',
          headers: { 'Accept': 'application/json' }
        });
        
        if (response.ok) {
          const dnsResult = await response.json();
          if (dnsResult.Status === 0 && dnsResult.Answer?.length > 0) {
            return { isValid: true, formattedUrl };
          } else {
            return { isValid: false, error: `Domain "${hostname}" could not be resolved` };
          }
        }
      } catch {
        // Allow URL even if DNS check fails
        console.warn('DNS check failed, allowing URL anyway');
      }
      
      return { isValid: true, formattedUrl };
    } catch {
      return { isValid: false, error: 'URL validation failed' };
    }
  };

  const handleSubmit = async () => {
    try {
      setLoading(true);
      
      if (method === 'url') {
        if (!url.trim()) {
          showToast('Please enter a URL', 'error');
          return;
        }
        
        showToast('Validating URL...', 'info');
        const validation = await validateUrl(url);
        
        if (!validation.isValid) {
          showToast(validation.error || 'Invalid URL', 'error');
          return;
        }
        
        const formattedUrl = validation.formattedUrl!;
        setUrl(formattedUrl);
        
        // Detect crawl type based on URL
        const crawlType = detectCrawlType(formattedUrl);
        
        const result = await knowledgeBaseService.crawlUrl({
          url: formattedUrl,
          knowledge_type: knowledgeType,
          tags,
          max_depth: crawlDepth
        });
        
        if ((result as any).progressId) {
          onStartCrawl((result as any).progressId, {
            status: 'initializing',
            progress: 0,
            currentStep: 'Starting crawl',
            crawlType,
            currentUrl: formattedUrl,
            originalCrawlParams: {
              url: formattedUrl,
              knowledge_type: knowledgeType,
              tags,
              max_depth: crawlDepth
            }
          });
          
          showToast(`Starting ${crawlType} crawl...`, 'success');
          onClose();
        } else {
          showToast((result as any).message || 'Crawling started', 'success');
          onSuccess();
        }
      } else {
        if (!selectedFile) {
          showToast('Please select a file', 'error');
          return;
        }
        
        const result = await knowledgeBaseService.uploadDocument(selectedFile, {
          knowledge_type: knowledgeType,
          tags
        });
        
        if (result.success && result.progressId) {
          onStartCrawl(result.progressId, {
            currentUrl: `file://${selectedFile.name}`,
            progress: 0,
            status: 'starting',
            uploadType: 'document',
            fileName: selectedFile.name,
            fileType: selectedFile.type,
            originalUploadParams: {
              file: selectedFile,
              knowledge_type: knowledgeType,
              tags
            }
          });
          
          showToast('Document upload started', 'success');
          onClose();
        } else {
          showToast(result.message || 'Document uploaded', 'success');
          onSuccess();
        }
      }
    } catch (error) {
      console.error('Failed to add knowledge:', error);
      showToast('Failed to add knowledge source', 'error');
    } finally {
      setLoading(false);
    }
  };

  // Helper to detect crawl type
  const detectCrawlType = (url: string): 'sitemap' | 'llms-txt' | 'normal' => {
    if (url.includes('sitemap.xml')) return 'sitemap';
    if (url.includes('llms') && url.endsWith('.txt')) return 'llms-txt';
    return 'normal';
  };

  return (
    <div className="fixed inset-0 bg-gray-500/50 dark:bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <Card className="w-full max-w-2xl relative before:content-[''] before:absolute before:top-0 before:left-0 before:w-full before:h-[1px] before:bg-green-500 p-8">
        <h2 className="text-xl font-bold text-gray-800 dark:text-white mb-8">
          Add Knowledge Source
        </h2>

        {/* Knowledge Type Selection */}
        <div className="mb-6">
          <label className="block text-gray-600 dark:text-zinc-400 text-sm mb-2">
            Knowledge Type
          </label>
          <div className="flex gap-4">
            <label className={`
              flex-1 p-4 rounded-md border cursor-pointer transition flex items-center justify-center gap-2
              ${knowledgeType === 'technical' 
                ? 'border-blue-500 text-blue-600 dark:text-blue-500 bg-blue-50 dark:bg-blue-500/5' 
                : 'border-gray-200 dark:border-zinc-900 text-gray-500 dark:text-zinc-400 hover:border-blue-300 dark:hover:border-blue-500/30'}
            `}>
              <input 
                type="radio" 
                name="knowledgeType" 
                value="technical" 
                checked={knowledgeType === 'technical'} 
                onChange={() => setKnowledgeType('technical')} 
                className="sr-only" 
              />
              <BoxIcon className="w-5 h-5" />
              <span>Technical/Coding</span>
            </label>
            <label className={`
              flex-1 p-4 rounded-md border cursor-pointer transition flex items-center justify-center gap-2
              ${knowledgeType === 'business' 
                ? 'border-purple-500 text-purple-600 dark:text-purple-500 bg-purple-50 dark:bg-purple-500/5' 
                : 'border-gray-200 dark:border-zinc-900 text-gray-500 dark:text-zinc-400 hover:border-purple-300 dark:hover:border-purple-500/30'}
            `}>
              <input 
                type="radio" 
                name="knowledgeType" 
                value="business" 
                checked={knowledgeType === 'business'} 
                onChange={() => setKnowledgeType('business')} 
                className="sr-only" 
              />
              <Brain className="w-5 h-5" />
              <span>Business/Project</span>
            </label>
          </div>
        </div>

        {/* Source Type Selection */}
        <div className="flex gap-4 mb-6">
          <button 
            onClick={() => setMethod('url')} 
            className={`flex-1 p-4 rounded-md border transition flex items-center justify-center gap-2
              ${method === 'url' 
                ? 'border-blue-500 text-blue-600 dark:text-blue-500 bg-blue-50 dark:bg-blue-500/5' 
                : 'border-gray-200 dark:border-zinc-900 text-gray-500 dark:text-zinc-400 hover:border-blue-300 dark:hover:border-blue-500/30'}`}
          >
            <LinkIcon className="w-4 h-4" />
            <span>URL / Website</span>
          </button>
          <button 
            onClick={() => setMethod('file')} 
            className={`flex-1 p-4 rounded-md border transition flex items-center justify-center gap-2
              ${method === 'file' 
                ? 'border-pink-500 text-pink-600 dark:text-pink-500 bg-pink-50 dark:bg-pink-500/5' 
                : 'border-gray-200 dark:border-zinc-900 text-gray-500 dark:text-zinc-400 hover:border-pink-300 dark:hover:border-pink-500/30'}`}
          >
            <Upload className="w-4 h-4" />
            <span>Upload File</span>
          </button>
        </div>

        {/* URL Input */}
        {method === 'url' && (
          <div className="mb-6">
            <Input 
              label="URL to Scrape" 
              type="url" 
              value={url} 
              onChange={(e) => setUrl(e.target.value)} 
              placeholder="https://example.com or example.com" 
              accentColor="blue" 
            />
            {url && !url.startsWith('http://') && !url.startsWith('https://') && (
              <p className="text-amber-600 dark:text-amber-400 text-sm mt-1">
                ℹ️ Will automatically add https:// prefix
              </p>
            )}
          </div>
        )}

        {/* File Upload */}
        {method === 'file' && (
          <div className="mb-6">
            <label className="block text-gray-600 dark:text-zinc-400 text-sm mb-2">
              Upload Document
            </label>
            <div className="relative">
              <input 
                id="file-upload"
                type="file"
                accept=".pdf,.md,.doc,.docx,.txt"
                onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                className="sr-only"
              />
              <label 
                htmlFor="file-upload"
                className="flex items-center justify-center gap-3 w-full p-6 rounded-md border-2 border-dashed cursor-pointer transition-all duration-300
                  bg-blue-500/10 hover:bg-blue-500/20 
                  border-blue-500/30 hover:border-blue-500/50
                  text-blue-600 dark:text-blue-400
                  hover:shadow-[0_0_15px_rgba(59,130,246,0.3)]
                  backdrop-blur-sm"
              >
                <Upload className="w-6 h-6" />
                <div className="text-center">
                  <div className="font-medium">
                    {selectedFile ? selectedFile.name : 'Choose File'}
                  </div>
                  <div className="text-sm opacity-75 mt-1">
                    {selectedFile 
                      ? `${(selectedFile.size / 1024 / 1024).toFixed(2)} MB` 
                      : 'Click to browse or drag and drop'}
                  </div>
                </div>
              </label>
            </div>
            <p className="text-gray-500 dark:text-zinc-600 text-sm mt-2">
              Supports PDF, MD, DOC up to 10MB
            </p>
          </div>
        )}

        {/* Crawl Depth - Only for URLs */}
        {method === 'url' && (
          <div className="mb-6">
            <label className="block text-gray-600 dark:text-zinc-400 text-sm mb-4">
              Crawl Depth
              <button
                type="button"
                className="ml-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                onMouseEnter={() => setShowDepthTooltip(true)}
                onMouseLeave={() => setShowDepthTooltip(false)}
              >
                <svg className="w-4 h-4 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </button>
            </label>
            
            <GlassCrawlDepthSelector
              value={crawlDepth}
              onChange={setCrawlDepth}
              showTooltip={showDepthTooltip}
              onTooltipToggle={setShowDepthTooltip}
            />
          </div>
        )}
        
        {/* Tags */}
        <div className="mb-6">
          <label className="block text-gray-600 dark:text-zinc-400 text-sm mb-2">
            Tags (AI will add recommended tags if left blank)
          </label>
          <div className="flex flex-wrap gap-2 mb-2">
            {tags.map((tag) => (
              <Badge key={tag} color="purple" variant="outline">
                {tag}
                <button
                  onClick={() => setTags(tags.filter(t => t !== tag))}
                  className="ml-1 text-purple-600 hover:text-purple-800"
                >
                  ×
                </button>
              </Badge>
            ))}
          </div>
          <Input 
            type="text" 
            value={newTag} 
            onChange={(e) => setNewTag(e.target.value)} 
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newTag.trim()) {
                setTags([...tags, newTag.trim()]);
                setNewTag('');
              }
            }} 
            placeholder="Add tags..." 
            accentColor="purple" 
          />
        </div>

        {/* Action Buttons */}
        <div className="flex justify-end gap-4">
          <Button onClick={onClose} variant="ghost" disabled={loading}>
            Cancel
          </Button>
          <Button 
            onClick={handleSubmit} 
            variant="primary" 
            accentColor={method === 'url' ? 'blue' : 'pink'} 
            disabled={loading}
          >
            {loading ? 'Adding...' : 'Add Source'}
          </Button>
        </div>
      </Card>
    </div>
  );
};