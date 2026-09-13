#!/usr/bin/env python3
"""
Verify the 1000-row cap is consistent regardless of date range.
- Test with 7-day window vs 30-day window
- Test with orderIds filter
- Test the 'size' field — does it reflect actual total?
"""
import asyncio
import json
import sys
from pathlib import Path
from datetime import datetime, timedelta

OUT_DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("data/jd_acquisition_test")
DEAL_ORDERS_URL = "https://szgateway.jd.com/api/lowcode/orderDetails/getDealOrders.ajax"

raw = json.load(open(OUT_DIR / "target_b_order_detail_raw.json"))
csrf_tokens = {}
for c in raw["captured_calls"]:
    h = c.get("request_headers", {})
    if h.get("user-mnp"):
        csrf_tokens["user-mnp"] = h["user-mnp"]
    if h.get("user-mup"):
        csrf_tokens["user-mup"] = h["user-mup"]
    if h.get("uuid"):
        csrf_tokens["uuid"] = h["uuid"]


async def main():
    from playwright.async_api import async_playwright
    today = datetime.now().date()
    end_date = today - timedelta(days=1)

    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp("http://127.0.0.1:9222")
        page = await browser.contexts[0].new_page()
        await page.goto("https://jdsz.jd.com/szweb/view/index/home.html",
                        wait_until="domcontentloaded", timeout=30000)
        await asyncio.sleep(2)

        tests = []
        # 1-day
        for days in [1, 3, 7, 15, 30, 60, 90]:
            start_date = end_date - timedelta(days=days - 1)
            tests.append((f"days_{days}", start_date, end_date))
        # Also: 1 specific day
        for offset in [0, 1, 7, 14, 29]:
            d = end_date - timedelta(days=offset)
            tests.append((f"only_{d}", d, d))

        results = {}
        for label, sd, ed in tests:
            r = await page.evaluate(
                """
                async ({url, startDate, endDate, csrf}) => {
                    const body = {
                        channel: 'all', spuIds: [], orderIds: [], realtime: false,
                        interval: 'DAY', dateType: 'day',
                        startDate, endDate,
                        sortField: 'OrdAmt', sortType: 'descend',
                        pageIndex: 1, pageSize: 1000
                    };
                    const resp = await fetch(url, {
                        method: 'POST',
                        credentials: 'include',
                        headers: {
                            'Content-Type': 'application/json;charset=UTF-8',
                            'Accept': 'application/json, text/plain, */*',
                            'X-Requested-With': 'XMLHttpRequest',
                            'user-mnp': csrf['user-mnp'] || '',
                            'user-mup': csrf['user-mup'] || '',
                            'uuid': csrf['uuid'] || '',
                        },
                        body: JSON.stringify(body),
                    });
                    return await resp.text();
                }
                """,
                {"url": DEAL_ORDERS_URL, "startDate": str(sd), "endDate": str(ed), "csrf": csrf_tokens},
            )
            try:
                pj = json.loads(r)
                data = pj.get("body", {}).get("data", [])
                size = pj.get("body", {}).get("size")
                unique = len(set(o.get("SaleOrdId") for o in data))
                # Sum amount
                total_amt = sum((o.get("OrdAmt") or 0) for o in data)
                total_qty = sum((o.get("SaleQty") or 0) for o in data)
                results[label] = {
                    "start": str(sd), "end": str(ed),
                    "rows": len(data), "size": size, "unique": unique,
                    "sum_amt": total_amt, "sum_qty": total_qty,
                }
                print(f"  {label} ({sd}→{ed}): rows={len(data)} size={size} unique={unique} amt=¥{total_amt:,.0f} qty={total_qty}")
            except Exception as e:
                print(f"  {label}: ERR {e}")
                results[label] = {"err": str(e)}

        out = OUT_DIR / "target_b_size_vs_window_diagnostic.json"
        with open(out, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=2)
        print(f"\n[+] Wrote {out}")
        await page.close()
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
