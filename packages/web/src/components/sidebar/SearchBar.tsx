import { Search, X } from 'lucide-react';
import type { RefObject } from 'react';

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  inputRef?: RefObject<HTMLInputElement | null>;
}

export function SearchBar({
  value,
  onChange,
  placeholder,
  inputRef,
}: SearchBarProps): React.ReactElement {
  return (
    <div className="relative flex items-center">
      <Search className="absolute left-2.5 h-3.5 w-3.5 text-[#666666]" />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e): void => {
          onChange(e.target.value);
        }}
        placeholder={placeholder}
        className="h-8 w-full border-[3px] border-black bg-[#F0F0F0] pl-8 pr-8 text-sm text-black placeholder:text-[#666666] focus:bg-white focus:border-[5px] focus:outline-none transition-[border-width]"
      />
      {value && (
        <button
          onClick={(): void => {
            onChange('');
          }}
          className="absolute right-2 p-0.5 border border-transparent hover:border-black transition-colors"
        >
          <X className="h-3 w-3 text-[#666666]" />
        </button>
      )}
    </div>
  );
}
