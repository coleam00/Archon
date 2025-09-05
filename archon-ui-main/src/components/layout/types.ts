import type React from "react";

export interface NavigationItem {
  path: string;
  icon: React.ReactNode;
  label: string;
  enabled?: boolean;
}

export interface HealthResponse {
  ready: boolean;
  message?: string;
  server_status?: string;
  credentials_status?: string;
  database_status?: string;
  uptime?: number;
}

export interface AppSettings {
  projectsEnabled: boolean;
  theme?: "light" | "dark" | "system";
  // Add other settings as needed
}

export interface OnboardingCheckResult {
  shouldShowOnboarding: boolean;
  reason: "dismissed" | "missing_rag" | "missing_api_key" | null;
}
