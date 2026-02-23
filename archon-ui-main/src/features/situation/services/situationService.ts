import { callAPIWithETag } from "../../shared/api/apiClient";
import type { SituationBrief } from "../types";

export const situationService = {
  async analyze(): Promise<SituationBrief> {
    return callAPIWithETag<SituationBrief>("/api/situation/analyze", { method: "POST" });
  },
};
