/**
 * Loading Fallback Component
 *
 * Displayed while lazy-loaded routes are being fetched.
 * Provides accessible loading state with spinner and text.
 */

export function LoadingFallback() {
  return (
    <div
      className="flex items-center justify-center min-h-screen bg-gray-950"
      role="status"
      aria-label="Loading page"
      aria-live="polite"
    >
      <div className="flex flex-col items-center gap-4">
        {/* Spinner */}
        <div
          className="w-12 h-12 border-4 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin"
          aria-hidden="true"
        />
        {/* Loading text */}
        <p className="text-sm text-gray-400">Loading...</p>
      </div>
    </div>
  );
}
