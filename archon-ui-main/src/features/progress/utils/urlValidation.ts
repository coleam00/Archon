/**
 * Client-side URL validation utility for discovered files.
 * Ensures only safe HTTP/HTTPS URLs are rendered as clickable links.
 */

const SAFE_PROTOCOLS = ["http:", "https:"];

/**
 * Validates that a URL is safe to render as a clickable link.
 * Only allows http: and https: protocols.
 *
 * @param url - URL string to validate
 * @returns true if URL is safe (http/https), false otherwise
 */
export function isValidHttpUrl(url: string | undefined | null): boolean {
  if (!url || typeof url !== "string") {
    return false;
  }

  // Trim whitespace
  const trimmed = url.trim();
  if (!trimmed) {
    return false;
  }

  try {
    const parsed = new URL(trimmed);

    // Only allow http and https protocols
    if (!SAFE_PROTOCOLS.includes(parsed.protocol)) {
      return false;
    }

    // Basic hostname validation (must have at least one dot or be localhost)
    if (!parsed.hostname.includes(".") && parsed.hostname !== "localhost") {
      return false;
    }

    return true;
  } catch {
    // URL parsing failed - not a valid URL
    return false;
  }
}
