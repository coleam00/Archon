import * as React from 'react';

import { cn } from '@/lib/utils';

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'file:text-foreground placeholder:text-muted-foreground selection:bg-black selection:text-white font-mono text-[15px] bg-[#F0F0F0] text-black border-[3px] border-black px-3 py-2.5 w-full min-w-0 outline-none transition-[border-width] focus:border-[5px] focus:outline-none',
        'aria-invalid:border-[3px] aria-invalid:border-red-600',
        'disabled:border-[3px] disabled:border-[#CCCCCC] disabled:bg-[#F5F5F5] disabled:cursor-not-allowed',
        className
      )}
      {...props}
    />
  );
}

export { Input };
