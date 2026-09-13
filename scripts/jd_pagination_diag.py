#!/usr/bin/env python3
"""
Diagnostic: check if pageIndex actually paginates, or if the API just
returns the same first N rows regardless. Also test sort field variations.
"""
import asyncio
import json
import sys
from pathlib import Path
from datetime import datetime, timedelta

OUT_DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("data/jd_acquisition_test")
DEAL_ORDERS_URL = "https://szgateway.jd.com/api/lowcode/orderDetails/getDealOrders.ajax"
DAYS = 30

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
    start_date = end_date - timedelta(days=DAYS - 1)

    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp("http://127.0.0.1:9222")
        page = await browser.contexts[0].new_page()
        await page.goto("https://jdsz.jd.com/szweb/view/index/home.html",
                        wait_until="domcontentloaded", timeout=30000)
        await asyncio.sleep(2)

        # Test 1: pageIndex 1, 2, 3, 4 with same pageSize=100
        # Test 2: pageSize 100, 500, 1000
        # Test 3: different sortField: SaleOrdTm desc
        results = {}
        for label, body_extra in [
            ("page_1_ps_100", {"pageIndex": 1, "pageSize": 100}),
            ("page_2_ps_100", {"pageIndex": 2, "pageSize": 100}),
            ("page_3_ps_100", {"pageIndex": 3, "pageSize": 100}),
            ("ps_500_p1", {"pageIndex": 1, "pageSize": 500}),
            ("ps_1000_p1", {"pageIndex": 1, "pageSize": 1000}),
            ("ps_2000_p1", {"pageIndex": 1, "pageSize": 2000}),
            ("ps_2000_p2", {"pageIndex": 2, "pageSize": 2000}),
            ("sort_OrdTm_desc_p1", {"pageIndex": 1, "pageSize": 100, "sortField": "SaleOrdTm", "sortType": "descend"}),
            ("sort_OrdId_asc_p1", {"pageIndex": 1, "pageSize": 100, "sortField": "SaleOrdId", "sortType": "ascend"}),
        ]:
            r = await page.evaluate(
                """
                async ({url, body, csrf}) => {
                    const b = Object.assign({
                        channel: 'all', spuIds: [], orderIds: [], realtime: false,
                        interval: 'DAY', dateType: 'day', sortField: 'OrdAmt', sortType: 'descend',
                    }, body);
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
                        body: JSON.stringify(b),
                    });
                    return await resp.text();
                }
                """,
                {
                    "url": DEAL_ORDERS_URL,
                    "body": {**body_extra, "startDate": str(start_date), "endDate": str(end_date)},
                    "csrf": csrf_tokens,
                },
            )
            try:
                pj = json.loads(r)
                data = pj.get("body", {}).get("data", [])
                size = pj.get("body", {}).get("size")
                # First order's identifier
                first_id = data[0].get("SaleOrdId") if data else None
                last_id = data[-1].get("SaleOrdId") if data else None
                unique = len(set(o.get("SaleOrdId") for o in data))
                results[label] = {
                    "rows": len(data),
                    "size": size,
                    "unique_orders": unique,
                    "first_id": first_id,
                    "last_id": last_id,
                }
                print(f"  {label}: rows={len(data)} unique={unique} size={size} first={first_id}")
            except Exception as e:
                print(f"  {label}: ERR {e}")
                results[label] = {"err": str(e), "raw": r[:200]}

        out = OUT_DIR / "target_b_pagination_diagnostic.json"
        with open(out, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=2)
        print(f"\n[+] Wrote {out}")

        await page.close()
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
