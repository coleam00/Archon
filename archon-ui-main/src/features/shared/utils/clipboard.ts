/**
 * Universal clipboard utility with modern API and fallback support
 * Handles various security contexts and browser compatibility issues
 */

export interface ClipboardResult {
  success: boolean;
  method: "clipboard-api" | "execCommand" | "failed";
  error?: string;
}

/**
 * Copy text to clipboard with automatic fallback mechanisms
 * @param text - Text to copy to clipboard
 * @returns Promise<ClipboardResult> - Result of the copy operation
 */
export const copyToClipboard = async (text: string): Promise<ClipboardResult> => {
  // Try modern clipboard API first with SSR-safe guards
  if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return { success: true, method: "clipboard-api" };
    } catch (error) {
      console.warn("Clipboard API failed, trying fallback:", error);
    }
  }

  // Fallback to document.execCommand for older browsers or insecure contexts
  // Add SSR guards for document access
  if (typeof document === "undefined") {
    return {
      success: false,
      method: "failed",
      error: "Running in server-side environment - clipboard not available",
    };
  }

  let textarea: HTMLTextAreaElement | null = null;
  try {
    // Ensure document.body exists before proceeding
    if (!document.body) {
      return {
        success: false,
        method: "failed",
        error: "document.body is not available",
      };
    }

    textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.style.left = "-9999px";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    textarea.setAttribute("readonly", "");
    textarea.setAttribute("aria-hidden", "true");

    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, text.length);

    const success = document.execCommand("copy");

    if (success) {
      return { success: true, method: "execCommand" };
    } else {
      return {
        success: false,
        method: "failed",
        error: "execCommand copy returned false",
      };
    }
  } catch (error) {
    return {
      success: false,
      method: "failed",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  } finally {
    // Always clean up the textarea element if it was created and added to DOM
    if (textarea && document.body && document.body.contains(textarea)) {
      try {
        document.body.removeChild(textarea);
      } catch (cleanupError) {
        // Ignore cleanup errors - element may have already been removed
        console.warn("Failed to cleanup textarea element:", cleanupError);
      }
    }
  }
};

/**
 * Check if clipboard functionality is supported in current context
 * @returns boolean - True if any clipboard method is available
 */
export const isClipboardSupported = (): boolean => {
  // Check modern clipboard API with proper SSR guards
  if (
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard !== "undefined" &&
    typeof navigator.clipboard.writeText === "function"
  ) {
    return true;
  }

  // Check execCommand fallback with SSR guards
  if (typeof document !== "undefined" && typeof document.queryCommandSupported === "function") {
    try {
      return document.queryCommandSupported("copy");
    } catch {
      return false;
    }
  }

  // Return false if running in SSR or globals are unavailable
  return false;
};

/**
 * Get current security context information for debugging
 * @returns string - Description of current security context
 */
export const getSecurityContext = (): string => {
  if (typeof window === "undefined") return "server";
  if (window.isSecureContext) return "secure";
  if (window.location.protocol === "https:") return "https";
  if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") return "localhost";
  return "insecure";
};
