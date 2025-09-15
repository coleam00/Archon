/**
 * Universal clipboard utility with modern API and fallback support
 * Handles various security contexts and browser compatibility issues
 */

export interface ClipboardResult {
  success: boolean;
  method: 'clipboard-api' | 'execCommand' | 'failed';
  error?: string;
}

/**
 * Copy text to clipboard with automatic fallback mechanisms
 * @param text - Text to copy to clipboard
 * @returns Promise<ClipboardResult> - Result of the copy operation
 */
export const copyToClipboard = async (text: string): Promise<ClipboardResult> => {
  // Try modern clipboard API first
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return { success: true, method: 'clipboard-api' };
    } catch (error) {
      console.warn('Clipboard API failed, trying fallback:', error);
    }
  }

  // Fallback to document.execCommand for older browsers or insecure contexts
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    textarea.setAttribute('readonly', '');
    textarea.setAttribute('aria-hidden', 'true');
    
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    
    const success = document.execCommand('copy');
    document.body.removeChild(textarea);
    
    if (success) {
      return { success: true, method: 'execCommand' };
    } else {
      return { 
        success: false, 
        method: 'failed', 
        error: 'execCommand copy returned false' 
      };
    }
  } catch (error) {
    return { 
      success: false, 
      method: 'failed', 
      error: error instanceof Error ? error.message : 'Unknown error' 
    };
  }
};

/**
 * Check if clipboard functionality is supported in current context
 * @returns boolean - True if any clipboard method is available
 */
export const isClipboardSupported = (): boolean => {
  // Check modern clipboard API
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return true;
  }
  
  // Check execCommand fallback
  try {
    return document.queryCommandSupported?.('copy') ?? false;
  } catch {
    return false;
  }
};

/**
 * Get current security context information for debugging
 * @returns string - Description of current security context
 */
export const getSecurityContext = (): string => {
  if (typeof window === 'undefined') return 'server';
  if (window.isSecureContext) return 'secure';
  if (window.location.protocol === 'https:') return 'https';
  if (window.location.hostname === 'localhost' || 
      window.location.hostname === '127.0.0.1') return 'localhost';
  return 'insecure';
};

/**
 * Simple wrapper that provides the old API for backward compatibility
 * @param text - Text to copy
 * @returns Promise<boolean> - True if successful
 */
export const copyTextToClipboard = async (text: string): Promise<boolean> => {
  const result = await copyToClipboard(text);
  return result.success;
};