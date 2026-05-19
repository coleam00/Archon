import { afterEach, describe, expect, it } from "bun:test";
import {
  analyzeFund,
  analyzeFunds,
  computeComposite,
  evaluateCapitalEfficiency,
  evaluateFcfQuality,
  evaluateGrowth,
  evaluateMacroRisk,
  evaluateShareholderReturn,
  evaluateValuationSafety,
  parseCliArgs,
  screenFundamentalQualitative,
  screenHoldingPenetration,
  screenManagerEvaluation,
  screenMarketTechnical,
  screenPerformanceRiskQuant,
} from "./fund-score-engine";

// ---------------------------------------------------------------------------
// Six-Dim Scoring
// ---------------------------------------------------------------------------

describe("evaluateFcfQuality", () => {
  it("with valid FCF data returns score in [0, 10]", () => {
    const result = evaluateFcfQuality({
      fcfData: [
        { fcfToRevenue: 0.2 },
        { fcfToRevenue: 0.15 },
        { fcfToRevenue: 0.18 },
      ],
    });
    expect(result.score).not.toBeNull();
    expect(result.score!).toBeGreaterThanOrEqual(0);
    expect(result.score!).toBeLessThanOrEqual(10);
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("with no data returns null score", () => {
    const result = evaluateFcfQuality(null);
    expect(result.score).toBeNull();
  });

  it("with empty FCF array returns null score", () => {
    const result = evaluateFcfQuality({ fcfData: [] });
    expect(result.score).toBeNull();
  });

  it("with missing fcfToRevenue fields returns null", () => {
    const result = evaluateFcfQuality({
      fcfData: [{}, {}],
    });
    expect(result.score).toBeNull();
  });
});

describe("evaluateCapitalEfficiency", () => {
  it("with valid ROE/ROIC data returns score in [0, 10]", () => {
    const result = evaluateCapitalEfficiency({
      efficiencyData: [
        { roe: 0.18, roic: 0.14, assetTurnover: 0.8 },
        { roe: 0.22, roic: 0.16, assetTurnover: 0.6 },
      ],
    });
    expect(result.score).not.toBeNull();
    expect(result.score!).toBeGreaterThanOrEqual(0);
    expect(result.score!).toBeLessThanOrEqual(10);
  });

  it("with no data returns null", () => {
    const result = evaluateCapitalEfficiency(null);
    expect(result.score).toBeNull();
  });
});

describe("evaluateShareholderReturn", () => {
  it("with valid dividend data returns score in [0, 10]", () => {
    const result = evaluateShareholderReturn({
      dividendData: [
        { dividendYield: 0.03, payoutRatio: 0.35 },
        { dividendYield: 0.04, payoutRatio: 0.3 },
      ],
    });
    expect(result.score).not.toBeNull();
    expect(result.score!).toBeGreaterThanOrEqual(0);
    expect(result.score!).toBeLessThanOrEqual(10);
  });

  it("with no data returns null", () => {
    const result = evaluateShareholderReturn(null);
    expect(result.score).toBeNull();
  });
});

describe("evaluateValuationSafety", () => {
  it("with PE/PB/PEG data returns score in [0, 10]", () => {
    const result = evaluateValuationSafety({
      valuationData: [{ peRatio: 20, pbRatio: 2.5, peg: 1.0 }],
    });
    expect(result.score).not.toBeNull();
    expect(result.score!).toBeGreaterThanOrEqual(0);
    expect(result.score!).toBeLessThanOrEqual(10);
  });

  it("with no data returns null", () => {
    const result = evaluateValuationSafety(null);
    expect(result.score).toBeNull();
  });

  it("very low PE gives high safety score", () => {
    const result = evaluateValuationSafety({
      valuationData: [{ peRatio: 8, pbRatio: 1.0, peg: 0.5 }],
    });
    expect(result.score).not.toBeNull();
    expect(result.score!).toBeGreaterThan(7);
  });
});

describe("evaluateGrowth", () => {
  it("with valid growth data returns score in [0, 10]", () => {
    const result = evaluateGrowth({
      growthData: [{ revenueGrowth: 0.2, earningsGrowth: 0.25 }],
    });
    expect(result.score).not.toBeNull();
    expect(result.score!).toBeGreaterThanOrEqual(0);
    expect(result.score!).toBeLessThanOrEqual(10);
  });

  it("with no data returns null", () => {
    const result = evaluateGrowth(null);
    expect(result.score).toBeNull();
  });
});

describe("evaluateMacroRisk", () => {
  it("without news or macro returns baseline ~5", () => {
    const result = evaluateMacroRisk("偏股");
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(10);
  });

  it("bond fund gets higher score (lower risk)", () => {
    const equity = evaluateMacroRisk("偏股");
    const bond = evaluateMacroRisk("纯债");
    expect(bond.score).toBeGreaterThan(equity.score);
  });

  it("negative news reduces score", () => {
    const base = evaluateMacroRisk("股票");
    const withNews = evaluateMacroRisk("股票", { overallSentiment: "NEGATIVE" });
    expect(withNews.score).toBeLessThan(base.score);
  });

  it("positive news increases score", () => {
    const base = evaluateMacroRisk("股票");
    const withNews = evaluateMacroRisk("股票", { overallSentiment: "POSITIVE" });
    expect(withNews.score).toBeGreaterThan(base.score);
  });
});

// ---------------------------------------------------------------------------
// Five-Dim Screening
// ---------------------------------------------------------------------------

describe("screenFundamentalQualitative", () => {
  it("PASS with healthy fund", () => {
    expect(screenFundamentalQualitative({ fundSize: 10, ageYears: 5 })).toBe("PASS");
  });

  it("WARN with small fund", () => {
    expect(screenFundamentalQualitative({ fundSize: 0.3, ageYears: 5 })).toBe("WARN");
  });

  it("FAIL with small and young fund", () => {
    expect(screenFundamentalQualitative({ fundSize: 0.3, ageYears: 0.5 })).toBe("FAIL");
  });

  it("PASS when null", () => {
    expect(screenFundamentalQualitative(null)).toBe("PASS");
  });
});

describe("screenPerformanceRiskQuant", () => {
  it("PASS with good performance", () => {
    expect(screenPerformanceRiskQuant({ sharpeRatio: 1.5, maxDrawdown: 0.1, volatility: 0.12 })).toBe("PASS");
  });

  it("WARN with negative sharpe", () => {
    expect(screenPerformanceRiskQuant({ sharpeRatio: -0.5, maxDrawdown: 0.2, volatility: 0.15 })).toBe("WARN");
  });

  it("FAIL with extreme drawdown", () => {
    expect(screenPerformanceRiskQuant({ sharpeRatio: 0.5, maxDrawdown: 0.4, volatility: 0.25 })).toBe("FAIL");
  });

  it("PASS when null", () => {
    expect(screenPerformanceRiskQuant(null)).toBe("PASS");
  });
});

describe("screenHoldingPenetration", () => {
  it("PASS with diversified holdings", () => {
    expect(screenHoldingPenetration({ top10Concentration: 0.3, sectorCount: 6 })).toBe("PASS");
  });

  it("WARN with moderate concentration", () => {
    expect(screenHoldingPenetration({ top10Concentration: 0.55, sectorCount: 5 })).toBe("WARN");
  });

  it("FAIL with high concentration", () => {
    expect(screenHoldingPenetration({ top10Concentration: 0.7, sectorCount: 2 })).toBe("FAIL");
  });

  it("PASS when null", () => {
    expect(screenHoldingPenetration(null)).toBe("PASS");
  });
});

describe("screenManagerEvaluation", () => {
  it("PASS with experienced manager", () => {
    expect(screenManagerEvaluation({ experienceYears: 8, managedFunds: 2 })).toBe("PASS");
  });

  it("FAIL with inexperienced manager", () => {
    expect(screenManagerEvaluation({ experienceYears: 1, managedFunds: 1 })).toBe("FAIL");
  });

  it("PASS when null", () => {
    expect(screenManagerEvaluation(null)).toBe("PASS");
  });
});

describe("screenMarketTechnical", () => {
  it("PASS with positive relative strength", () => {
    expect(screenMarketTechnical({ relativeStrength: 0.1 })).toBe("PASS");
  });

  it("WARN with weak relative strength", () => {
    expect(screenMarketTechnical({ relativeStrength: -0.1 })).toBe("WARN");
  });

  it("FAIL with very negative relative strength", () => {
    expect(screenMarketTechnical({ relativeStrength: -0.2 })).toBe("FAIL");
  });

  it("PASS when null", () => {
    expect(screenMarketTechnical(null)).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// Composite Score
// ---------------------------------------------------------------------------

describe("computeComposite", () => {
  it("normalizes with partial null scores", () => {
    const score = computeComposite({
      fcfQuality: 8,
      capitalEfficiency: null,
      shareholderReturn: 7,
      valuationSafety: null,
      growth: 6,
      macroGeopolitical: 5,
    });
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(10);
  });

  it("all nulls (except macro) still returns a number", () => {
    const score = computeComposite({
      fcfQuality: null,
      capitalEfficiency: null,
      shareholderReturn: null,
      valuationSafety: null,
      growth: null,
      macroGeopolitical: 5,
    });
    expect(score).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Full analyzeFund
// ---------------------------------------------------------------------------

describe("analyzeFund", () => {
  it("no data — returns BUY/HOLD/REDUCE/SELL", () => {
    const result = analyzeFund({ code: "001323", name: "测试基金", category: "偏股" });
    expect(result.fundCode).toBe("001323");
    expect(result.fundName).toBe("测试基金");
    expect(result.compositeScore).toBeGreaterThanOrEqual(0);
    expect(result.compositeScore).toBeLessThanOrEqual(10);
    expect(["BUY", "HOLD", "REDUCE", "SELL"]).toContain(result.recommendation);
  });

  it("full high-quality data → BUY or HOLD", () => {
    const result = analyzeFund(
      { code: "001323", name: "测试基金", category: "偏股" },
      {
        fcfData: [{ fcfToRevenue: 0.18 }],
        efficiencyData: [{ roe: 0.2, roic: 0.15, assetTurnover: 0.7 }],
        dividendData: [{ dividendYield: 0.03, payoutRatio: 0.35 }],
        valuationData: [{ peRatio: 18, pbRatio: 2.5, peg: 1.0 }],
        growthData: [{ revenueGrowth: 0.15, earningsGrowth: 0.18 }],
        top10Concentration: 0.35,
        sectorCount: 6,
      },
      { fundSize: 10, ageYears: 5 },
      { sharpeRatio: 1.2, maxDrawdown: 0.12, volatility: 0.16 },
      { experienceYears: 8, managedFunds: 3 },
    );
    expect(result.compositeScore).toBeGreaterThanOrEqual(7);
    expect(["BUY", "HOLD"]).toContain(result.recommendation);
    expect(result.riskWarnings.length).toBe(0);
  });

  it("weak fund → REDUCE or SELL", () => {
    const result = analyzeFund(
      { code: "999999", name: "高风险基金", category: "偏股" },
      undefined,
      { fundSize: 0.2, ageYears: 0.5 },
      { sharpeRatio: -0.5, maxDrawdown: 0.45, volatility: 0.35 },
    );
    expect(["SELL", "REDUCE"]).toContain(result.recommendation);
    expect(result.riskWarnings.length).toBeGreaterThan(0);
  });
});

describe("analyzeFunds", () => {
  it("analyzes multiple funds", () => {
    const results = analyzeFunds([
      { code: "001", name: "基金A", category: "偏股" },
      { code: "002", name: "基金B", category: "纯债" },
    ]);
    expect(results.length).toBe(2);
    expect(results[0].fundCode).toBe("001");
    expect(results[1].fundCode).toBe("002");
  });
});

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

describe("parseCliArgs", () => {
  const saved = [...Bun.argv];

  afterEach(() => {
    Bun.argv = saved;
  });

  it("parses --funds-file", () => {
    Bun.argv = ["bun", "script.ts", "--funds-file", "funds.json"];
    const args = parseCliArgs();
    expect(args.fundsFile).toBe("funds.json");
  });

  it("parses --holdings-file", () => {
    Bun.argv = ["bun", "script.ts", "--holdings-file", "holdings.json"];
    const args = parseCliArgs();
    expect(args.holdingsFile).toBe("holdings.json");
  });

  it("parses --output", () => {
    Bun.argv = ["bun", "script.ts", "--output", "results.json"];
    const args = parseCliArgs();
    expect(args.output).toBe("results.json");
  });

  it("parses multiple args together", () => {
    Bun.argv = ["bun", "script.ts", "--funds-file", "f.json", "--macro-file", "m.json", "--output", "o.json"];
    const args = parseCliArgs();
    expect(args.fundsFile).toBe("f.json");
    expect(args.macroFile).toBe("m.json");
    expect(args.output).toBe("o.json");
  });

  it("returns empty object when no args", () => {
    Bun.argv = ["bun", "script.ts"];
    const args = parseCliArgs();
    expect(args.fundsFile).toBeUndefined();
    expect(args.output).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Extended evaluateMacroRisk tests
// ---------------------------------------------------------------------------

describe("evaluateMacroRisk extended", () => {
  it("MIXED sentiment reduces score slightly", () => {
    const base = evaluateMacroRisk("股票");
    const mixed = evaluateMacroRisk("股票", { overallSentiment: "MIXED" });
    expect(mixed.score).toBeLessThan(base.score);
  });

  it("gold spot > 2% reduces score (risk-off signal)", () => {
    const base = evaluateMacroRisk("股票");
    const withGold = evaluateMacroRisk("股票", null, {
      GOLD_SPOT: [{ 涨跌幅: 3.0 }],
    });
    expect(withGold.score).toBeLessThan(base.score);
  });

  it("gold spot ≤ 2% does not reduce score", () => {
    const base = evaluateMacroRisk("股票");
    const withGold = evaluateMacroRisk("股票", null, {
      GOLD_SPOT: [{ 涨跌幅: 1.5 }],
    });
    expect(withGold.score).toBe(base.score);
  });

  it("empty gold array does not crash", () => {
    const result = evaluateMacroRisk("股票", null, { GOLD_SPOT: [] });
    expect(result.score).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// WARN boundary condition tests
// ---------------------------------------------------------------------------

describe("screenPerformanceRiskQuant boundaries", () => {
  it("WARN when drawdown > 0.25", () => {
    expect(screenPerformanceRiskQuant({ sharpeRatio: 0.5, maxDrawdown: 0.3, volatility: 0.15 })).toBe("WARN");
  });

  it("WARN when volatility > 0.3", () => {
    expect(screenPerformanceRiskQuant({ sharpeRatio: 0.5, maxDrawdown: 0.1, volatility: 0.35 })).toBe("WARN");
  });
});

describe("screenHoldingPenetration boundaries", () => {
  it("WARN when top10 > 0.5", () => {
    expect(screenHoldingPenetration({ top10Concentration: 0.55, sectorCount: 5 })).toBe("WARN");
  });

  it("WARN when sectors < 3", () => {
    expect(screenHoldingPenetration({ top10Concentration: 0.3, sectorCount: 2 })).toBe("WARN");
  });
});

describe("screenManagerEvaluation boundaries", () => {
  it("WARN when experience < 3 years", () => {
    expect(screenManagerEvaluation({ experienceYears: 2.5, managedFunds: 2 })).toBe("WARN");
  });

  it("WARN when managing more than 5 funds", () => {
    expect(screenManagerEvaluation({ experienceYears: 8, managedFunds: 6 })).toBe("WARN");
  });
});
