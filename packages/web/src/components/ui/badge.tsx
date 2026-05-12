import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';

import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center justify-center uppercase tracking-wider text-[11px] font-semibold px-2.5 py-1 border-[2px] border-black',
  {
    variants: {
      variant: {
        default: 'bg-black text-white',
        secondary: 'bg-white text-black',
        destructive: 'bg-white text-red-600 border-red-600',
        outline: 'bg-white text-black border-black',
        success: 'bg-white text-green-600 border-green-600',
        warning: 'bg-white text-orange-600 border-orange-600',
        ghost: 'bg-transparent text-black border-transparent hover:bg-black hover:text-white',
        link: 'text-black underline uppercase tracking-wider border-transparent hover:bg-black hover:text-white',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

function Badge({
  className,
  variant = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'span';

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
