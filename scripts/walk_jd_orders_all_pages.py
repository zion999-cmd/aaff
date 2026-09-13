#!/usr/bin/env python3
"""
Walk all pages of getDealOrders.ajax for the 30-day window to verify
we captured all orders. pageSize=1000 appears to be the API's max.
"""
import asyncio
import json
import sys
from pathlib import Path
from datetime import datetime, timedelta

OUT_DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("data/jd_acquisition_test")
DEAL_ORDERS_URL = "https://szgateway.jd.com/api/lowcode/orderDetails/getDealOrders.ajax"
DAYS = 30
PAGE_SIZE = 1000

# Load CSRF tokens from existing raw capture
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
print(f"[+] CSRF tokens: {list(csrf_tokens.keys())}")


async def main():
    from playwright.async_api import async_playwright

    today = datetime.now().date()
    end_date = today - timedelta(days=1)
    start_date = end_date - timedelta(days=DAYS - 1)

    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp("http://127.0.0.1:9222")
        page = await browser.contexts[0].new_page()
        # Just navigate to login-bearing page for cookies
        await page.goto("https://jdsz.jd.com/szweb/view/index/home.html",
                        wait_until="domcontentloaded", timeout=30000)
        await asyncio.sleep(2)

        pages_data = []
        pi = 1
        while True:
            r = await page.evaluate(
                """
                async ({url, startDate, endDate, pageIndex, pageSize, csrf}) => {
                    const body = {
                        channel: 'all', spuIds: [], orderIds: [], realtime: false,
                        interval: 'DAY', dateType: 'day',
                        startDate, endDate,
                        sortField: 'OrdAmt', sortType: 'descend',
                        pageIndex, pageSize
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
                    const text = await resp.text();
                    return { status: resp.status, body: text };
                }
                """,
                {
                    "url": DEAL_ORDERS_URL,
                    "startDate": str(start_date),
                    "endDate": str(end_date),
                    "pageIndex": pi,
                    "pageSize": PAGE_SIZE,
                    "csrf": csrf_tokens,
                },
            )
            if r.get("status") != 200:
                print(f"[!] page {pi}: status={r.get('status')}, body[:300]={r.get('body', '')[:300]}")
                break
            try:
                pj = json.loads(r["body"])
                if pj.get("header", {}).get("code") != 0:
                    print(f"[!] page {pi}: code={pj.get('header', {}).get('code')} desc={pj.get('header', {}).get('desc')}")
                    break
                data = pj.get("body", {}).get("data", [])
                size = pj.get("body", {}).get("size")
                print(f"    page {pi}: {len(data)} rows  size={size}")
                pages_data.append({"pageIndex": pi, "data": data, "size": size})
            except Exception as e:
                print(f"[!] page {pi}: parse err {e}")
                break
            # Termination: if rows < pageSize, we've reached the end
            if len(data) < PAGE_SIZE:
                print(f"[+] End of data at page {pi} (got {len(data)} < {PAGE_SIZE})")
                break
            pi += 1
            if pi > 20:
                print("[!] safety stop at page 20")
                break

        # Combine and save
        all_orders = []
        for pd in pages_data:
            all_orders.extend(pd["data"])
        out = OUT_DIR / "target_b_order_detail_all_orders.json"
        with open(out, "w", encoding="utf-8") as f:
            json.dump({
                "shop_id": "11855009",
                "date_range": {"start": str(start_date), "end": str(end_date), "days": DAYS},
                "page_size": PAGE_SIZE,
                "pages_walked": len(pages_data),
                "total_orders": len(all_orders),
                "orders": all_orders,
            }, f, ensure_ascii=False, indent=2)
        print(f"\n[+] Wrote {out} — {len(all_orders)} orders total")

        # Distribution by date
        import collections
        dates = collections.Counter(o.get("Time") for o in all_orders)
        print(f"[+] Date range covered: {min(dates)} → {max(dates)}")
        print(f"[+] Distinct dates: {len(dates)}")
        # Are there any orders outside the requested window?
        outside = [d for d in dates if d < str(start_date) or d > str(end_date)]
        print(f"[+] Dates outside requested window: {outside or 'NONE — perfect match'}")

        # Total GMV
        total_amt = sum((o.get("OrdAmt") or 0) for o in all_orders)
        total_qty = sum((o.get("SaleQty") or 0) for o in all_orders)
        print(f"[+] Total OrdAmt (parent rows): ¥{total_amt:,.2f}  Total Qty: {total_qty}")

        await page.close()
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
