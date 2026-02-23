import { callAPIWithETag } from "../../shared/api/apiClient";
import type { TelemetrySnapshot } from "../types";

export const telemetryService = {
  async getSnapshot(): Promise<TelemetrySnapshot> {
    try {
      return await callAPIWithETag<TelemetrySnapshot>("/api/telemetry/snapshot");
    } catch (error) {
      console.error("Failed to fetch telemetry snapshot:", error);
      throw error;
    }
  },
};
