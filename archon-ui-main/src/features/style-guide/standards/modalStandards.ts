export const MODAL_TYPES = {
  confirmation: {
    size: "sm" as const,
    glowColor: "red" as const,
    purpose: "Destructive actions",
  },
  formCreate: {
    size: "md" as const,
    glowColor: "green" as const,
    purpose: "Creating resources",
  },
  formEdit: {
    size: "md" as const,
    glowColor: "blue" as const,
    purpose: "Editing resources",
  },
  display: {
    size: "lg" as const,
    glowColor: "purple" as const,
    purpose: "Detailed information",
  },
  codeViewer: {
    size: "xl" as const,
    glowColor: "cyan" as const,
    purpose: "Code display",
  },
  settings: {
    size: "lg" as const,
    glowColor: "blue" as const,
    purpose: "App settings",
  },
};
