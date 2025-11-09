import { motion } from "framer-motion";
import type React from "react";
import { cn } from "@/features/ui/primitives/styles";

interface WorkflowStepButtonProps {
  isCompleted: boolean;
  isActive: boolean;
  stepName: string;
  onClick?: () => void;
  color?: "cyan" | "green" | "blue" | "purple";
  size?: number;
}

// Helper function to get color hex values for animations
const getColorValue = (color: string) => {
  const colorValues = {
    purple: "rgb(168,85,247)",
    green: "rgb(34,197,94)",
    blue: "rgb(59,130,246)",
    cyan: "rgb(34,211,238)",
  };
  return colorValues[color as keyof typeof colorValues] || colorValues.blue;
};

export const WorkflowStepButton: React.FC<WorkflowStepButtonProps> = ({
  isCompleted,
  isActive,
  stepName,
  onClick,
  color = "cyan",
  size = 40,
}) => {
  const colorMap = {
    purple: {
      border: "border-purple-400 dark:border-purple-300",
      glow: "shadow-[0_0_15px_rgba(168,85,247,0.8)]",
      glowHover: "hover:shadow-[0_0_25px_rgba(168,85,247,1)]",
      fill: "bg-purple-400 dark:bg-purple-300",
      innerGlow: "shadow-[inset_0_0_10px_rgba(168,85,247,0.8)]",
    },
    green: {
      border: "border-green-400 dark:border-green-300",
      glow: "shadow-[0_0_15px_rgba(34,197,94,0.8)]",
      glowHover: "hover:shadow-[0_0_25px_rgba(34,197,94,1)]",
      fill: "bg-green-400 dark:bg-green-300",
      innerGlow: "shadow-[inset_0_0_10px_rgba(34,197,94,0.8)]",
    },
    blue: {
      border: "border-blue-400 dark:border-blue-300",
      glow: "shadow-[0_0_15px_rgba(59,130,246,0.8)]",
      glowHover: "hover:shadow-[0_0_25px_rgba(59,130,246,1)]",
      fill: "bg-blue-400 dark:bg-blue-300",
      innerGlow: "shadow-[inset_0_0_10px_rgba(59,130,246,0.8)]",
    },
    cyan: {
      border: "border-cyan-400 dark:border-cyan-300",
      glow: "shadow-[0_0_15px_rgba(34,211,238,0.8)]",
      glowHover: "hover:shadow-[0_0_25px_rgba(34,211,238,1)]",
      fill: "bg-cyan-400 dark:bg-cyan-300",
      innerGlow: "shadow-[inset_0_0_10px_rgba(34,211,238,0.8)]",
    },
  };

  const styles = colorMap[color];

  return (
    <div className="flex flex-col items-center gap-2">
      <motion.button
        onClick={onClick}
        className={cn(
          "relative rounded-full border-2 transition-all duration-300",
          styles.border,
          isCompleted ? styles.glow : "shadow-[0_0_5px_rgba(0,0,0,0.3)]",
          styles.glowHover,
          "bg-gradient-to-b from-gray-900 to-black dark:from-gray-800 dark:to-gray-900",
          "hover:scale-110 active:scale-95",
        )}
        style={{ width: size, height: size }}
        whileHover={{ scale: 1.1 }}
        whileTap={{ scale: 0.95 }}
        type="button"
        aria-label={`${stepName} - ${isCompleted ? "completed" : isActive ? "in progress" : "pending"}`}
      >
        {/* Outer ring glow effect */}
        <motion.div
          className={cn(
            "absolute inset-[-4px] rounded-full border-2 blur-sm",
            isCompleted ? styles.border : "border-transparent",
          )}
          animate={{
            opacity: isCompleted ? [0.3, 0.6, 0.3] : 0,
          }}
          transition={{
            duration: 2,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />

        {/* Inner glow effect */}
        <motion.div
          className={cn("absolute inset-[2px] rounded-full blur-md opacity-20", isCompleted && styles.fill)}
          animate={{
            opacity: isCompleted ? [0.1, 0.3, 0.1] : 0,
          }}
          transition={{
            duration: 2,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />

        {/* Checkmark icon container */}
        <div className="relative w-full h-full flex items-center justify-center">
          <motion.svg
            width={size * 0.5}
            height={size * 0.5}
            viewBox="0 0 24 24"
            fill="none"
            className="relative z-10"
            role="img"
            aria-label={`${stepName} status indicator`}
            animate={{
              filter: isCompleted
                ? [
                    `drop-shadow(0 0 8px ${getColorValue(color)}) drop-shadow(0 0 12px ${getColorValue(color)})`,
                    `drop-shadow(0 0 12px ${getColorValue(color)}) drop-shadow(0 0 16px ${getColorValue(color)})`,
                    `drop-shadow(0 0 8px ${getColorValue(color)}) drop-shadow(0 0 12px ${getColorValue(color)})`,
                  ]
                : "none",
            }}
            transition={{
              duration: 2,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          >
            {/* Checkmark path */}
            <path
              d="M20 6L9 17l-5-5"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={isCompleted ? "text-white" : "text-gray-600"}
            />
          </motion.svg>
        </div>
      </motion.button>

      {/* Step name label */}
      <span
        className={cn(
          "text-xs font-medium transition-colors",
          isCompleted
            ? "text-cyan-400 dark:text-cyan-300"
            : isActive
              ? "text-blue-500 dark:text-blue-400"
              : "text-gray-500 dark:text-gray-400",
        )}
      >
        {stepName}
      </span>
    </div>
  );
};
