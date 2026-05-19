import { describe, expect, it } from "bun:test";
import { generateCsvExport, generateJsonSummary, generateMarkdownReport } from "./fund-report-generator";

const mockAnalysis = {
  fundCode: "001323",
  fundName: "测试基金",
  fundCategory: "偏股",
  sixDimScores: {
    fcfQuality: 7.5,
    capitalEfficiency: 8.0,
    shareholderReturn: 6.5,
    valuationSafety: 7.0,
    growth: 7.5,
    macroGeopolitical: 6.0,
  },
  fiveDimScreening: {
    fundamentalQualitative: "PASS" as const,
    performanceRiskQuant: "PASS" as const,
    holdingPenetration: "PASS" as const,
    managerEvaluation: "PASS" as const,
    marketTechnical: "WARN" as const,
  },
  compositeScore: 7.2,
  recommendation: "HOLD" as const,
  riskWarnings: ["宏观地缘风险较高 (6.0/10)"],
  analysisSummary: "六维综合评分: 7.2/10 (HOLD)",
  dataQuality: 0.7,
};

const mockAnalyses = [mockAnalysis];

describe("generateMarkdownReport", () => {
  it("generates Markdown with all sections", () => {
    const path = generateMarkdownReport(mockAnalyses);
    const { readFileSync, unlinkSync } = require("node:fs");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("# 基金投资分析报告");
    expect(content).toContain("## 一、宏观概览");
    expect(content).toContain("## 二、新闻影响摘要");
    expect(content).toContain("## 三、基金分析详情");
    expect(content).toContain("## 四、投资建议汇总");
    expect(content).toContain("## 五、风险提示");
    expect(content).toContain("001323");
    expect(content).toContain("测试基金");
    try { unlinkSync(path); } catch { /* cleanup */ }
  });

  it("handles empty analysis list", () => {
    const path = generateMarkdownReport([]);
    const { readFileSync, unlinkSync } = require("node:fs");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("# 基金投资分析报告");
    try { unlinkSync(path); } catch { /* cleanup */ }
  });
});

describe("generateCsvExport", () => {
  it("generates CSV with headers and data row", () => {
    const path = generateCsvExport(mockAnalyses);
    const { readFileSync, unlinkSync } = require("node:fs");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("基金代码");
    expect(content).toContain("001323");
    expect(content).toContain("HOLD");
    try { unlinkSync(path); } catch { /* cleanup */ }
  });
});

describe("generateJsonSummary", () => {
  it("generates valid JSON with analysis data", () => {
    const path = generateJsonSummary(mockAnalyses);
    const { readFileSync, unlinkSync } = require("node:fs");
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.totalFunds).toBe(1);
    expect(parsed.analyses[0].fundCode).toBe("001323");
    expect(parsed.recommendations.HOLD).toBe(1);
    try { unlinkSync(path); } catch { /* cleanup */ }
  });
});
