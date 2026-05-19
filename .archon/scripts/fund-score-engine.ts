// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Recommendation = "BUY" | "HOLD" | "REDUCE" | "SELL";
type ScreenResult = "PASS" | "WARN" | "FAIL";

interface SixDimScores {
  fcfQuality: number | null;
  capitalEfficiency: number | null;
  shareholderReturn: number | null;
  valuationSafety: number | null;
  growth: number | null;
  macroGeopolitical: number;
}

interface FiveDimScreening {
  fundamentalQualitative: ScreenResult;
  performanceRiskQuant: ScreenResult;
  holdingPenetration: ScreenResult;
  managerEvaluation: ScreenResult;
  marketTechnical: ScreenResult;
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

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function std(values: number[]): number {
  if (values.length <= 1) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// Default weights
// ---------------------------------------------------------------------------

const DEFAULT_WEIGHTS = {
  fcfQuality: 0.2,
  capitalEfficiency: 0.18,
  shareholderReturn: 0.15,
  valuationSafety: 0.18,
  growth: 0.17,
  macroGeopolitical: 0.12,
};

// ---------------------------------------------------------------------------
// Six-Dimension Scoring Engine
// ---------------------------------------------------------------------------

interface HoldingsData {
  fcfData?: Array<{ fcfToRevenue?: number }>;
  efficiencyData?: Array<{ roe?: number; roic?: number; assetTurnover?: number }>;
  dividendData?: Array<{ dividendYield?: number; payoutRatio?: number }>;
  valuationData?: Array<{ peRatio?: number; pbRatio?: number; peg?: number }>;
  growthData?: Array<{ revenueGrowth?: number; earningsGrowth?: number }>;
  top10Concentration?: number;
  sectorCount?: number;
}

interface FundInfo {
  fundSize?: number;
  ageYears?: number;
}

interface NavHistory {
  sharpeRatio?: number;
  maxDrawdown?: number;
  volatility?: number;
}

interface ManagerInfo {
  experienceYears?: number;
  managedFunds?: number;
}

interface MarketData {
  relativeStrength?: number;
}

interface NewsSentiment {
  overallSentiment: "POSITIVE" | "NEGATIVE" | "NEUTRAL" | "MIXED";
}

interface FundEntry {
  code: string;
  name: string;
  category: string;
}

export function evaluateFcfQuality(
  holdingsData?: HoldingsData | null,
): { score: number | null; reason: string } {
  const fcfData = holdingsData?.fcfData ?? [];

  if (fcfData.length === 0) return { score: null, reason: "持仓FCF数据不可用" };

  const ratios = fcfData
    .map((d) => d.fcfToRevenue ?? null)
    .filter((v): v is number => v !== null);

  if (ratios.length === 0) return { score: null, reason: "无有效FCF数据" };

  const avgRatio = mean(ratios);
  const stdRatio = ratios.length > 1 ? std(ratios) : 0;

  const ratioScore = clamp(avgRatio * 50 + 3, 0, 10);
  const stabilityScore = clamp(10 - stdRatio * 40, 0, 10);

  const score = round(ratioScore * 0.6 + stabilityScore * 0.4, 1);
  return { score, reason: `平均FCF/营收比: ${avgRatio.toFixed(3)}, 稳定性评分: ${stabilityScore.toFixed(1)}` };
}

export function evaluateCapitalEfficiency(
  holdingsData?: HoldingsData | null,
): { score: number | null; reason: string } {
  const effData = holdingsData?.efficiencyData ?? [];

  if (effData.length === 0) return { score: null, reason: "资本效率数据不可用" };

  const roeValues = effData.map((d) => d.roe ?? null).filter((v): v is number => v !== null);
  const roicValues = effData.map((d) => d.roic ?? null).filter((v): v is number => v !== null);
  const turnoverValues = effData.map((d) => d.assetTurnover ?? null).filter((v): v is number => v !== null);

  const roeScore = clamp((roeValues.length > 0 ? mean(roeValues) : 0.1) * 50, 0, 10);
  const roicScore = clamp((roicValues.length > 0 ? mean(roicValues) : 0.1) * 50, 0, 10);
  const turnoverScore = clamp((turnoverValues.length > 0 ? mean(turnoverValues) : 0.5) * 5, 0, 10);

  const score = round(roeScore * 0.35 + roicScore * 0.35 + turnoverScore * 0.3, 1);
  return {
    score,
    reason: roeValues.length > 0 ? `ROE: ${(mean(roeValues) * 100).toFixed(1)}%` : "ROE数据缺失",
  };
}

export function evaluateShareholderReturn(
  holdingsData?: HoldingsData | null,
): { score: number | null; reason: string } {
  const divData = holdingsData?.dividendData ?? [];

  if (divData.length === 0) return { score: null, reason: "股息数据不可用" };

  const divYields = divData.map((d) => d.dividendYield ?? null).filter((v): v is number => v !== null);
  const payoutRatios = divData.map((d) => d.payoutRatio ?? null).filter((v): v is number => v !== null);

  const avgYield = divYields.length > 0 ? mean(divYields) : 0.02;
  const yieldScore = clamp(avgYield * 200, 0, 10);

  const avgPayout = payoutRatios.length > 0 ? mean(payoutRatios) : 0.3;
  const payoutScore = clamp(5 + (0.4 - Math.abs(avgPayout - 0.35)) * 20, 0, 10);

  const score = round(yieldScore * 0.5 + payoutScore * 0.5, 1);
  return { score, reason: `平均股息率: ${(avgYield * 100).toFixed(1)}%` };
}

export function evaluateValuationSafety(
  holdingsData?: HoldingsData | null,
): { score: number | null; reason: string } {
  const valData = holdingsData?.valuationData ?? [];

  if (valData.length === 0) return { score: null, reason: "估值数据不可用" };

  const peValues = valData.map((d) => d.peRatio ?? null).filter((v): v is number => v !== null);
  const pbValues = valData.map((d) => d.pbRatio ?? null).filter((v): v is number => v !== null);
  const pegValues = valData.map((d) => d.peg ?? null).filter((v): v is number => v !== null);

  const avgPE = peValues.length > 0 ? mean(peValues) : 20;
  const avgPB = pbValues.length > 0 ? mean(pbValues) : 2;
  const avgPEG = pegValues.length > 0 ? mean(pegValues) : 1.5;

  const peScore = clamp(10 * (25 / Math.max(avgPE, 1)), 0, 10);
  const pbScore = clamp(10 * (3 / Math.max(avgPB, 0.1)), 0, 10);
  const pegScore = clamp(10 * (1.5 / Math.max(avgPEG, 0.1)), 0, 10);

  const score = round(peScore * 0.4 + pbScore * 0.3 + pegScore * 0.3, 1);
  return { score, reason: `平均PE: ${avgPE.toFixed(1)}, PB: ${avgPB.toFixed(1)}, PEG: ${avgPEG.toFixed(2)}` };
}

export function evaluateGrowth(
  holdingsData?: HoldingsData | null,
): { score: number | null; reason: string } {
  const growthData = holdingsData?.growthData ?? [];

  if (growthData.length === 0) return { score: null, reason: "成长数据不可用" };

  const revGrowth = growthData.map((d) => d.revenueGrowth ?? null).filter((v): v is number => v !== null);
  const earnGrowth = growthData.map((d) => d.earningsGrowth ?? null).filter((v): v is number => v !== null);

  const avgRev = revGrowth.length > 0 ? mean(revGrowth) : 0.1;
  const avgEarn = earnGrowth.length > 0 ? mean(earnGrowth) : 0.1;

  const revScore = clamp(5 + avgRev * 25, 0, 10);
  const earnScore = clamp(5 + avgEarn * 25, 0, 10);

  const score = round(revScore * 0.4 + earnScore * 0.6, 1);
  return { score, reason: `营收增速: ${(avgRev * 100).toFixed(1)}%, 利润增速: ${(avgEarn * 100).toFixed(1)}%` };
}

export function evaluateMacroRisk(
  fundCategory: string,
  newsSentiment?: NewsSentiment | null,
  macroData?: Record<string, unknown> | null,
): { score: number; reason: string } {
  let score = 5.0;
  const reasons: string[] = [];

  const categoryAdjustments: Record<string, number> = {
    "债券": 1.5, "纯债": 2.0, "混债": 1.0, "偏债": 0.5,
    "货币": 2.0, "黄金": 1.5, "商品": 0.5,
    "股票": -1.0, "偏股": -0.5, "指数": 0,
    "QDII": 0.5, "海外": 0.5,
  };

  for (const [cat, adj] of Object.entries(categoryAdjustments)) {
    if (fundCategory.includes(cat)) {
      score += adj;
      reasons.push(`${cat}类别调整: ${adj >= 0 ? "+" : ""}${adj.toFixed(1)}`);
      break;
    }
  }

  if (newsSentiment) {
    if (newsSentiment.overallSentiment === "NEGATIVE") {
      score -= 2.0;
      reasons.push("新闻整体负面: -2.0");
    } else if (newsSentiment.overallSentiment === "POSITIVE") {
      score += 1.0;
      reasons.push("新闻整体正面: +1.0");
    } else if (newsSentiment.overallSentiment === "MIXED") {
      score -= 0.5;
      reasons.push("新闻情绪混合: -0.5");
    }
  }

  // Gold spot check (simplified from Python — uses macro data if available)
  if (macroData) {
    try {
      const gold = macroData["GOLD_SPOT"];
      if (gold && Array.isArray(gold) && gold.length > 0) {
        const last = gold[gold.length - 1] as Record<string, unknown>;
        const goldPct = typeof last["涨跌幅"] === "number" ? last["涨跌幅"] : 0;
        if (goldPct > 2) {
          score -= 1.0;
          reasons.push("金价大涨(避险情绪): -1.0");
        }
      }
    } catch {
      // ignore
    }
  }

  score = clamp(score, 0, 10);
  const reasonStr = reasons.length > 0 ? reasons.join("; ") : "基准评分";
  return { score: round(score, 1), reason: reasonStr };
}

// ---------------------------------------------------------------------------
// Five-Dimension Screening
// ---------------------------------------------------------------------------

export function screenFundamentalQualitative(fundInfo?: FundInfo | null): ScreenResult {
  if (!fundInfo) return "PASS";
  const warnings: string[] = [];
  if ((fundInfo.fundSize ?? 10) < 0.5) warnings.push("基金规模过小 (<0.5亿)");
  if ((fundInfo.ageYears ?? 10) < 1) warnings.push("成立不足1年");
  if (warnings.length >= 2) return "FAIL";
  if (warnings.length > 0) return "WARN";
  return "PASS";
}

export function screenPerformanceRiskQuant(navHistory?: NavHistory | null): ScreenResult {
  if (!navHistory) return "PASS";
  const sharpe = navHistory.sharpeRatio ?? 1.0;
  const maxDrawdown = navHistory.maxDrawdown ?? 0.1;

  if (maxDrawdown > 0.35) return "FAIL";
  if (sharpe < 0 || maxDrawdown > 0.25) return "WARN";
  if ((navHistory.volatility ?? 0.15) > 0.3) return "WARN";
  return "PASS";
}

export function screenHoldingPenetration(holdingsData?: HoldingsData | null): ScreenResult {
  if (!holdingsData) return "PASS";
  const top10 = holdingsData.top10Concentration ?? 0.4;
  const sectors = holdingsData.sectorCount ?? 5;

  if (top10 > 0.65) return "FAIL";
  if (top10 > 0.5 || sectors < 3) return "WARN";
  return "PASS";
}

export function screenManagerEvaluation(managerInfo?: ManagerInfo | null): ScreenResult {
  if (!managerInfo) return "PASS";
  const years = managerInfo.experienceYears ?? 5;
  if (years < 2) return "FAIL";
  if (years < 3 || (managerInfo.managedFunds ?? 3) > 5) return "WARN";
  return "PASS";
}

export function screenMarketTechnical(marketData?: MarketData | null): ScreenResult {
  if (!marketData) return "PASS";
  const rs = marketData.relativeStrength ?? 0;
  if (rs < -0.15) return "FAIL";
  if (rs < -0.05) return "WARN";
  return "PASS";
}

// ---------------------------------------------------------------------------
// Score Computing
// ---------------------------------------------------------------------------

export function computeComposite(
  scores: SixDimScores,
  weights: typeof DEFAULT_WEIGHTS = DEFAULT_WEIGHTS,
): number {
  let weightedSum = 0;
  let usedWeight = 0;

  const dims: Array<{ key: keyof SixDimScores; w: number }> = [
    { key: "fcfQuality", w: weights.fcfQuality },
    { key: "capitalEfficiency", w: weights.capitalEfficiency },
    { key: "shareholderReturn", w: weights.shareholderReturn },
    { key: "valuationSafety", w: weights.valuationSafety },
    { key: "growth", w: weights.growth },
    { key: "macroGeopolitical", w: weights.macroGeopolitical },
  ];

  for (const { key, w } of dims) {
    const val = scores[key];
    if (val !== null) {
      weightedSum += val * w;
      usedWeight += w;
    }
  }

  if (usedWeight === 0) return 5.0; // default midpoint
  return round(weightedSum / usedWeight, 1);
}

// ---------------------------------------------------------------------------
// Screening helpers
// ---------------------------------------------------------------------------

function passCount(screening: FiveDimScreening): number {
  return Object.values(screening).filter((s) => s === "PASS").length;
}

function warnCount(screening: FiveDimScreening): number {
  return Object.values(screening).filter((s) => s === "WARN").length;
}

function failCount(screening: FiveDimScreening): number {
  return Object.values(screening).filter((s) => s === "FAIL").length;
}

// ---------------------------------------------------------------------------
// Main analyzeFund
// ---------------------------------------------------------------------------

function determineRecommendation(composite: number, fails: number): Recommendation {
  if (composite >= 7.5 && fails === 0) return "BUY";
  if (composite >= 6.0 && fails <= 1) return "HOLD";
  if (composite >= 4.0) return "REDUCE";
  return "SELL";
}

export function analyzeFund(
  fund: FundEntry,
  holdingsData?: HoldingsData | null,
  fundInfo?: FundInfo | null,
  navHistory?: NavHistory | null,
  managerInfo?: ManagerInfo | null,
  marketData?: MarketData | null,
  macroData?: Record<string, unknown> | null,
  newsSentiment?: NewsSentiment | null,
): FundAnalysisResult {
  const riskWarnings: string[] = [];

  const fcf = evaluateFcfQuality(holdingsData);
  const eff = evaluateCapitalEfficiency(holdingsData);
  const share = evaluateShareholderReturn(holdingsData);
  const val = evaluateValuationSafety(holdingsData);
  const growth = evaluateGrowth(holdingsData);
  const macro = evaluateMacroRisk(fund.category, newsSentiment, macroData);

  const scores: SixDimScores = {
    fcfQuality: fcf.score,
    capitalEfficiency: eff.score,
    shareholderReturn: share.score,
    valuationSafety: val.score,
    growth: growth.score,
    macroGeopolitical: macro.score,
  };

  const screening: FiveDimScreening = {
    fundamentalQualitative: screenFundamentalQualitative(fundInfo),
    performanceRiskQuant: screenPerformanceRiskQuant(navHistory),
    holdingPenetration: screenHoldingPenetration(holdingsData),
    managerEvaluation: screenManagerEvaluation(managerInfo),
    marketTechnical: screenMarketTechnical(marketData),
  };

  const composite = computeComposite(scores);

  const fails = failCount(screening);
  const warns = warnCount(screening);
  const passes = passCount(screening);

  if (fcf.score !== null && fcf.score < 3.0) riskWarnings.push(`FCF质量评分过低 (${fcf.score.toFixed(1)}/10)`);
  if (eff.score !== null && eff.score < 3.0) riskWarnings.push(`资本效率评分过低 (${eff.score.toFixed(1)}/10)`);
  if (val.score !== null && val.score < 3.0) riskWarnings.push(`估值安全边际不足 (${val.score.toFixed(1)}/10)`);
  if (macro.score < 3.0) riskWarnings.push(`宏观地缘风险较高 (${macro.score.toFixed(1)}/10)`);
  if (fails > 0) riskWarnings.push(`五维筛选 ${fails} 项未通过`);
  if (warns > 0) riskWarnings.push(`五维筛选 ${warns} 项警告`);

  const recommendation = determineRecommendation(composite, fails);

  const summaryParts = [
    `六维综合评分: ${composite.toFixed(1)}/10 (${recommendation})`,
    `FCF质量: ${fcf.score !== null ? fcf.score.toFixed(1) : "N/A"} (${fcf.reason})`,
    `资本效率: ${eff.score !== null ? eff.score.toFixed(1) : "N/A"} (${eff.reason})`,
    `股东回报: ${share.score !== null ? share.score.toFixed(1) : "N/A"} (${share.reason})`,
    `估值安全: ${val.score !== null ? val.score.toFixed(1) : "N/A"} (${val.reason})`,
    `成长性: ${growth.score !== null ? growth.score.toFixed(1) : "N/A"} (${growth.reason})`,
    `宏观风险: ${macro.score.toFixed(1)} (${macro.reason})`,
    `五维筛选: ${passes}P/${warns}W/${fails}F`,
  ];

  const availableCount = [holdingsData, fundInfo, navHistory, managerInfo, marketData, macroData, newsSentiment]
    .filter(Boolean).length;
  const dataQuality = clamp(0.3 + 0.1 * availableCount, 0, 1);

  return {
    fundCode: fund.code,
    fundName: fund.name,
    fundCategory: fund.category,
    sixDimScores: scores,
    fiveDimScreening: screening,
    compositeScore: composite,
    recommendation,
    riskWarnings,
    analysisSummary: summaryParts.join("\n"),
    dataQuality: round(dataQuality, 2),
  };
}

export function analyzeFunds(
  funds: FundEntry[],
  holdingsData?: HoldingsData | null,
  fundInfo?: FundInfo | null,
  navHistory?: NavHistory | null,
  managerInfo?: ManagerInfo | null,
  marketData?: MarketData | null,
  macroData?: Record<string, unknown> | null,
  newsSentiment?: NewsSentiment | null,
): FundAnalysisResult[] {
  return funds.map((f) =>
    analyzeFund(f, holdingsData, fundInfo, navHistory, managerInfo, marketData, macroData, newsSentiment),
  );
}

// ---------------------------------------------------------------------------
// CLI entry point (for script: node execution)
// ---------------------------------------------------------------------------

interface CliArgs {
  fundsFile?: string;
  holdingsFile?: string;
  macroFile?: string;
  newsFile?: string;
  output?: string;
}

function parseCliArgs(): CliArgs {
  const args = Bun.argv.slice(2);
  const result: CliArgs = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const val = args[i + 1];
    if (arg === "--funds-file") { result.fundsFile = val; i++; }
    else if (arg === "--holdings-file") { result.holdingsFile = val; i++; }
    else if (arg === "--macro-file") { result.macroFile = val; i++; }
    else if (arg === "--news-file") { result.newsFile = val; i++; }
    else if (arg === "--output") { result.output = val; i++; }
  }
  return result;
}

// Execute if run directly
const cliArgs = parseCliArgs();
if (cliArgs.fundsFile || cliArgs.output) {
  const fs = await import("node:fs");

  let funds: FundEntry[] = [];
  if (cliArgs.fundsFile && fs.existsSync(cliArgs.fundsFile)) {
    const raw = JSON.parse(fs.readFileSync(cliArgs.fundsFile, "utf-8"));
    funds = raw.funds ?? raw ?? [];
  }

  let holdingsData: HoldingsData | null = null;
  if (cliArgs.holdingsFile && fs.existsSync(cliArgs.holdingsFile)) {
    holdingsData = JSON.parse(fs.readFileSync(cliArgs.holdingsFile, "utf-8"));
  }

  let macroData: Record<string, unknown> | null = null;
  if (cliArgs.macroFile && fs.existsSync(cliArgs.macroFile)) {
    macroData = JSON.parse(fs.readFileSync(cliArgs.macroFile, "utf-8"));
  }

  let newsSentiment: NewsSentiment | null = null;
  if (cliArgs.newsFile && fs.existsSync(cliArgs.newsFile)) {
    const newsRaw = JSON.parse(fs.readFileSync(cliArgs.newsFile, "utf-8"));
    newsSentiment = newsRaw.overall_sentiment
      ? { overallSentiment: newsRaw.overall_sentiment }
      : null;
  }

  const results = analyzeFunds(funds, holdingsData, null, null, null, null, macroData, newsSentiment);

  if (cliArgs.output) {
    const outDir = cliArgs.output.substring(0, cliArgs.output.lastIndexOf("/"));
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(cliArgs.output, JSON.stringify(results, null, 2), "utf-8");
  }

  const buyCount = results.filter((r) => r.recommendation === "BUY").length;
  const holdCount = results.filter((r) => r.recommendation === "HOLD").length;
  const reduceCount = results.filter((r) => r.recommendation === "REDUCE").length;
  const sellCount = results.filter((r) => r.recommendation === "SELL").length;

  const sorted = results.toSorted((a, b) => b.compositeScore - a.compositeScore);
  const top3 = sorted.slice(0, 3).map((r) => `${r.fundName}(${r.fundCode}): ${r.compositeScore}`);
  const bottom3 = sorted.slice(-3).map((r) => `${r.fundName}(${r.fundCode}): ${r.compositeScore}`);

  console.log("评分引擎执行完成:");
  console.log(`  总计: ${results.length} 只基金`);
  console.log(`  买入: ${buyCount}, 持有: ${holdCount}, 减仓: ${reduceCount}, 卖出: ${sellCount}`);
  console.log(`  Top 3: ${top3.join(", ")}`);
  console.log(`  Bottom 3: ${bottom3.join(", ")}`);
}
