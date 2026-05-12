import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap uppercase tracking-wider text-sm font-semibold transition-all disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:ring-[3px] focus-visible:ring-ring aria-invalid:ring-destructive/20 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default:
          'bg-black text-white border-[3px] border-black hover:bg-white hover:text-black active:border-[5px]',
        destructive:
          'bg-red-600 text-white border-[3px] border-black hover:bg-black hover:text-red-600 active:border-[5px]',
        outline: 'bg-white text-black border-[3px] border-black hover:bg-black hover:text-white',
        secondary: 'bg-white text-black border-[3px] border-black hover:bg-black hover:text-white',
        ghost: 'bg-transparent text-black border-none underline hover:text-black',
        link: 'text-[#0000FF] underline uppercase tracking-wider',
      },
      size: {
        default: 'px-6 py-3 text-sm',
        xs: 'px-3 py-1.5 text-xs',
        sm: 'px-4 py-2 text-xs',
        lg: 'px-10 py-4 text-base',
        icon: 'size-10',
        'icon-xs': "size-6 [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-8',
        'icon-lg': 'size-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : 'button';

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
