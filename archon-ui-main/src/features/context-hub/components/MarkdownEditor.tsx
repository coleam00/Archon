import { useId } from "react";
import { Textarea } from "@/features/ui/primitives/textarea";

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  disabled?: boolean;
  minHeight?: string;
}

export const MarkdownEditor: React.FC<MarkdownEditorProps> = ({
  value,
  onChange,
  placeholder = "Enter markdown content...",
  label,
  disabled = false,
  minHeight = "200px",
}) => {
  const editorId = useId();

  return (
    <div className="space-y-2">
      {label && (
        <label htmlFor={editorId} className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          {label}
        </label>
      )}
      <div className="relative">
        <Textarea
          id={editorId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className="font-mono text-sm resize-y"
          style={{ minHeight }}
        />
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Supports Markdown: # headings, - lists, `code`, **bold**, *italic*
      </p>
    </div>
  );
};
