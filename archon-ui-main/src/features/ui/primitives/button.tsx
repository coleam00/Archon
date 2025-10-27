import React from "react";
import { cn } from "./styles";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "destructive" | "outline" | "ghost" | "link" | "cyan" | "knowledge"; // Tron-style purple button used on Knowledge Base
  size?: "default" | "sm" | "lg" | "icon" | "xs";
  loading?: boolean;
  children: React.ReactNode;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", loading = false, disabled, children, ...props }, ref) => {
    const baseStyles = cn(
      "inline-flex items-center justify-center rounded-md font-medium",
      "transition-all duration-300",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500",
      "disabled:pointer-events-none disabled:opacity-50",
      loading && "cursor-wait",
    );

    type ButtonVariant = NonNullable<ButtonProps["variant"]>;
    const variants: Record<ButtonVariant, string> = {
      default: cn(
        "backdrop-blur-md",
        "bg-gradient-to-b from-cyan-500/90 to-cyan-600/90",
        "dark:from-cyan-400/80 dark:to-cyan-500/80",
        "text-white dark:text-gray-900",
        "border border-cyan-400/30 dark:border-cyan-300/30",
        "hover:from-cyan-400 hover:to-cyan-500",
        "dark:hover:from-cyan-300 dark:hover:to-cyan-400",
        "hover:shadow-[0_0_20px_rgba(34,211,238,0.5)]",
        "dark:hover:shadow-[0_0_25px_rgba(34,211,238,0.7)]",
      ),
      destructive: cn(
        "backdrop-blur-md",
        "bg-gradient-to-b from-red-500/90 to-red-600/90",
        "dark:from-red-400/80 dark:to-red-500/80",
        "text-white",
        "border border-red-400/30 dark:border-red-300/30",
        "hover:from-red-400 hover:to-red-500",
        "dark:hover:from-red-300 dark:hover:to-red-400",
        "hover:shadow-[0_0_20px_rgba(239,68,68,0.5)]",
        "dark:hover:shadow-[0_0_25px_rgba(239,68,68,0.7)]",
      ),
      outline: cn(
        "backdrop-blur-md",
        "bg-gradient-to-b from-white/50 to-white/30",
        "dark:from-gray-900/50 dark:to-black/50",
        "text-gray-900 dark:text-cyan-100",
        "border border-gray-300/50 dark:border-cyan-500/50",
        "hover:from-white/70 hover:to-white/50",
        "dark:hover:from-gray-900/70 dark:hover:to-black/70",
        "hover:border-cyan-500/50 dark:hover:border-cyan-400/50",
        "hover:shadow-[0_0_15px_rgba(34,211,238,0.3)]",
        "dark:hover:shadow-[0_0_20px_rgba(34,211,238,0.5)]",
      ),
      ghost: cn(
        "text-gray-700 dark:text-cyan-100",
        "hover:bg-gray-100/50 dark:hover:bg-cyan-500/10",
        "hover:backdrop-blur-md",
      ),
      link: cn(
        "text-cyan-600 dark:text-cyan-400",
        "underline-offset-4 hover:underline",
        "hover:text-cyan-500 dark:hover:text-cyan-300",
      ),
      cyan: cn(
        "backdrop-blur-md",
        "bg-gradient-to-b from-cyan-100/80 to-white/60",
        "dark:from-cyan-500/20 dark:to-cyan-500/10",
        "text-cyan-700 dark:text-cyan-100",
        "border border-cyan-300/50 dark:border-cyan-500/50",
        "hover:from-cyan-200/90 hover:to-cyan-100/70",
        "dark:hover:from-cyan-400/30 dark:hover:to-cyan-500/20",
        "hover:shadow-[0_0_20px_rgba(34,211,238,0.5)]",
        "dark:hover:shadow-[0_0_25px_rgba(34,211,238,0.7)]",
      ),
      knowledge: cn(
        // Mirror the New Project button style, but purple
        "backdrop-blur-md",
        "bg-gradient-to-b from-purple-100/80 to-white/60",
        "dark:from-purple-500/20 dark:to-purple-500/10",
        "text-purple-700 dark:text-purple-100",
        "border border-purple-300/50 dark:border-purple-500/50",
        "hover:from-purple-200/90 hover:to-purple-100/70",
        "dark:hover:from-purple-400/30 dark:hover:to-purple-500/20",
        "hover:shadow-[0_0_20px_rgba(168,85,247,0.5)]",
        "dark:hover:shadow-[0_0_25px_rgba(168,85,247,0.7)]",
        "focus-visible:ring-purple-500",
      ),
    };

    type ButtonSize = NonNullable<ButtonProps["size"]>;
    const sizes: Record<ButtonSize, string> = {
      default: "h-10 px-4 py-2",
      sm: "h-9 rounded-md px-3",
      lg: "h-11 rounded-md px-8",
      icon: "h-10 w-10",
      xs: "h-7 px-2 text-xs",
    };

    return (
      <button
        className={cn(baseStyles, variants[variant], sizes[size], className)}
        ref={ref}
        disabled={disabled || loading}
        {...props}
      >
        {loading && (
          <svg
            className="mr-2 h-4 w-4 animate-spin"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            aria-label="Loading"
            role="img"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        )}
        {children}
      </button>
    );
  },
);

Button.displayName = "Button";

export interface IconButtonProps extends Omit<ButtonProps, "size" | "children"> {
  icon: React.ReactNode;
  "aria-label": string;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(({ icon, className, ...props }, ref) => {
  return (
    <Button ref={ref} size="icon" className={cn("relative", className)} {...props}>
      {icon}
    </Button>
  );
});

IconButton.displayName = "IconButton";
