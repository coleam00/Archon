/**
 * Clipboard utility with fallback for non-secure contexts
 * Works on both HTTPS and HTTP connections
 */

/**
 * Copies text to clipboard with fallback for non-secure contexts
 * @param text - The text to copy to clipboard
 * @returns Promise<boolean> - Returns true if successful, false otherwise
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // First try the modern clipboard API (works on HTTPS/localhost)
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      console.warn('Clipboard API failed, trying fallback:', err);
    }
  }

  // Fallback method using execCommand (works on HTTP)
  try {
    // Create a temporary textarea element
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-999999px';
    textarea.style.top = '-999999px';
    textarea.setAttribute('readonly', ''); // Prevent keyboard from showing on mobile
    
    document.body.appendChild(textarea);
    
    // Select the text
    textarea.select();
    textarea.setSelectionRange(0, 99999); // For mobile devices
    
    // Copy the text
    const successful = document.execCommand('copy');
    
    // Remove the temporary element
    document.body.removeChild(textarea);
    
    if (successful) {
      return true;
    } else {
      console.warn('execCommand copy failed');
      return false;
    }
  } catch (err) {
    console.error('Fallback copy method failed:', err);
    return false;
  }
}

/**
 * Check if clipboard is available (for UI feedback)
 * @returns boolean - Returns true if clipboard operations are available
 */
export function isClipboardAvailable(): boolean {
  // Clipboard is available if either method works
  return !!(
    (navigator.clipboard && window.isSecureContext) || 
    document.queryCommandSupported?.('copy')
  );
}