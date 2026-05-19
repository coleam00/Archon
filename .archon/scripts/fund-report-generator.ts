import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types (mirrored from fund-score-engine)
// ---------------------------------------------------------------------------

type Recommendation = "BUY" | "HOLD" | "REDUCE" | "SELL";

interface SixDimScores {
  fcfQuality: number | null;
  capitalEfficiency: number | null;
  shareholderReturn: number | null;
  valuationSafety: number | null;
  growth: number | null;
  macroGeopolitical: number;
}

interface FiveDimScreening {
  fundamentalQualitative: "PASS" | "WARN" | "FAIL";
  performanceRiskQuant: "PASS" | "WARN" | "FAIL";
  holdingPenetration: "PASS" | "WARN" | "FAIL";
  managerEvaluation: "PASS" | "WARN" | "FAIL";
  marketTechnical: "PASS" | "WARN" | "FAIL";
}

interface FundAnalysisResult {
  fundCode: string;
  fundName: string;
  fundCategory: string;
  sixDimScores: SixDimScores;
  fiveDimScreening: FiveDimScreening;
  compositeScore: number;
  recommendation: Recommendation;
  riskWarnings: string[];
  analysisSummary: string;
  dataQuality: number;
}

interface NewsSentiment {
  overallSentiment: "POSITIVE" | "NEGATIVE" | "NEUTRAL" | "MIXED";
  summaryText?: string;
  impacts?: Array<{
    newsTitle: string;
    economicImpact: string;
    confidenceScore: number;
    affectedSectors: string[];
  }>;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatScoreColor(score: number): string {
  if (score >= 7.5) return `🟢 ${score.toFixed(1)}`;
  if (score >= 5.0) return `🟡 ${score.toFixed(1)}`;
  return `🔴 ${score.toFixed(1)}`;
}

function recommendationIcon(rec: Recommendation): string {
  switch (rec) {
    case "BUY": return "🟢 **买入**";
    case "HOLD": return "🟡 **持有**";
    case "REDUCE": return "🟠 **减仓**";
    case "SELL": return "🔴 **卖出**";
  }
}

function statusIcon(status: string): string {
  switch (status) {
    case "PASS": return "✅";
    case "WARN": return "⚠️";
    case "FAIL": return "❌";
    default: return "?";
  }
}

function newsEmoji(impact: string): string {
  switch (impact) {
    case "POSITIVE": return "🟢";
    case "NEGATIVE": return "🔴";
    case "NEUTRAL": return "⚪";
    case "MIXED": return "🟠";
    default: return "⚪";
  }
}

function timestamp(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const h = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  return `${y}年${m}月${d}日 ${h}:${min}`;
}

function ensureOutputDir(path: string): void {
  const sep = path.lastIndexOf("/");
  if (sep <= 0) return; // no directory component, assume cwd
  const dir = path.substring(0, sep);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Markdown Report
// ---------------------------------------------------------------------------

export function generateMarkdownReport(
  analyses: FundAnalysisResult[],
  macroData?: Record<string, unknown> | null,
  newsDigest?: NewsSentiment | null,
  outputPath?: string,
): string {
  const artifactsDir = process.env.ARTIFACTS_DIR ?? "./artifacts";
  if (!outputPath) outputPath = join(artifactsDir, "基金投资分析报告.md");
  ensureOutputDir(outputPath);

  const nowStr = timestamp();
  const sorted = analyses.toSorted((a, b) => b.compositeScore - a.compositeScore);

  const lines: string[] = [
    `# 基金投资分析报告 (${nowStr})`,
    "",
    "**分析框架**: 六维量化决策 + 五维筛选框架",
    "**数据来源**: akshare / yfinance / Claude AI新闻分析",
    "",
    "---",
    "",
  ];

  // Section 1: Macro Overview
  lines.push("## 一、宏观概览", "");
  if (newsDigest?.summaryText) {
    lines.push(`**新闻情绪概况**: ${newsDigest.summaryText}`, "");
  }
  if (macroData) {
    const entries = Object.entries(macroData).filter(
      ([, v]) => v !== null && (!Array.isArray(v) || v.length > 0),
    );
    if (entries.length > 0) {
      lines.push("| 指标 | 状态 |", "| :--- | :--- |");
      for (const [name, val] of entries.slice(0, 20)) {
        const rowCount = Array.isArray(val) ? val.length : 1;
        lines.push(`| ${name} | ✅ 已采集 (${rowCount} 行) |`);
      }
    } else {
      lines.push("| -- | 暂无宏观数据 |");
    }
    lines.push("");
  }

  // Section 2: News Impact
  lines.push("---", "", "## 二、新闻影响摘要", "");
  if (newsDigest?.impacts && newsDigest.impacts.length > 0) {
    lines.push(`**整体情绪**: ${newsDigest.overallSentiment}`, "");
    lines.push("| 新闻标题 | 影响 | 置信度 | 关连板块 |", "| :--- | :--- | :--- | :--- |");
    for (const impact of newsDigest.impacts.slice(0, 15)) {
      const title = impact.newsTitle.slice(0, 50);
      const conf = `${Math.round(impact.confidenceScore * 100)}%`;
      const sectors = impact.affectedSectors.slice(0, 3).join(", ");
      lines.push(
        `| ${title} | ${newsEmoji(impact.economicImpact)} ${impact.economicImpact} | ${conf} | ${sectors} |`,
      );
    }
    lines.push("");
  } else {
    lines.push("暂无新闻分析数据（可能未配置 LLM API 密钥）", "");
  }

  // Section 3: Fund Analysis Details
  lines.push("---", "", "## 三、基金分析详情", "");

  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    const s = a.sixDimScores;
    const f = a.fiveDimScreening;

    lines.push(`### ${i + 1}. ${a.fundName} (\`${a.fundCode}\`)`, "");
    lines.push(`- **综合评分**: ${formatScoreColor(a.compositeScore)} / 10`);
    lines.push(`- **投资建议**: ${recommendationIcon(a.recommendation)}`);
    lines.push(`- **数据质量**: ${Math.round(a.dataQuality * 100)}%`, "");

    lines.push("#### 六维评分", "");
    lines.push("| 维度 | 评分 | 说明 |", "| :--- | :--- | :--- |");
    const scoreCol = (s: number | null) => s !== null ? formatScoreColor(s) : "⚪ N/A";
    lines.push(`| FCF质量 | ${scoreCol(s.fcfQuality)} | 自由现金流质量 |`);
    lines.push(`| 资本效率 | ${scoreCol(s.capitalEfficiency)} | ROE/ROIC/资产周转率 |`);
    lines.push(`| 股东回报 | ${scoreCol(s.shareholderReturn)} | 股息率/回购/分红 |`);
    lines.push(`| 估值安全边际 | ${scoreCol(s.valuationSafety)} | PE/PB/PEG分位数 |`);
    lines.push(`| 成长性 | ${scoreCol(s.growth)} | 营收/利润增长率 |`);
    lines.push(`| 宏观地缘风险 | ${formatScoreColor(s.macroGeopolitical)} | 高分=低风险 |`);
    lines.push("");

    lines.push("#### 五维筛选", "");
    lines.push("| 筛选维度 | 结果 |", "| :--- | :--- |");
    lines.push(`| 基本面定性 | ${statusIcon(f.fundamentalQualitative)} ${f.fundamentalQualitative} |`);
    lines.push(`| 业绩风险量化 | ${statusIcon(f.performanceRiskQuant)} ${f.performanceRiskQuant} |`);
    lines.push(`| 持仓穿透 | ${statusIcon(f.holdingPenetration)} ${f.holdingPenetration} |`);
    lines.push(`| 基金经理 | ${statusIcon(f.managerEvaluation)} ${f.managerEvaluation} |`);
    lines.push(`| 市场技术面 | ${statusIcon(f.marketTechnical)} ${f.marketTechnical} |`);
    lines.push("");

    if (a.riskWarnings.length > 0) {
      lines.push("#### 风险提示", "");
      for (const w of a.riskWarnings) {
        lines.push(`- ⚠️ ${w}`);
      }
      lines.push("");
    }
  }

  // Section 4: Summary Table
  lines.push("---", "", "## 四、投资建议汇总", "");
  lines.push("| 基金名称 | 代码 | 综合评分 | 建议 |", "| :--- | :--- | :--- | :--- |");
  for (const a of sorted) {
    lines.push(
      `| ${a.fundName} | \`${a.fundCode}\` | ${formatScoreColor(a.compositeScore)} | ${recommendationIcon(a.recommendation)} |`,
    );
  }
  lines.push("");

  // Section 5: Disclaimer
  lines.push("---", "", "## 五、风险提示", "");
  lines.push("- 本报告由量化模型自动生成，仅供投资参考，不构成直接投资建议。");
  lines.push("- 数据采集可能因网络或API限制而不完整，分析结果基于可获取数据的最大估计。");
  lines.push("- 投资有风险，入市需谨慎。过往业绩不代表未来表现。");
  lines.push("");

  const content = lines.join("\n");
  writeFileSync(outputPath, content, "utf-8");
  return outputPath;
}

// ---------------------------------------------------------------------------
// CSV Export
// ---------------------------------------------------------------------------

export function generateCsvExport(
  analyses: FundAnalysisResult[],
  outputPath?: string,
): string {
  const artifactsDir = process.env.ARTIFACTS_DIR ?? "./artifacts";
  if (!outputPath) outputPath = join(artifactsDir, "基金分析结果.csv");
  ensureOutputDir(outputPath);

  const headers = [
    "基金代码", "基金名称", "分类", "综合评分", "投资建议",
    "FCF质量", "资本效率", "股东回报", "估值安全边际", "成长性", "宏观地缘风险",
    "基本面筛选", "业绩风险筛选", "持仓穿透筛选", "基金经理筛选", "市场技术筛选",
    "风险警告", "数据质量",
  ];

  const rows = analyses.map((a) => {
    const s = a.sixDimScores;
    const f = a.fiveDimScreening;
    const n = (v: number | null) => v !== null ? v.toFixed(1) : "N/A";
    return [
      a.fundCode, a.fundName, a.fundCategory,
      a.compositeScore.toFixed(1), a.recommendation,
      n(s.fcfQuality), n(s.capitalEfficiency), n(s.shareholderReturn),
      n(s.valuationSafety), n(s.growth), s.macroGeopolitical.toFixed(1),
      f.fundamentalQualitative, f.performanceRiskQuant, f.holdingPenetration,
      f.managerEvaluation, f.marketTechnical,
      a.riskWarnings.join("; "),
      `${Math.round(a.dataQuality * 100)}%`,
    ].map((v) => {
      // CSV escape: wrap fields with commas or quotes
      if (String(v).includes(",") || String(v).includes('"') || String(v).includes("\n")) {
        return `"${String(v).replace(/"/g, '""')}"`;
      }
      return String(v);
    }).join(",");
  });

  // UTF-8 BOM for Excel compatibility
  const bom = "﻿";
  const content = bom + [headers.join(","), ...rows].join("\n");
  writeFileSync(outputPath, content, "utf-8");
  return outputPath;
}

// ---------------------------------------------------------------------------
// JSON Summary
// ---------------------------------------------------------------------------

export function generateJsonSummary(
  analyses: FundAnalysisResult[],
  macroData?: Record<string, unknown> | null,
  newsDigest?: NewsSentiment | null,
  outputPath?: string,
): string {
  const artifactsDir = process.env.ARTIFACTS_DIR ?? "./artifacts";
  if (!outputPath) outputPath = join(artifactsDir, "基金分析结果.json");
  ensureOutputDir(outputPath);

  const payload = {
    generatedAt: new Date().toISOString(),
    newsSentiment: newsDigest?.overallSentiment ?? "UNKNOWN",
    macroIndicatorCount: macroData ? Object.keys(macroData).length : 0,
    totalFunds: analyses.length,
    recommendations: {
      BUY: analyses.filter((a) => a.recommendation === "BUY").length,
      HOLD: analyses.filter((a) => a.recommendation === "HOLD").length,
      REDUCE: analyses.filter((a) => a.recommendation === "REDUCE").length,
      SELL: analyses.filter((a) => a.recommendation === "SELL").length,
    },
    analyses: analyses.map((a) => ({
      fundCode: a.fundCode,
      fundName: a.fundName,
      fundCategory: a.fundCategory,
      compositeScore: a.compositeScore,
      recommendation: a.recommendation,
      sixDimScores: a.sixDimScores,
      fiveDimScreening: a.fiveDimScreening,
      riskWarnings: a.riskWarnings,
      analysisSummary: a.analysisSummary,
      dataQuality: a.dataQuality,
    })),
  };

  writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf-8");
  return outputPath;
}

// ---------------------------------------------------------------------------
// Generate All Reports
// ---------------------------------------------------------------------------

export function generateAllReports(
  analyses: FundAnalysisResult[],
  macroData?: Record<string, unknown> | null,
  newsDigest?: NewsSentiment | null,
): Record<string, string> {
  return {
    markdown: generateMarkdownReport(analyses, macroData, newsDigest),
    csv: generateCsvExport(analyses),
    json: generateJsonSummary(analyses, macroData, newsDigest),
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

interface CliArgs {
  scoresFile?: string;
  outputDir?: string;
}

export function parseArgs(): CliArgs {
  const args = Bun.argv.slice(2);
  const result: CliArgs = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--scores" && args[i + 1]) { result.scoresFile = args[i + 1]; i++; }
    else if (args[i] === "--output-dir" && args[i + 1]) { result.outputDir = args[i + 1]; i++; }
  }
  return result;
}

async function runCli(): Promise<void> {
  const cliArgs = parseArgs();
  if (!cliArgs.scoresFile && !cliArgs.outputDir) return;

  let analyses: FundAnalysisResult[] = [];
  if (cliArgs.scoresFile) {
    if (!existsSync(cliArgs.scoresFile)) {
      console.error(`Scores file not found: ${cliArgs.scoresFile}`);
      process.exit(1);
    }
    try {
      const raw = await import("node:fs").then((m) => m.readFileSync(cliArgs.scoresFile, "utf-8"));
      analyses = JSON.parse(raw);
    } catch (err) {
      const message = err instanceof SyntaxError
        ? `Invalid JSON in scores file: ${cliArgs.scoresFile}`
        : `Failed to read scores file: ${cliArgs.scoresFile} — ${(err as Error).message}`;
      console.error(message);
      process.exit(1);
    }
  }

  if (cliArgs.outputDir) {
    process.env.ARTIFACTS_DIR = cliArgs.outputDir;
  }

  try {
    const paths = generateAllReports(analyses);
    console.log("报告生成完成:");
    console.log(`  Markdown: ${paths.markdown}`);
    console.log(`  CSV: ${paths.csv}`);
    console.log(`  JSON: ${paths.json}`);
  } catch (err) {
    console.error(`Report generation failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

runCli();
