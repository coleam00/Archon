import { afterEach, describe, expect, it } from "bun:test";
import { generateAllReports, generateCsvExport, generateJsonSummary, generateMarkdownReport, parseArgs } from "./fund-report-generator";

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

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  const saved = [...Bun.argv];

  afterEach(() => {
    Bun.argv = saved;
  });

  it("parses --scores", () => {
    Bun.argv = ["bun", "script.ts", "--scores", "scores.json"];
    const args = parseArgs();
    expect(args.scoresFile).toBe("scores.json");
  });

  it("parses --output-dir", () => {
    Bun.argv = ["bun", "script.ts", "--output-dir", "/tmp/out"];
    const args = parseArgs();
    expect(args.outputDir).toBe("/tmp/out");
  });

  it("parses both args", () => {
    Bun.argv = ["bun", "script.ts", "--scores", "s.json", "--output-dir", "/tmp"];
    const args = parseArgs();
    expect(args.scoresFile).toBe("s.json");
    expect(args.outputDir).toBe("/tmp");
  });

  it("returns empty object when no args", () => {
    Bun.argv = ["bun", "script.ts"];
    const args = parseArgs();
    expect(args.scoresFile).toBeUndefined();
    expect(args.outputDir).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// generateAllReports orchestrator
// ---------------------------------------------------------------------------

describe("generateAllReports", () => {
  it("returns all three report paths", () => {
    const paths = generateAllReports(mockAnalyses);
    expect(paths.markdown).toBeTruthy();
    expect(paths.csv).toBeTruthy();
    expect(paths.json).toBeTruthy();
    const { existsSync, unlinkSync } = require("node:fs");
    expect(existsSync(paths.markdown)).toBe(true);
    expect(existsSync(paths.csv)).toBe(true);
    expect(existsSync(paths.json)).toBe(true);
    try { unlinkSync(paths.markdown); } catch { /* cleanup */ }
    try { unlinkSync(paths.csv); } catch { /* cleanup */ }
    try { unlinkSync(paths.json); } catch { /* cleanup */ }
  });
});

// ---------------------------------------------------------------------------
// CSV comma escaping
// ---------------------------------------------------------------------------

describe("generateCsvExport escaping", () => {
  it("escapes commas in fund name", () => {
    const analyses = [{
      ...mockAnalysis,
      fundName: "测试,基金",
      fundCode: "001323",
    }];
    const path = generateCsvExport(analyses);
    const { readFileSync, unlinkSync } = require("node:fs");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain('"测试,基金"');
    try { unlinkSync(path); } catch { /* cleanup */ }
  });

  it("escapes quotes in risk warnings", () => {
    const analyses = [{
      ...mockAnalysis,
      riskWarnings: ['包含"引号"的警告'],
    }];
    const path = generateCsvExport(analyses);
    const { readFileSync, unlinkSync } = require("node:fs");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain('"包含""引号""的警告"');
    try { unlinkSync(path); } catch { /* cleanup */ }
  });
});

// ---------------------------------------------------------------------------
// News impact table rendering
// ---------------------------------------------------------------------------

describe("generateMarkdownReport with news", () => {
  it("renders news impact table when news data present", () => {
    const newsDigest = {
      overallSentiment: "MIXED" as const,
      summaryText: "市场情绪复杂，多空交织",
      impacts: [{
        newsTitle: "央行降息",
        economicImpact: "POSITIVE" as const,
        confidenceScore: 0.85,
        affectedSectors: ["金融", "地产", "消费"],
      }],
    };
    const path = generateMarkdownReport(mockAnalyses, null, newsDigest);
    const { readFileSync, unlinkSync } = require("node:fs");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("整体情绪");
    expect(content).toContain("央行降息");
    expect(content).toContain("🟢 POSITIVE");
    expect(content).toContain("85%");
    expect(content).toContain("金融");
    try { unlinkSync(path); } catch { /* cleanup */ }
  });
});

// ---------------------------------------------------------------------------
// Multi-fund sorting test
// ---------------------------------------------------------------------------

describe("generateMarkdownReport multi-fund", () => {
  it("sorts by composite score descending", () => {
    const analyses = [
      { ...mockAnalysis, fundCode: "001", compositeScore: 5.0, fundName: "Low" },
      { ...mockAnalysis, fundCode: "002", compositeScore: 9.0, fundName: "High" },
      { ...mockAnalysis, fundCode: "003", compositeScore: 7.0, fundName: "Mid" },
    ];
    const path = generateMarkdownReport(analyses);
    const { readFileSync, unlinkSync } = require("node:fs");
    const content = readFileSync(path, "utf-8");
    const highPos = content.indexOf("High");
    const midPos = content.indexOf("Mid");
    const lowPos = content.indexOf("Low");
    expect(highPos).toBeLessThan(midPos);
    expect(midPos).toBeLessThan(lowPos);
    try { unlinkSync(path); } catch { /* cleanup */ }
  });
});
