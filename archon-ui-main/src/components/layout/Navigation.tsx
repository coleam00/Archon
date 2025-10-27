import { BookOpen, Palette, Settings } from "lucide-react";
import type React from "react";
import { Link, useLocation } from "react-router-dom";
// TEMPORARY: Use old SettingsContext until settings are migrated
import { useSettings } from "../../contexts/SettingsContext";
import { glassmorphism } from "../../features/ui/primitives/styles";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../features/ui/primitives/tooltip";
import { cn } from "../../lib/utils";

interface NavigationItem {
  path: string;
  icon: React.ReactNode;
  label: string;
  enabled?: boolean;
}

interface NavigationProps {
  className?: string;
}

/**
 * Modern navigation component using Radix UI patterns
 * No fixed positioning - parent controls layout
 */
export function Navigation({ className }: NavigationProps) {
  const location = useLocation();
  const { projectsEnabled, styleGuideEnabled } = useSettings();

  // Navigation items configuration
  const navigationItems: NavigationItem[] = [
    {
      path: "/",
      icon: <BookOpen className="h-5 w-5" />,
      label: "Knowledge Base",
      enabled: true,
    },
    {
      path: "/mcp",
      icon: (
        <svg
          fill="currentColor"
          fillRule="evenodd"
          height="20"
          width="20"
          viewBox="0 0 24 24"
          xmlns="http://www.w3.org/2000/svg"
          role="img"
          aria-label="MCP Server Icon"
        >
          <path d="M15.688 2.343a2.588 2.588 0 00-3.61 0l-9.626 9.44a.863.863 0 01-1.203 0 .823.823 0 010-1.18l9.626-9.44a4.313 4.313 0 016.016 0 4.116 4.116 0 011.204 3.54 4.3 4.3 0 013.609 1.18l.05.05a4.115 4.115 0 010 5.9l-8.706 8.537a.274.274 0 000 .393l1.788 1.754a.823.823 0 010 1.18.863.863 0 01-1.203 0l-1.788-1.753a1.92 1.92 0 010-2.754l8.706-8.538a2.47 2.47 0 000-3.54l-.05-.049a2.588 2.588 0 00-3.607-.003l-7.172 7.034-.002.002-.098.097a.863.863 0 01-1.204 0 .823.823 0 010-1.18l7.273-7.133a2.47 2.47 0 00-.003-3.537z" />
          <path d="M14.485 4.703a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a4.115 4.115 0 000 5.9 4.314 4.314 0 006.016 0l7.12-6.982a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a2.588 2.588 0 01-3.61 0 2.47 2.47 0 010-3.54l7.12-6.982z" />
        </svg>
      ),
      label: "MCP Server",
      enabled: true,
    },
    {
      path: "/style-guide",
      icon: <Palette className="h-5 w-5" />,
      label: "Style Guide",
      enabled: styleGuideEnabled,
    },
    {
      path: "/settings",
      icon: <Settings className="h-5 w-5" />,
      label: "Settings",
      enabled: true,
    },
  ];

  // Filter out disabled navigation items
  const enabledNavigationItems = navigationItems.filter((item) => item.enabled);

  const isProjectsActive = location.pathname.startsWith("/projects");

  return (
    <nav
      className={cn(
        "flex flex-col items-center gap-6 py-6 px-3",
        "rounded-xl w-[72px]",
        // Using glassmorphism from primitives
        glassmorphism.background.subtle,
        "border border-gray-200 dark:border-zinc-800/50",
        "shadow-[0_10px_30px_-15px_rgba(0,0,0,0.1)] dark:shadow-[0_10px_30px_-15px_rgba(0,0,0,0.7)]",
        className,
      )}
    >
      {/* Logo - Always visible, conditionally clickable for Projects */}
      <Tooltip>
        <TooltipTrigger asChild>
          {projectsEnabled ? (
            <Link
              to="/projects"
              className={cn(
                "relative p-2 rounded-lg transition-all duration-300",
                "flex items-center justify-center",
                "hover:bg-white/10 dark:hover:bg-white/5",
                isProjectsActive && [
                  "bg-gradient-to-b from-white/20 to-white/5 dark:from-white/10 dark:to-black/20",
                  "shadow-[0_5px_15px_-5px_rgba(59,130,246,0.3)] dark:shadow-[0_5px_15px_-5px_rgba(59,130,246,0.5)]",
                  "transform scale-110",
                ],
              )}
            >
              <img
                src="/logo-neon.png"
                alt="Archon"
                className={cn(
                  "w-8 h-8 transition-all duration-300",
                  isProjectsActive && "filter drop-shadow-[0_0_8px_rgba(59,130,246,0.7)]",
                )}
              />
              {/* Active state decorations */}
              {isProjectsActive && (
                <>
                  <span className="absolute inset-0 rounded-lg border border-blue-300 dark:border-blue-500/30" />
                  <span className="absolute bottom-0 left-[15%] right-[15%] w-[70%] mx-auto h-[2px] bg-blue-500 shadow-[0_0_10px_2px_rgba(59,130,246,0.4)] dark:shadow-[0_0_20px_5px_rgba(59,130,246,0.7)]" />
                </>
              )}
            </Link>
          ) : (
            <div className="p-2 rounded-lg opacity-50 cursor-not-allowed">
              <img src="/logo-neon.png" alt="Archon" className="w-8 h-8 grayscale" />
            </div>
          )}
        </TooltipTrigger>
        <TooltipContent>
          <p>{projectsEnabled ? "Project Management" : "Projects Disabled"}</p>
        </TooltipContent>
      </Tooltip>

      {/* Separator */}
      <div className="w-8 h-px bg-gradient-to-r from-transparent via-gray-300 dark:via-gray-700 to-transparent" />

      {/* Navigation Items */}
      <nav className="flex flex-col gap-4">
        {enabledNavigationItems.map((item) => {
          const isActive = location.pathname === item.path;

          return (
            <Tooltip key={item.path}>
              <TooltipTrigger asChild>
                <Link
                  to={item.path}
                  className={cn(
                    "relative p-3 rounded-lg transition-all duration-300",
                    "flex items-center justify-center",
                    isActive
                      ? [
                          "bg-gradient-to-b from-white/20 to-white/5 dark:from-white/10 dark:to-black/20",
                          "text-blue-600 dark:text-blue-400",
                          "shadow-[0_5px_15px_-5px_rgba(59,130,246,0.3)] dark:shadow-[0_5px_15px_-5px_rgba(59,130,246,0.5)]",
                        ]
                      : [
                          "text-gray-500 dark:text-zinc-500",
                          "hover:text-blue-600 dark:hover:text-blue-400",
                          "hover:bg-white/10 dark:hover:bg-white/5",
                        ],
                  )}
                >
                  {item.icon}
                  {/* Active state decorations with neon line */}
                  {isActive && (
                    <>
                      <span className="absolute inset-0 rounded-lg border border-blue-300 dark:border-blue-500/30" />
                      <span className="absolute bottom-0 left-[15%] right-[15%] w-[70%] mx-auto h-[2px] bg-blue-500 shadow-[0_0_10px_2px_rgba(59,130,246,0.4)] dark:shadow-[0_0_20px_5px_rgba(59,130,246,0.7)]" />
                    </>
                  )}
                </Link>
              </TooltipTrigger>
              <TooltipContent>
                <p>{item.label}</p>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </nav>
    </nav>
  );
}
