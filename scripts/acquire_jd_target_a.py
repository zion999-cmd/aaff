#!/usr/bin/env python3
"""
JD 商智 交易经营数据 (Target A) — COMPLETE acquisition via SPA route interception.

Strategy:
  1. Open tradeSummary page in browser (SPA fires getSummary/getTrend/etc. on load)
  2. page.route() intercepts the requests and rewrites the date range to d30
  3. Capture every response (full body)
  4. For trend/brand/category, also walk by manually triggering via UI clicks
"""
import asyncio
import json
import sys
import time
from pathlib import Path
from datetime import datetime, timedelta

OUT_DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("data/jd_acquisition_test")
SHOP_ID = "11855009"
DAYS = 30

ENDPOINTS = [
    "getSummary", "getTrend", "getBrandTable", "getCateTable",
]


async def main():
    from playwright.async_api import async_playwright

    today = datetime.now().date()
    end_date = today - timedelta(days=1)
    start_date = end_date - timedelta(days=DAYS - 1)
    p_start = start_date - timedelta(days=DAYS)
    p_end = start_date - timedelta(days=1)

    print(f"[+] Date range:    {start_date} → {end_date}")
    print(f"[+] Compare range: {p_start} → {p_end}")

    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp("http://127.0.0.1:9222")
        page = await browser.contexts[0].new_page()

        captured = []

        async def on_response(resp):
            try:
                url = resp.url
                if "szgateway.jd.com" not in url:
                    return
                body = None
                if any(ep in url for ep in ENDPOINTS):
                    try:
                        body = await resp.text()
                    except Exception:
                        pass
                    captured.append({
                        "ts": time.time(),
                        "url": url,
                        "method": resp.request.method,
                        "status": resp.status,
                        "request_body": resp.request.post_data,
                        "request_headers": {k: v for k, v in resp.request.headers.items()
                                            if k.lower() in ("user-mnp", "user-mup", "uuid",
                                                            "x-requested-with", "content-type")},
                        "response_body": body,
                    })
            except Exception as e:
                captured.append({"ts": time.time(), "err": str(e)})

        page.on("response", on_response)

        async def handle_route(route):
            req = route.request
            url = req.url
            if not any(ep in url for ep in ENDPOINTS):
                await route.continue_()
                return
            try:
                post = req.post_data_json
            except Exception:
                post = None
            if not isinstance(post, dict):
                try:
                    post = json.loads(req.post_data or "{}")
                except Exception:
                    post = {}
            modified = dict(post)
            modified["startDate"] = str(start_date)
            modified["endDate"] = str(end_date)
            modified["compareStartDate"] = str(p_start)
            modified["compareEndDate"] = str(p_end)
            modified["dateType"] = "d30"
            modified["compareType"] = "hb"
            modified["interval"] = "DAY"
            modified["realtime"] = False
            modified["channel"] = "all"
            if "industryType" not in modified:
                modified["industryType"] = "shopSelfInCate"
            await route.continue_(post_data=json.dumps(modified))

        # Open the page
        await page.route("**/szgateway.jd.com/api/lowcode/tradeSummary/**", handle_route)
        await page.goto("https://jdsz.jd.com/szweb/view/tradeAnalysis/tradeSummary.html",
                        wait_until="domcontentloaded", timeout=30000)
        print("[+] Page loaded, waiting for SPA to fire its first set of API calls…")
        await asyncio.sleep(8)

        # Click 近30天 to trigger refresh with the right d30 marker
        for sel in ["text=近30天", "span:has-text('近30天')"]:
            try:
                el = await page.query_selector(sel)
                if el:
                    await el.click()
                    print(f"    ✓ {sel}")
                    break
            except Exception:
                pass
        await asyncio.sleep(5)

        # Click 查询 if present
        for sel in ["button:has-text('查询')", "span:has-text('查询')"]:
            try:
                el = await page.query_selector(sel)
                if el:
                    await el.click()
                    print(f"    ✓ {sel}")
                    break
            except Exception:
                pass
        await asyncio.sleep(5)

        # Also try to navigate to the brand/category tabs if they exist
        # The tradeSummary page may have tabs (品牌构成 / 类目构成)
        for tab_text in ["品牌构成", "类目构成", "品牌", "类目"]:
            for sel in [f"text={tab_text}", f"div:has-text('{tab_text}')", f"span:has-text('{tab_text}')"]:
                try:
                    el = await page.query_selector(sel)
                    if el:
                        await el.click()
                        print(f"    ✓ clicked tab '{tab_text}'")
                        await asyncio.sleep(3)
                        break
                except Exception:
                    pass

        # Persist raw
        raw_out = OUT_DIR / "target_a_trade_raw.json"
        with open(raw_out, "w", encoding="utf-8") as f:
            json.dump({
                "shop_id": SHOP_ID,
                "shop_name": "祁门红茶官方旗舰店",
                "date_range": {"start": str(start_date), "end": str(end_date), "days": DAYS},
                "compare_range": {"start": str(p_start), "end": str(p_end)},
                "acquired_at": datetime.now().isoformat(),
                "acquisition_method": "page.route() interception — rewrite date range to 30 days",
                "captured_calls": captured,
            }, f, ensure_ascii=False, indent=2, default=str)
        print(f"\n[+] Wrote {raw_out} — {len(captured)} events")

        # Group by endpoint and report
        by_ep = {}
        for c in captured:
            for ep in ENDPOINTS:
                if ep in c.get("url", ""):
                    by_ep.setdefault(ep, []).append(c)
                    break
        for ep in ENDPOINTS:
            calls = by_ep.get(ep, [])
            print(f"  {ep}: {len(calls)} call(s)")
            for c in calls:
                try:
                    pj = json.loads(c.get("response_body") or "{}")
                    body = pj.get("body", {})
                    code = pj.get("header", {}).get("code")
                    size = body.get("size") if isinstance(body, dict) else "?"
                    data_len = len(body.get("data", [])) if isinstance(body, dict) and isinstance(body.get("data"), list) else "?"
                    req_bd = (c.get("request_body") or "")[:150]
                    print(f"    status={c.get('status')} code={code} size={size} data_rows={data_len}  req={req_bd}")
                except Exception as e:
                    print(f"    parse err: {e}")

        # Build parsed datasets
        for ep in ENDPOINTS:
            # Use the most recent successful call with the 30-day range
            best = None
            for c in by_ep.get(ep, []):
                if c.get("status") != 200:
                    continue
                rb = c.get("request_body") or ""
                if "d30" in rb and str(start_date) in rb:
                    best = c
                    break
            if not best and by_ep.get(ep):
                # fall back to any successful call
                for c in by_ep.get(ep, []):
                    if c.get("status") == 200:
                        best = c
                        break
            if not best:
                print(f"[!] {ep}: no usable response")
                continue
            pj = json.loads(best["response_body"])
            body = pj.get("body", {})
            data = body.get("data", []) if isinstance(body, dict) else []
            if ep == "getSummary":
                if data:
                    sm = data[0]
                    JDR = {
                        "jdr_sch_trade_deal_ord_ord_amt_sz_trade_deal_snapshot": "GMV 成交金额",
                        "jdr_sch_trade_deal_ord_ord_qtty_sz_trade_deal_snapshot": "orders 成交单量",
                        "jdr_sch_user_deal_ord_user_cnt_sz_user_deal_snapshot": "customers 成交客户数",
                        "jdr_sch_trade_deal_ord_sku_qtty_sz_trade_deal_snapshot": "sku_pieces 成交商品件数",
                        "fo_jdr_sch_trade_deal_ord_amt_user_sz_trade_deal_snapshot": "AOV 客单价",
                        "fo_jdr_sch_shop_deal_rate": "CVR 转化率",
                        "jdr_sch_traffic_enter_shop__browse_page_cnt_shop_last_src": "PV 浏览量",
                        "jdr_sch_traffic_enter_shop__browse_page_qtty_shop_last_src": "UV 访客数",
                        "fo_jdr_sch_traffic_enter_shop__browse_page_avg_duration_shop_last_src": "avg_stay 平均停留时长(秒)",
                        "jdr_sch_sku_add_cart_sku_sku_piece_shopping_cart": "cart_pieces 加购件数",
                        "jdr_sch_sku_add_cart_sku_user_qtty_product_user_cart_add_minus_sz_bsg_shoppingcart@increase": "cart_users 加购客户数",
                        "fo_jdr_sch_add_cart_user_uv_rate@increase": "cart_uv_rate 加购率",
                    }
                    readable = {}
                    for k, name in JDR.items():
                        readable[name] = {
                            "value": sm.get(k),
                            "compare_pct": sm.get(k + "##compare"),
                            "compare_abs": sm.get(k + "##compareValue"),
                        }
                    consolidated = {
                        "shop_id": SHOP_ID,
                        "shop_name": "祁门红茶官方旗舰店",
                        "date_range": {"start": str(start_date), "end": str(end_date), "days": DAYS},
                        "compare_range": {"start": str(p_start), "end": str(p_end)},
                        "acquired_at": datetime.now().isoformat(),
                        "all_kpis_readable": readable,
                        "all_kpis_raw_field_count": len(sm),
                        "raw_request_body": best.get("request_body"),
                        "raw_status": best.get("status"),
                    }
                    with open(OUT_DIR / "target_a_summary_decoded.json", "w", encoding="utf-8") as f:
                        json.dump(consolidated, f, ensure_ascii=False, indent=2, default=str)
                    print(f"[+] Wrote target_a_summary_decoded.json — {len(readable)} decoded KPIs")
            elif ep == "getTrend":
                if data:
                    trend = data[0].get("trend", {})
                    series = trend.get("series", [])
                    xaxis = trend.get("xAxis", [])
                    if not xaxis:
                        xaxis = [(start_date + timedelta(days=i)).strftime("%Y-%m-%d")
                                 for i in range(DAYS)]
                    rows = []
                    for i, x in enumerate(xaxis):
                        row = {"date": x}
                        for s in series:
                            d = s.get("data", [])
                            row[s.get("code", "")] = d[i] if i < len(d) else None
                        rows.append(row)
                    with open(OUT_DIR / "target_a_trend_parsed.json", "w", encoding="utf-8") as f:
                        json.dump({
                            "shop_id": SHOP_ID,
                            "date_range": {"start": str(start_date), "end": str(end_date), "days": DAYS},
                            "xaxis": xaxis,
                            "series": series,
                            "rows": rows,
                        }, f, ensure_ascii=False, indent=2, default=str)
                    print(f"[+] Wrote target_a_trend_parsed.json — {len(rows)} daily points × {len(series)} series")
                    if rows:
                        cols = list(rows[0].keys())
                        with open(OUT_DIR / "target_a_trend_parsed.csv", "w", encoding="utf-8") as f:
                            f.write(",".join(cols) + "\n")
                            for r in rows:
                                f.write(",".join(
                                    f'"{str(r.get(c, "")).replace(chr(34), chr(34)*2)}"' for c in cols
                                ) + "\n")
            elif ep == "getBrandTable":
                with open(OUT_DIR / "target_a_brand_parsed.json", "w", encoding="utf-8") as f:
                    json.dump({"date_range": {"start": str(start_date), "end": str(end_date)},
                               "rows": data}, f, ensure_ascii=False, indent=2)
                print(f"[+] Wrote target_a_brand_parsed.json — {len(data)} brand row(s)")
            elif ep == "getCateTable":
                with open(OUT_DIR / "target_a_category_parsed.json", "w", encoding="utf-8") as f:
                    json.dump({"date_range": {"start": str(start_date), "end": str(end_date)},
                               "rows": data}, f, ensure_ascii=False, indent=2)
                print(f"[+] Wrote target_a_category_parsed.json — {len(data)} category row(s)")

        # Consolidated
        consolidated = {
            "shop_id": SHOP_ID,
            "shop_name": "祁门红茶官方旗舰店",
            "date_range": {"start": str(start_date), "end": str(end_date), "days": DAYS},
            "compare_range": {"start": str(p_start), "end": str(p_end)},
            "acquired_at": datetime.now().isoformat(),
            "acquisition_method": "page.route() interception, rewriting date range to d30",
            "endpoints_captured": list(by_ep.keys()),
        }
        if "getSummary" in by_ep:
            try:
                c = by_ep["getSummary"][-1]
                pj = json.loads(c["response_body"])
                sm = pj.get("body", {}).get("data", [{}])[0]
                consolidated["headline_metrics_30d"] = {
                    "GMV": sm.get("jdr_sch_trade_deal_ord_ord_amt_sz_trade_deal_snapshot"),
                    "orders": sm.get("jdr_sch_trade_deal_ord_ord_qtty_sz_trade_deal_snapshot"),
                    "customers": sm.get("jdr_sch_user_deal_ord_user_cnt_sz_user_deal_snapshot"),
                    "sku_pieces": sm.get("jdr_sch_trade_deal_ord_sku_qtty_sz_trade_deal_snapshot"),
                    "AOV": sm.get("fo_jdr_sch_trade_deal_ord_amt_user_sz_trade_deal_snapshot"),
                    "CVR": sm.get("fo_jdr_sch_shop_deal_rate"),
                    "PV": sm.get("jdr_sch_traffic_enter_shop__browse_page_cnt_shop_last_src"),
                    "UV": sm.get("jdr_sch_traffic_enter_shop__browse_page_qtty_shop_last_src"),
                    "avg_stay_seconds": sm.get("fo_jdr_sch_traffic_enter_shop__browse_page_avg_duration_shop_last_src"),
                    "cart_pieces": sm.get("jdr_sch_sku_add_cart_sku_sku_piece_shopping_cart"),
                    "cart_users": sm.get("jdr_sch_sku_add_cart_sku_user_qtty_product_user_cart_add_minus_sz_bsg_shoppingcart@increase"),
                    "cart_uv_rate": sm.get("fo_jdr_sch_add_cart_user_uv_rate@increase"),
                }
                consolidated["comparisons_period_on_period_pct"] = {
                    "GMV": sm.get("jdr_sch_trade_deal_ord_ord_amt_sz_trade_deal_snapshot##compare"),
                    "orders": sm.get("jdr_sch_trade_deal_ord_ord_qtty_sz_trade_deal_snapshot##compare"),
                    "customers": sm.get("jdr_sch_user_deal_ord_user_cnt_sz_user_deal_snapshot##compare"),
                    "AOV": sm.get("fo_jdr_sch_trade_deal_ord_amt_user_sz_trade_deal_snapshot##compare"),
                    "CVR": sm.get("fo_jdr_sch_shop_deal_rate##compare"),
                }
                consolidated["industry_indices"] = {
                    "GMV_index": sm.get("jdr_sch_trade_deal_ord_ord_amt_sz_trade_shop_cate_and_level_snapshot##industry"),
                    "orders_index": sm.get("jdr_sch_trade_deal_ord_ord_qtty_sz_trade_shop_cate_and_level_snapshot##industry"),
                    "customers_index": sm.get("jdr_sch_user_deal_ord_user_cnt_sz_shop_cate_and_level_user_deal_snapshot##industry"),
                    "deal_rate_index": sm.get("fo_jdr_sch_sz_trade_shop_cate_and_level_deal_snapshot##industry"),
                }
            except Exception as e:
                consolidated["summary_decode_error"] = str(e)
        if "getBrandTable" in by_ep:
            try:
                c = by_ep["getBrandTable"][-1]
                pj = json.loads(c["response_body"])
                consolidated["brand_table"] = pj.get("body", {}).get("data", [])
            except Exception:
                pass
        if "getCateTable" in by_ep:
            try:
                c = by_ep["getCateTable"][-1]
                pj = json.loads(c["response_body"])
                consolidated["category_table"] = pj.get("body", {}).get("data", [])
            except Exception:
                pass
        if "getTrend" in by_ep:
            try:
                c = by_ep["getTrend"][-1]
                pj = json.loads(c["response_body"])
                trend = pj.get("body", {}).get("data", [{}])[0].get("trend", {})
                series = trend.get("series", [])
                consolidated["trend_series_count"] = len(series)
                consolidated["trend_data_points"] = max((len(s.get("data", [])) for s in series), default=0)
            except Exception:
                pass

        with open(OUT_DIR / "target_a_consolidated.json", "w", encoding="utf-8") as f:
            json.dump(consolidated, f, ensure_ascii=False, indent=2, default=str)
        print(f"[+] Wrote target_a_consolidated.json")

        # Screenshot
        shot = OUT_DIR / "target_a_trade_page_evidence.png"
        await page.screenshot(path=str(shot), full_page=True)
        print(f"[+] Screenshot: {shot}")

        # Unroute
        try:
            await page.unroute("**/szgateway.jd.com/api/lowcode/tradeSummary/**")
        except Exception:
            pass
        await page.close()
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
