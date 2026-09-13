#!/usr/bin/env python3
"""
JD 商智 订单明细 — acquire via page.route() interception.

The SPA polls getDealOrders.ajax every ~10s with a single date. We
intercept via page.route(), rewrite the body to request the entire
30-day range with a large pageSize, and let the response flow back
to the SPA. We capture the full response body.

Then for subsequent pages, we use the in-page fetch WITH the SPA's
own CSRF tokens (read from the request headers) so JD's security
layer accepts them.
"""
import asyncio
import json
import sys
import time
from pathlib import Path
from datetime import datetime, timedelta

OUT_DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("data/jd_acquisition_test")
OUT_DIR.mkdir(parents=True, exist_ok=True)

SHOP_ID = "11855009"
DAYS = 30
PAGE_SIZE = 2000  # try larger than 1000 to see if total > 1000

DEAL_ORDERS_URL = "https://szgateway.jd.com/api/lowcode/orderDetails/getDealOrders.ajax"


async def main():
    from playwright.async_api import async_playwright

    today = datetime.now().date()
    end_date = today - timedelta(days=1)
    start_date = end_date - timedelta(days=DAYS - 1)
    print(f"[+] Date range: {start_date} → {end_date} ({DAYS} days)")

    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp("http://127.0.0.1:9222")
        ctx = browser.contexts[0]

        # Use a new page in the same context (inherits cookies)
        page = await ctx.new_page()
        captured = []
        csrf_tokens = {}
        route_unregistered = {"done": False}

        async def on_response(resp):
            try:
                if "getDealOrders.ajax" in resp.url and resp.request.method == "POST":
                    body_text = await resp.text()
                    req = resp.request
                    # Extract CSRF tokens from THIS request
                    h = req.headers
                    if h.get("user-mnp") and "user-mnp" not in csrf_tokens:
                        csrf_tokens["user-mnp"] = h["user-mnp"]
                    if h.get("user-mup") and "user-mup" not in csrf_tokens:
                        csrf_tokens["user-mup"] = h["user-mup"]
                    if h.get("uuid") and "uuid" not in csrf_tokens:
                        csrf_tokens["uuid"] = h["uuid"]
                    captured.append({
                        "ts": time.time(),
                        "url": resp.url,
                        "status": resp.status,
                        "request_body": req.post_data,
                        "request_headers": {
                            k: v for k, v in h.items()
                            if k.lower() in ("user-mnp", "user-mup", "uuid",
                                            "x-requested-with", "content-type")
                        },
                        "response_body": body_text,
                    })
            except Exception as e:
                captured.append({"ts": time.time(), "err": str(e)})

        page.on("response", on_response)

        # Define the route handler to rewrite the date range.
        # The SPA fires getDealOrders.ajax with the current date range.
        # We widen it to our 30-day window and bump pageSize to 2000.
        async def handle_route(route):
            req = route.request
            url = req.url
            if "getDealOrders.ajax" not in url:
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
            modified["pageSize"] = PAGE_SIZE
            modified["pageIndex"] = 1
            modified["channel"] = "all"
            modified["dateType"] = "day"
            modified["interval"] = "DAY"
            modified["realtime"] = False
            modified["sortField"] = "OrdAmt"
            modified["sortType"] = "descend"
            modified["spuIds"] = []
            modified["orderIds"] = []
            await route.continue_(post_data=json.dumps(modified))

        # Open the order-detail page
        order_url = "https://jdsz.jd.com/szweb/view/tradeAnalysis/orderDetails.html"
        print(f"[+] Navigating to {order_url}")
        # Register the route BEFORE the SPA starts firing API calls.
        await page.route("**/szgateway.jd.com/api/lowcode/orderDetails/**", handle_route)
        await page.goto(order_url, wait_until="domcontentloaded", timeout=30000)
        await asyncio.sleep(3)

        # Now click 近30天 + 查询 to trigger the SPA to fire the call
        print("[+] Click 近30天 + 查询 (UI path)…")
        for sel in ["text=近30天", "span:has-text('近30天')"]:
            try:
                el = await page.query_selector(sel)
                if el:
                    await el.click()
                    print(f"    ✓ {sel}")
                    break
            except Exception:
                pass
        await asyncio.sleep(1)
        for sel in ["button:has-text('查询')", "span:has-text('查询')"]:
            try:
                el = await page.query_selector(sel)
                if el:
                    await el.click()
                    print(f"    ✓ {sel}")
                    break
            except Exception:
                pass
        await asyncio.sleep(6)

        # Unregister the route — we don't want to keep modifying things
        if not route_unregistered["done"]:
            try:
                await page.unroute("**/szgateway.jd.com/api/lowcode/orderDetails/**")
            except Exception:
                pass
            route_unregistered["done"] = True

        if not captured:
            print("[!] No responses captured. Something's wrong.", file=sys.stderr)
            await page.close()
            await browser.close()
            sys.exit(1)

        # Look at the first captured call to know the response shape
        first = captured[0]
        first_resp = json.loads(first["response_body"])
        first_body = first_resp.get("body", {})
        first_data = first_body.get("data", []) if isinstance(first_body, dict) else []
        first_total = first_body.get("totalCount")
        if first_total is None:
            first_total = first_body.get("size")
        print(f"[+] First response: status={first['status']} data_rows={len(first_data)} totalCount/size={first_total}")
        if first_total:
            print(f"    CSRF tokens captured: {list(csrf_tokens.keys())}")
            print(f"    Source reports {first_total} total orders in {DAYS}-day window")

        # Inspect request headers
        print(f"    Request headers captured: {list(first.get('request_headers', {}).keys())}")

        # If 30 days fit in one pageSize=50, we got it. Otherwise walk pages.
        pages_needed = 1
        if first_total and first_total > PAGE_SIZE:
            pages_needed = (first_total + PAGE_SIZE - 1) // PAGE_SIZE
        print(f"[+] {pages_needed} page(s) needed (pageSize={PAGE_SIZE})")

        # Walk remaining pages via in-page fetch WITH the CSRF tokens we
        # captured from the SPA's own request.
        if pages_needed > 1:
            print(f"[+] Walking pages 2..{pages_needed} via in-page fetch w/ CSRF…")
            for pi in range(2, pages_needed + 1):
                resp = await page.evaluate(
                    """
                    async ({url, startDate, endDate, pageIndex, pageSize, csrf}) => {
                        const body = {
                            channel: 'all', spuIds: [], orderIds: [], realtime: false,
                            interval: 'DAY', dateType: 'day',
                            startDate, endDate,
                            sortField: 'OrdAmt', sortType: 'descend',
                            pageIndex, pageSize
                        };
                        const r = await fetch(url, {
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
                        const text = await r.text();
                        return { status: r.status, body: text };
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
                if resp.get("status") != 200:
                    print(f"    ! page {pi}: status={resp.get('status')}  body[:200]={resp.get('body', '')[:200]}")
                    break
                try:
                    pj = json.loads(resp["body"])
                    d = pj.get("body", {}).get("data", []) if isinstance(pj.get("body"), dict) else []
                    print(f"    ✓ page {pi}: {len(d)} rows")
                except Exception:
                    print(f"    ! page {pi}: parse error")
                # Append as if it were a real response
                captured.append({
                    "ts": time.time(),
                    "url": DEAL_ORDERS_URL,
                    "status": resp["status"],
                    "request_body": json.dumps({"pageIndex": pi, "pageSize": PAGE_SIZE,
                                                "startDate": str(start_date),
                                                "endDate": str(end_date)}),
                    "request_headers": {"user-mnp": csrf_tokens.get("user-mnp"),
                                        "user-mup": csrf_tokens.get("user-mup"),
                                        "uuid": csrf_tokens.get("uuid")},
                    "response_body": resp["body"],
                    "via": "in-page-fetch",
                })
                if not d:
                    break
                # If we got a short page, stop
                if len(d) < PAGE_SIZE:
                    break

        # Save raw
        raw_path = OUT_DIR / "target_b_order_detail_raw.json"
        with open(raw_path, "w", encoding="utf-8") as f:
            json.dump({
                "shop_id": SHOP_ID,
                "date_range": {"start": str(start_date), "end": str(end_date), "days": DAYS},
                "csrf_tokens_present": list(csrf_tokens.keys()),
                "page_size": PAGE_SIZE,
                "captured_calls": captured,
            }, f, ensure_ascii=False, indent=2)
        print(f"[+] Wrote {raw_path} — {len(captured)} captured call(s)")

        # Parse all responses
        flat = []
        per_page = []
        for c in captured:
            try:
                pj = json.loads(c["response_body"])
            except Exception:
                continue
            body = pj.get("body", {})
            if not isinstance(body, dict):
                continue
            data = body.get("data", []) or []
            total = body.get("totalCount")
            if total is None:
                total = body.get("size")
            per_page.append({
                "via": c.get("via", "spa"),
                "status": c.get("status"),
                "rows": len(data),
                "totalCount": total,
            })
            for ord in data:
                base = {
                    "order_id": ord.get("SaleOrdId"),
                    "shop_id": ord.get("ShopId"),
                    "spu_id": ord.get("ItmId"),
                    "sku_id": ord.get("ItmSkuId"),
                    "sku_name": ord.get("ItmSkuNm"),
                    "sale_qty": ord.get("SaleQty"),
                    "ord_amt": ord.get("OrdAmt"),
                    "pre_discount_amt": ord.get("TotPrefAmt"),
                    "sku_jd_price": ord.get("SkuJdPrc"),
                    "delivery_service_fee": ord.get("DelvSerFeeAmt"),
                    "sku_freight_amt": ord.get("SkuFreitAmt"),
                    "ord_type": ord.get("OrdType"),
                    "is_same_member": ord.get("IsSamMbr"),
                    "channel_code": ord.get("ChanCd"),
                    "pay_method_code": ord.get("PayMdeCd"),
                    "pay_method_desc": ord.get("PayMdeDsc"),
                    "biz_date": ord.get("Time"),
                    "sale_ord_tm": ord.get("SaleOrdTm"),
                    "pay_tm": ord.get("PayTm"),
                    "row_kind": "header",
                }
                flat.append(base)
                for sub in (ord.get("children") or []):
                    flat.append({
                        "order_id": sub.get("SaleOrdId"),
                        "shop_id": sub.get("ShopId"),
                        "spu_id": sub.get("ItmId"),
                        "sku_id": sub.get("ItmSkuId"),
                        "sku_name": sub.get("ItmSkuNm"),
                        "sale_qty": sub.get("SaleQty"),
                        "ord_amt": sub.get("OrdAmt"),
                        "pre_discount_amt": sub.get("TotPrefAmt"),
                        "sku_jd_price": sub.get("SkuJdPrc"),
                        "delivery_service_fee": sub.get("DelvSerFeeAmt"),
                        "sku_freight_amt": sub.get("SkuFreitAmt"),
                        "ord_type": sub.get("OrdType"),
                        "channel_code": sub.get("ChanCd"),
                        "pay_method_desc": sub.get("PayMdeDsc"),
                        "biz_date": sub.get("Time"),
                        "sale_ord_tm": sub.get("SaleOrdTm"),
                        "pay_tm": sub.get("PayTm"),
                        "row_kind": "child",
                    })

        json_path = OUT_DIR / "target_b_order_detail_parsed.json"
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(flat, f, ensure_ascii=False, indent=2)
        print(f"[+] Wrote {json_path} — {len(flat)} rows (parent+children)")

        csv_path = OUT_DIR / "target_b_order_detail_parsed.csv"
        if flat:
            cols = list(flat[0].keys())
            with open(csv_path, "w", encoding="utf-8") as f:
                f.write(",".join(cols) + "\n")
                for r in flat:
                    f.write(",".join(
                        f'"{str(r.get(c, "")).replace(chr(34), chr(34)*2)}"' for c in cols
                    ) + "\n")
        print(f"[+] Wrote {csv_path}")

        # Page-walk log
        with open(OUT_DIR / "target_b_pages_log.json", "w", encoding="utf-8") as f:
            json.dump({
                "shop_id": SHOP_ID,
                "start_date": str(start_date),
                "end_date": str(end_date),
                "days": DAYS,
                "page_size": PAGE_SIZE,
                "page_walk": per_page,
                "rows_collected_total": len(flat),
            }, f, ensure_ascii=False, indent=2)

        # Evidence shot
        shot = OUT_DIR / "target_b_page_evidence.png"
        await page.screenshot(path=str(shot), full_page=True)
        print(f"[+] Screenshot: {shot}")

        await page.close()
        await browser.close()

        print(f"\n=== TARGET B SUMMARY ===")
        print(f"Shop:        {SHOP_ID}  (祁门红茶官方旗舰店)")
        print(f"Date range:  {start_date} → {end_date}  ({DAYS} days)")
        print(f"Page size:   {PAGE_SIZE}")
        print(f"Pages:       {len(captured)}")
        print(f"Rows:        {len(flat)}  (parent + children)")
        unique_orders = len({r['order_id'] for r in flat if r.get('order_id')})
        print(f"Unique orders: {unique_orders}")


if __name__ == "__main__":
    asyncio.run(main())
