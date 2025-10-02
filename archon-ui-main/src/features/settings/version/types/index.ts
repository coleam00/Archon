/**
 * Type definitions for version checking and update management
 */

export interface ReleaseAsset {
  name: string;
  size: number;
  download_count: number;
  browser_download_url: string;
  content_type: string;
}

export interface VersionCheckResponse {
  current: string;
  latest: string | null;
  update_available: boolean;
  release_url: string | null;
  release_notes: string | null;
  published_at: string | null;
  check_error?: string | null;
  assets?: ReleaseAsset[] | null;
  author?: string | null;
}

export interface CurrentVersionResponse {
  version: string;
  timestamp: string;
}

export interface VersionStatus {
  isLoading: boolean;
  error: Error | null;
  data: VersionCheckResponse | null;
  lastChecked: Date | null;
}
