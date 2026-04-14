import {
  useState,
  useRef,
  useCallback,
  useEffect,
  forwardRef,
  useImperativeHandle,
  type KeyboardEvent,
  type DragEvent,
  type ClipboardEvent,
} from 'react';
import { ArrowUp, Loader2, Paperclip, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SlashCommandMenu } from '@/components/conversations/SlashCommandMenu';
/** Binary (non-text) MIME types explicitly accepted */
const ACCEPTED_BINARY_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  // application/json may be reported by browsers for .json files
  'application/json',
]);

/** Extensions for the file-picker `accept` attribute. Covers images, PDFs, and text/code files. */
const ACCEPTED_EXTENSIONS_LIST = [
  // Images
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  // Documents
  '.pdf',
  // Text / markup
  '.md',
  '.txt',
  '.csv',
  '.xml',
  '.html',
  '.htm',
  // Data / config
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.env',
  '.log',
  // Web
  '.css',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  // Systems / scripting
  '.py',
  '.rb',
  '.go',
  '.java',
  '.c',
  '.cpp',
  '.cc',
  '.cxx',
  '.h',
  '.hpp',
  '.cs',
  '.php',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.rs',
  '.swift',
  '.kt',
  '.scala',
  '.r',
  '.sql',
];

/** Comma-separated string for the file input `accept` attribute */
const ACCEPTED_EXTENSIONS = ACCEPTED_EXTENSIONS_LIST.join(',');

/** Set for O(1) extension lookup in validation */
const ACCEPTED_EXTENSIONS_SET = new Set(ACCEPTED_EXTENSIONS_LIST);

/** Returns true if the file type is accepted (any text/* or an explicitly allowed binary). */
function isAcceptedFileType(file: File): boolean {
  if (file.type.startsWith('text/')) return true;
  if (ACCEPTED_BINARY_MIME_TYPES.has(file.type)) return true;
  // Browsers assign empty MIME types to many code/config extensions (.md, .py, .rs, etc.)
  // Fall back to checking the file extension from the accepted list
  const dotIndex = file.name.lastIndexOf('.');
  if (dotIndex !== -1) {
    const ext = file.name.slice(dotIndex).toLowerCase();
    return ACCEPTED_EXTENSIONS_SET.has(ext);
  }
  return false;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_FILES = 5;

interface MessageInputProps {
  onSend: (message: string, files?: File[]) => void;
  disabled: boolean;
  disabledReason?: string;
}

export interface MessageInputHandle {
  focus: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${String(Math.round(bytes / (1024 * 1024)))} MB`;
}
const messageInput = forwardRef<MessageInputHandle, MessageInputProps>(function MessageInputInner(
  { onSend, disabled, disabledReason }: MessageInputProps,
  ref
): React.ReactElement {
  const [value, setValue] = useState('');
  const [files, setFiles] = useState<{ file: File; id: string }[]>([]);
  const [dragging, setDragging] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputContainerRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({
    focus: (): void => {
      textareaRef.current?.focus();
    },
  }));

  // Close slash command menu when clicking outside the input container
  useEffect(() => {
    if (slashQuery === null) return;

    const handleMouseDown = (e: MouseEvent): void => {
      if (inputContainerRef.current && !inputContainerRef.current.contains(e.target as Node)) {
        setSlashQuery(null);
      }
    };

    document.addEventListener('mousedown', handleMouseDown);
    return (): void => {
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [slashQuery]);

  const addFiles = useCallback((incoming: File[]): void => {
    setFileError(null);
    setFiles(prev => {
      const combined = [...prev];
      const rejections: string[] = [];
      for (const file of incoming) {
        if (combined.length >= MAX_FILES) {
          rejections.push(`Maximum ${String(MAX_FILES)} files per message`);
          break;
        }
        if (file.size > MAX_FILE_BYTES) {
          rejections.push(`"${file.name}" exceeds the 10 MB size limit`);
          continue;
        }
        if (!isAcceptedFileType(file)) {
          rejections.push(`"${file.name}" is not a supported file type`);
          continue;
        }
        combined.push({ file, id: crypto.randomUUID() });
      }
      if (rejections.length > 0) {
        setFileError(rejections.join('; '));
      }
      return combined;
    });
  }, []);

  const removeFile = useCallback((id: string): void => {
    setFiles(prev => prev.filter(f => f.id !== id));
    setFileError(null);
  }, []);

  const handleSend = useCallback((): void => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed, files.length > 0 ? files.map(f => f.file) : undefined);
    setValue('');
    setSlashQuery(null);
    setFiles([]);
    setFileError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.focus();
    }
  }, [value, disabled, onSend, files]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      // If the slash command menu is open, let it handle Enter via its window listener
      if (slashQuery !== null) return;
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const newValue = e.target.value;
    setValue(newValue);
    // Auto-expand textarea
    const textarea = e.target;
    textarea.style.height = 'auto';
    const newHeight = Math.min(textarea.scrollHeight, 200);
    textarea.style.height = `${String(newHeight)}px`;
    textarea.style.overflowY = newHeight >= 200 ? 'auto' : 'hidden';
    // Detect slash command pattern: / at start or after whitespace, followed by non-whitespace
    const slashIdx = newValue.lastIndexOf('/');
    if (slashIdx !== -1) {
      const beforeSlash = newValue.slice(0, slashIdx);
      const afterSlash = newValue.slice(slashIdx + 1);
      if ((slashIdx === 0 || /\s$/.test(beforeSlash)) && !/\s/.test(afterSlash)) {
        setSlashQuery(afterSlash);
        return;
      }
    }
    setSlashQuery(null);
  };

  const handleSlashSelect = useCallback(
    (workflowName: string): void => {
      const slashIdx = value.lastIndexOf('/');
      if (slashIdx !== -1) {
        const beforeSlash = value.slice(0, slashIdx);
        const newValue = `${beforeSlash}/${workflowName} `;
        setValue(newValue);
        // Resize textarea to fit new content
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
          const newHeight = Math.min(textareaRef.current.scrollHeight, 200);
          textareaRef.current.style.height = `${String(newHeight)}px`;
          textareaRef.current.style.overflowY = newHeight >= 200 ? 'auto' : 'hidden';
        }
      }
      setSlashQuery(null);
      textareaRef.current?.focus();
    },
    [value]
  );

  const handleSlashClose = useCallback((): void => {
    setSlashQuery(null);
    textareaRef.current?.focus();
  }, []);

  const handleFilePickerChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    if (e.target.files) addFiles(Array.from(e.target.files));
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragging(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>): void => {
    // Only clear dragging when leaving the outer container, not a child element
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setDragging(false);
    }
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length > 0) addFiles(Array.from(e.dataTransfer.files));
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const imageItems = Array.from(e.clipboardData.items).filter(item =>
      item.type.startsWith('image/')
    );
    if (imageItems.length === 0) return;
    const pastedFiles: File[] = [];
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (file) pastedFiles.push(file);
    }
    if (pastedFiles.length > 0) {
      e.preventDefault();
      addFiles(pastedFiles);
    }
  };
  return (
    // flex-shrink-0 prevents this bar from being compressed inside the flex-col ChatInterface.
    // The inline paddingBottom uses env(safe-area-inset-bottom) so it clears the iOS home
    // indicator / Android gesture bar — max() ensures we keep at least 1rem of breathing room.
    <div
      className={`flex-shrink-0 border-t border-border bg-surface px-4 pt-4 transition-colors${dragging ? ' bg-primary/5' : ''}`}
      style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
      title={disabledReason}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        {/* File preview chips */}
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {files.map(({ file, id }) => (
              <div
                key={id}
                className="flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-text-secondary"
              >
                <span className="max-w-[140px] truncate" title={file.name}>
                  {file.name}
                </span>
                <span className="text-text-tertiary">({formatBytes(file.size)})</span>
                <button
                  type="button"
                  onClick={() => {
                    removeFile(id);
                  }}
                  className="ml-1 text-text-tertiary hover:text-text-primary"
                  aria-label={`Remove ${file.name}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* File error */}
        {fileError !== null && <p className="text-xs text-destructive">{fileError}</p>}

        {/* Input row — relative so the slash command popover can be positioned above it */}
        <div ref={inputContainerRef} className="relative flex items-end gap-2">
          {/* Slash command autocomplete popover */}
          {slashQuery !== null && (
            <SlashCommandMenu
              query={slashQuery}
              onSelect={handleSlashSelect}
              onClose={handleSlashClose}
              anchorRef={textareaRef}
            />
          )}

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPTED_EXTENSIONS}
            className="hidden"
            onChange={handleFilePickerChange}
            disabled={disabled}
          />

          {/* Attach button */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={disabled || files.length >= MAX_FILES}
            onClick={() => fileInputRef.current?.click()}
            className="h-10 w-10 shrink-0 text-text-tertiary hover:text-text-primary"
            title="Attach file"
          >
            <Paperclip className="h-4 w-4" />
          </Button>

          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            disabled={disabled}
            placeholder={dragging ? 'Drop files here...' : (disabledReason ?? 'Message Archon...')}
            rows={1}
            className="flex-1 resize-none overflow-hidden rounded-lg border border-border bg-background px-4 py-2 text-base leading-6 text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            style={{ minHeight: '40px', maxHeight: '200px' }}
          />
          <Button
            onClick={handleSend}
            disabled={disabled || !value.trim()}
            size="icon"
            className="h-10 w-10 shrink-0 rounded-lg bg-primary text-primary-foreground hover:bg-accent-hover disabled:opacity-50"
          >
            {disabled && !disabledReason ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowUp className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
});

export { messageInput as MessageInput };
