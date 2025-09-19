import { useState } from 'react';
import {
  LinkIcon,
  Upload,
  BoxIcon,
  Brain,
  Folder,
  Files,
  File as FileIcon
} from 'lucide-react';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Badge } from '../ui/Badge';
import { GlassCrawlDepthSelector } from '../ui/GlassCrawlDepthSelector';
import { useToast } from '../../features/ui/hooks/useToast';
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
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [groupByFolder, setGroupByFolder] = useState(false);
  const [groupAsSingle, setGroupAsSingle] = useState(false);
  const [groupDisplayName, setGroupDisplayName] = useState('');
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
        const filesToSend = selectedFiles.length > 0 ? selectedFiles : (selectedFile ? [selectedFile] : []);
        if (filesToSend.length === 0) {
          showToast('Please select at least one file', 'error');
          return;
        }

        if (filesToSend.length === 1 && !groupByFolder && !groupAsSingle) {
          const single = filesToSend[0];
          const result = await knowledgeBaseService.uploadDocument(single, {
            knowledge_type: knowledgeType,
            tags
          });
          if (result.success && result.progressId) {
            onStartCrawl(result.progressId, {
              currentUrl: `file://${single.name}`,
              progress: 0,
              status: 'starting',
              uploadType: 'document',
              fileName: single.name,
              fileType: single.type,
              originalUploadParams: {
                file: single,
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
        } else {
          const result = await knowledgeBaseService.uploadDocumentsBatch(filesToSend, {
            knowledge_type: knowledgeType,
            tags,
            groupBy: groupAsSingle ? 'batch' : (groupByFolder ? 'folder' : 'file'),
            groupDisplayName: groupAsSingle ? groupDisplayName : undefined,
          });
          if (result.success && result.progressId) {
            onStartCrawl(result.progressId, {
              currentUrl: `files://${filesToSend[0].name}`,
              progress: 0,
              status: 'starting',
              uploadType: groupAsSingle ? 'batch-single-source' : (groupByFolder ? 'batch-folder' : 'batch'),
              fileName: `${filesToSend[0].name} +${filesToSend.length - 1} more`,
              fileType: 'batch',
              fileCount: filesToSend.length,
              originalUploadParams: {
                files: filesToSend,
                knowledge_type: knowledgeType,
                tags
              }
            });
            showToast(`Batch upload started for ${filesToSend.length} files`, 'success');
            onClose();
          } else {
            showToast(result.message || 'Batch upload started', 'success');
            onSuccess();
          }
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
            <span>Upload Files</span>
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
              Upload Files
            </label>
            <div className="relative">
              <input 
                id="file-upload"
                type="file"
                accept=".pdf,.md,.doc,.docx,.txt,.html,.py,.js,.ts,.tsx"
                multiple
                onChange={(e) => {
                  const list = Array.from(e.target.files || []);
                  setSelectedFiles(list);
                  setSelectedFile(list[0] || null);
                }}
                className="sr-only"
              />
              {/* Hidden input for single file selection */}
              <input
                id="single-file-upload"
                type="file"
                accept=".pdf,.md,.doc,.docx,.txt,.html,.py,.js,.ts,.tsx"
                onChange={(e) => {
                  const file = e.target.files?.[0] || null;
                  setSelectedFile(file);
                  setSelectedFiles(file ? [file] : []);
                  // Single-file mode should not auto-group
                  setGroupAsSingle(false);
                  setGroupByFolder(false);
                }}
                className="sr-only"
              />

              {/* Separate hidden input for folder selection */}
              <input
                id="folder-upload"
                type="file"
                accept=".pdf,.md,.doc,.docx,.txt,.html,.py,.js,.ts,.tsx"
                multiple
                webkitdirectory="true"
                onChange={(e) => {
                  const list = Array.from(e.target.files || []);
                  setSelectedFiles(list);
                  setSelectedFile(list[0] || null);
                  // Folder heuristic: presence of webkitRelativePath
                  const anyWithRel = list.some((f: any) => !!(f as any).webkitRelativePath);
                  if (anyWithRel) {
                    setGroupAsSingle(true);
                    setGroupByFolder(false);
                    const firstRel = (list[0] as any).webkitRelativePath as string | undefined;
                    if (firstRel) {
                      const topFolder = firstRel.replace(/\\/g, '/').split('/')[0] || 'Batch Upload';
                      if (!groupDisplayName) {
                        setGroupDisplayName(topFolder);
                      }
                    }
                  }
                }}
                className="sr-only"
              />
              <div
                className="w-full p-6 rounded-md border-2 border-dashed transition-all duration-300
                  bg-blue-500/10
                  border-blue-500/30
                  text-blue-600 dark:text-blue-400 backdrop-blur-sm"
              >
                <div className="flex items-center justify-center gap-3 mb-5">
                  <Upload className="w-6 h-6" />
                  <div className="font-semibold tracking-wide">Choose what to upload</div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <Button
                    variant="primary"
                    accentColor="blue"
                    className="w-full py-4 text-base"
                    onClick={() => document.getElementById('single-file-upload')?.click()}
                  >
                    <FileIcon className="w-4 h-4 mr-2" /> Single File
                  </Button>
                  <Button
                    variant="primary"
                    accentColor="blue"
                    className="w-full py-4 text-base"
                    onClick={() => document.getElementById('file-upload')?.click()}
                  >
                    <Files className="w-4 h-4 mr-2" /> Multiple Files
                  </Button>
                  <Button
                    variant="primary"
                    accentColor="blue"
                    className="w-full py-4 text-base"
                    onClick={() => document.getElementById('folder-upload')?.click()}
                  >
                    <Folder className="w-4 h-4 mr-2" /> Folder
                  </Button>
                </div>
                <div className="text-center mt-5">
                  <div className="font-medium">
                    {selectedFiles.length > 1
                      ? `${selectedFiles[0].name} +${selectedFiles.length - 1} more`
                      : selectedFile
                        ? selectedFile.name
                        : 'No selection yet'}
                  </div>
                  <div className="text-sm opacity-75 mt-1">
                    {selectedFiles.length > 1
                      ? `${selectedFiles.length} items`
                      : selectedFile 
                        ? `${(selectedFile.size / 1024 / 1024).toFixed(2)} MB` 
                        : 'Single file, multiple files, or an entire folder'}
                  </div>
                </div>
              </div>
          </div>
          {/* Grouping options */}
          <div className="mt-3 flex flex-col gap-2 text-sm text-gray-600 dark:text-zinc-400">
            <label className="flex items-center gap-2">
              <input
                id="group-by-folder"
                type="checkbox"
                checked={groupByFolder}
                onChange={(e) => {
                  setGroupByFolder(e.target.checked);
                  if (e.target.checked) setGroupAsSingle(false);
                }}
                className="rounded border-gray-300"
              />
              <span>Group uploaded files by top-level folder</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                id="group-as-single"
                type="checkbox"
                checked={groupAsSingle}
                onChange={(e) => {
                  setGroupAsSingle(e.target.checked);
                  if (e.target.checked) setGroupByFolder(false);
                }}
                className="rounded border-gray-300"
              />
              <span>Group all selected files as a single source</span>
            </label>
            {groupAsSingle && (
              <div className="flex items-center gap-2">
                <Input
                  label="Source Title (optional)"
                  type="text"
                  value={groupDisplayName}
                  onChange={(e) => setGroupDisplayName(e.target.value)}
                  placeholder="e.g., ADK Full Docs"
                  accentColor="pink"
                />
              </div>
            )}
          </div>
            <div className="flex items-center justify-between mt-2 gap-3 flex-wrap">
              <p className="text-gray-500 dark:text-zinc-600 text-sm">
                Supports PDF, MD, DOC, HTML, and code files (.py, .js, .ts, .tsx) up to 10MB
              </p>
              <div className="flex items-center gap-4">
                <label
                  htmlFor="single-file-upload"
                  className="text-sm text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
                  title="Select a single file"
                >
                  Select single file
                </label>
                <span className="text-gray-400">|</span>
                <label
                  htmlFor="folder-upload"
                  className="text-sm text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
                  title="Select an entire folder"
                >
                  Select folder
                </label>
              </div>
            </div>
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
