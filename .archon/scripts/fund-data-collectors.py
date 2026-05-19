"""基金量化分析 — 精简数据采集器。

通过 --action 子命令分发，每个函数独立采集并输出 JSON 到 stdout，
供 Archon bash 节点捕获。

用法:
    uv run python .archon/scripts/fund-data-collectors.py --action market
    uv run python .archon/scripts/fund-data-collectors.py --action macro
    uv run python .archon/scripts/fund-data-collectors.py --action news
    uv run python .archon/scripts/fund-data-collectors.py --action fund-list --codes-file <path>
"""

import argparse
import json
import sys
import time


def _check_import(module_name: str, pip_name: str | None = None) -> None:
    try:
        __import__(module_name)
    except ImportError:
        pkg = pip_name or module_name
        print(json.dumps({"error": f"缺少Python包: {pkg}。请运行: uv pip install {pkg}"}), file=sys.stderr)
        sys.exit(1)


def _safe_json_default(obj):
    """处理 datetime / Timestamp / numpy 类型的 JSON 序列化。"""
    try:
        return str(obj)
    except Exception:
        return repr(obj)


# ---------------------------------------------------------------------------
# 市场数据采集
# ---------------------------------------------------------------------------

US_STOCK_SYMBOLS = [
    "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "BRK-B",
    "JPM", "V", "JNJ", "WMT", "PG", "XOM", "UNH", "HD", "BAC", "MA",
    "DIS", "ADBE", "NFLX", "CRM", "AMD", "INTC", "QCOM", "TXN", "AVGO",
]

A_INDEX_CODES = [
    "000001", "399001", "399006", "000688", "000300", "000905", "000852",
]

A_INDEX_NAMES = {
    "000001": "上证指数", "399001": "深证成指", "399006": "创业板指",
    "000688": "科创50", "000300": "沪深300", "000905": "中证500", "000852": "中证1000",
}


def fetch_market_data() -> dict:
    """采集全球市场行情数据。"""
    _check_import("yfinance", "yfinance")
    _check_import("akshare", "akshare")
    import yfinance as yf
    import akshare as ak

    result: dict = {"us_stocks": [], "a_indices": [], "hk_stocks": [], "global_indices": []}

    # 美股
    try:
        tickers = yf.Tickers(" ".join(US_STOCK_SYMBOLS))
        for sym in US_STOCK_SYMBOLS:
            try:
                t = tickers.tickers.get(sym)
                if t is None:
                    continue
                info = t.info or {}
                fast = t.fast_info or {}
                result["us_stocks"].append({
                    "symbol": sym,
                    "name": info.get("longName", info.get("shortName", "")),
                    "market": "US",
                    "latest_price": float(fast.get("last_price", 0) or info.get("regularMarketPrice", 0) or 0),
                    "change_pct": float(info.get("regularMarketChangePercent", 0) or 0),
                    "pe_ratio": float(info.get("trailingPE", 0) or 0),
                    "pb_ratio": float(info.get("priceToBook", 0) or 0),
                    "volume": float(info.get("regularMarketVolume", 0) or 0),
                })
            except Exception:
                pass
    except Exception as exc:
        result["_errors"] = result.get("_errors", [])
        result["_errors"].append(f"美股采集失败: {exc}")

    # A股指数
    try:
        df = ak.stock_zh_index_spot_em()
        if df is not None and not df.empty:
            for _, row in df.iterrows():
                code = str(row.get("代码", ""))
                if code in A_INDEX_CODES:
                    result["a_indices"].append({
                        "symbol": code,
                        "name": A_INDEX_NAMES.get(code, row.get("名称", "")),
                        "latest_price": float(row.get("最新价", 0) or 0),
                        "change_pct": float(row.get("涨跌幅", 0) or 0),
                        "change_amount": float(row.get("涨跌额", 0) or 0),
                        "volume": float(row.get("成交量", 0) or 0),
                        "amount": float(row.get("成交额", 0) or 0),
                    })
    except Exception as exc:
        result.setdefault("_errors", []).append(f"A股指数采集失败: {exc}")

    # 港股
    try:
        df = ak.stock_hk_famous_spot_em()
        if df is not None and not df.empty:
            for _, row in df.iterrows():
                result["hk_stocks"].append({
                    "symbol": str(row.get("代码", "")),
                    "name": str(row.get("名称", "")),
                    "market": "HK",
                    "latest_price": float(row.get("最新价", 0) or 0),
                    "change_pct": float(row.get("涨跌幅", 0) or 0),
                    "change_amount": float(row.get("涨跌额", 0) or 0),
                    "volume": float(row.get("成交量", 0) or 0),
                    "amount": float(row.get("成交额", 0) or 0),
                })
    except Exception as exc:
        result.setdefault("_errors", []).append(f"港股采集失败: {exc}")

    # 全球指数
    try:
        df = ak.index_global_spot_em()
        if df is not None and not df.empty:
            for _, row in df.iterrows():
                result["global_indices"].append({
                    "symbol": str(row.get("代码", "")),
                    "name": str(row.get("名称", "")),
                    "latest_price": float(row.get("最新价", 0) or 0),
                    "change_pct": float(row.get("涨跌幅", 0) or 0),
                })
    except Exception as exc:
        result.setdefault("_errors", []).append(f"全球指数采集失败: {exc}")

    return result


# ---------------------------------------------------------------------------
# 宏观数据采集 (精简版 — 仅用 akshare 公开函数)
# ---------------------------------------------------------------------------

MACRO_FETCHERS: list[tuple[str, str]] = [
    ("PMI_MANUFACTURING", "ak.macro_china_pmi"),
    ("PMI_NON_MANUFACTURING", "ak.macro_china_non_man_pmi"),
    ("CPI_YOY", "ak.macro_china_cpi_yearly"),
    ("CPI_MOM", "ak.macro_china_cpi_monthly"),
    ("PPI_YOY", "ak.macro_china_ppi_yearly"),
    ("GDP_YOY", "ak.macro_china_gdp_yearly"),
    ("M2_YOY", "ak.macro_china_money_supply"),
    ("LPR", "ak.macro_china_lpr"),
    ("SHIBOR", "ak.macro_china_shibor_all"),
    ("RMB_USD", "ak.macro_china_rmb"),
    ("TRADE_BALANCE", "ak.macro_china_trade_balance"),
    ("FX_GOLD_RESERVE", "ak.macro_china_fx_gold"),
    ("USA_CPI_YOY", "ak.macro_usa_cpi_yoy"),
    ("USA_PMI", "ak.macro_usa_pmi"),
    ("USA_UNEMPLOYMENT", "ak.macro_usa_unemployment_rate"),
    ("USA_GDP", "ak.macro_usa_gdp_monthly"),
    ("USA_TRADE", "ak.macro_usa_trade_balance"),
    ("USA_RETAIL", "ak.macro_usa_retail_sales"),
    ("USA_NON_FARM", "ak.macro_usa_non_farm"),
    ("USA_CONSUMER", "ak.macro_usa_cb_consumer_confidence"),
    ("BDI", "ak.macro_shipping_bdi"),
    ("GOLD_SPOT", "ak.macro_cons_gold"),
    ("SILVER_SPOT", "ak.macro_cons_silver"),
    ("GOLD_SGE", "ak.spot_golden_benchmark_sge"),
    ("CN_US_SPREAD", "ak.bond_zh_us_rate"),
    ("GLOBAL_INDEX", "ak.index_global_spot_em"),
]


def fetch_macro_indicators() -> dict:
    """采集所有宏观指标。"""
    _check_import("akshare", "akshare")
    import akshare as ak

    results: dict = {}
    errors: list[str] = []

    for indicator_name, func_ref in MACRO_FETCHERS:
        try:
            func = eval(func_ref, {"ak": ak})
            data = func()
            if data is None:
                errors.append(f"指标 {indicator_name} 返回 None")
                continue
            if hasattr(data, "to_dict"):
                temp = data.to_dict(orient="records")
            elif isinstance(data, (list, dict)):
                temp = data
            else:
                temp = str(data)
            results[indicator_name] = temp
        except Exception as exc:
            errors.append(f"指标 {indicator_name} 采集失败: {exc}")

        time.sleep(1.0)  # akshare 请求节流

    results["_errors"] = errors
    results["_success_count"] = sum(1 for v in results.values() if not isinstance(v, list) or v)
    results["_total"] = len(MACRO_FETCHERS)
    return results


# ---------------------------------------------------------------------------
# 新闻数据采集
# ---------------------------------------------------------------------------

NEWS_SOURCES = {
    "baidu": "stock_zh_a_alerts_cls",
    "eastmoney": "stock_info_global_em",
    "cctv": "stock_zh_a_alerts_cls",
}


def fetch_news_feed() -> dict:
    """采集财经新闻信息流。"""
    _check_import("akshare", "akshare")
    import akshare as ak

    items: list[dict] = []
    errors: list[str] = []

    # akshare 主要新闻接口 — stock_info_global_em
    try:
        df = ak.stock_info_global_em()
        if df is not None and not df.empty:
            for _, row in df.head(30).iterrows():
                items.append({
                    "title": str(row.get("标题", row.get("title", ""))),
                    "source": row.get("来源", row.get("source", "eastmoney")),
                    "url": row.get("链接", row.get("url", "")),
                    "publish_time": str(row.get("发布时间", row.get("publish_time", ""))),
                    "summary": str(row.get("摘要", row.get("summary", "")))[:200],
                })
    except Exception as exc:
        errors.append(f"新闻接口采集失败: {exc}")

    return {"items": items, "_errors": errors, "_total": len(items)}


# ---------------------------------------------------------------------------
# 基金列表加载
# ---------------------------------------------------------------------------


def load_fund_list(codes_file: str | None = None) -> dict:
    """加载基金代码列表。

    优先从 codes_file（每行一个代码，格式：`代码 名称` 或 `代码,名称`），
    回退到 ~/Data_share/基金分析/基金持仓数据.csv 的代码列。
    """
    import os
    import csv

    funds: list[dict] = []

    if codes_file and os.path.exists(codes_file):
        with open(codes_file, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.replace(",", " ").split(None, 1)
                code = parts[0].strip()
                name = parts[1].strip() if len(parts) > 1 else ""
                if code:
                    funds.append({"code": code, "name": name, "category": ""})
    else:
        fallback_path = os.path.expanduser("~/Data_share/基金分析/基金持仓数据.csv")
        if os.path.exists(fallback_path):
            with open(fallback_path, newline="", encoding="utf-8-sig") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    code = row.get("基金代码", row.get("code", "")).strip()
                    name = row.get("基金名称", row.get("name", ""))
                    category = row.get("分类", row.get("category", ""))
                    if code:
                        funds.append({"code": code, "name": name or "", "category": category or ""})

    return {"funds": funds, "_total": len(funds)}


# ---------------------------------------------------------------------------
# CLI 入口
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description="基金量化分析数据采集器")
    parser.add_argument("--action", required=True, choices=["market", "macro", "news", "fund-list"])
    parser.add_argument("--codes-file", help="基金代码文件路径 (仅 fund-list)")
    args = parser.parse_args()

    result: dict = {}

    try:
        if args.action == "market":
            result = fetch_market_data()
        elif args.action == "macro":
            result = fetch_macro_indicators()
        elif args.action == "news":
            result = fetch_news_feed()
        elif args.action == "fund-list":
            result = load_fund_list(args.codes_file)
    except SystemExit:
        raise
    except Exception as exc:
        result = {"_error": str(exc), "_action": args.action}
        print(json.dumps(result, ensure_ascii=False, default=_safe_json_default))
        sys.exit(1)

    print(json.dumps(result, ensure_ascii=False, default=_safe_json_default))


if __name__ == "__main__":
    main()
