import * as React from 'react';

import { cn } from '@/lib/utils';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'font-mono text-[15px] bg-[#F0F0F0] text-black border-[3px] border-black px-3 py-2.5 w-full min-w-0 outline-none transition-[border-width] focus:border-[5px] focus:outline-none field-sizing-content min-h-16',
        'aria-invalid:border-[3px] aria-invalid:border-red-600',
        'disabled:border-[3px] disabled:border-[#CCCCCC] disabled:bg-[#F5F5F5] disabled:cursor-not-allowed',
        'placeholder:text-[#666666]',
        className
      )}
      {...props}
    />
  );
}

export { Textarea };
