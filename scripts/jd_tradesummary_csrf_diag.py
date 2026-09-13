#!/usr/bin/env python3
"""
Diagnostic: figure out why tradeSummary in-page fetch fails with -407.
Check whether the SPA rotates the CSRF token per call, or whether
there's some other issue (origin, referer, content-length, etc.).
"""
import asyncio
import json
import sys
from pathlib import Path
from datetime import datetime, timedelta

OUT_DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("data/jd_acquisition_test")

# Use whatever CSRF tokens we have
csrf_path = OUT_DIR / "target_a_csrf_tokens.json"
csrf_tokens = json.load(open(csrf_path)) if csrf_path.exists() else {}


async def main():
    from playwright.async_api import async_playwright

    today = datetime.now().date()
    end_date = today - timedelta(days=1)
    start_date = end_date - timedelta(days=29)
    p_start = start_date - timedelta(days=30)
    p_end = start_date - timedelta(days=1)

    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp("http://127.0.0.1:9222")
        page = await browser.contexts[0].new_page()
        await page.goto("https://jdsz.jd.com/szweb/view/tradeAnalysis/tradeSummary.html",
                        wait_until="domcontentloaded", timeout=30000)
        await asyncio.sleep(3)

        # Capture fresh headers from a NATURAL SPA call by hooking the
        # next getSummary.ajax the SPA makes.
        captured = []
        async def on_response(resp):
            if "getSummary.ajax" in resp.url or "getTrend.ajax" in resp.url:
                h = resp.request.headers
                captured.append({
                    "ts": __import__("time").time(),
                    "url": resp.url,
                    "request_headers": dict(h),
                    "request_body": resp.request.post_data,
                    "status": resp.status,
                    "response_body": (await resp.text())[:2000],
                })
        page.on("response", on_response)

        # Click 近30天 to trigger a SPA-driven call
        print("[+] Click 近30天…")
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

        for c in captured:
            print(f"\n=== {c['url'][-50:]} ===")
            print(f"status: {c['status']}")
            print(f"request_body: {c['request_body'][:200]}")
            print(f"headers (selected):")
            for k, v in c['request_headers'].items():
                if k.lower() in ("user-mnp", "user-mup", "uuid", "x-requested-with", "content-type", "referer", "origin", "host"):
                    print(f"  {k}: {v[:100]}")
            print(f"response preview: {c['response_body'][:200]}")

        # Now: also try the in-page fetch with EXACTLY these captured headers
        if captured:
            h0 = captured[0]["request_headers"]
            print("\n[+] Test in-page fetch with FRESH captured headers…")
            r = await page.evaluate(
                """
                async ({url, body, headers}) => {
                    const resp = await fetch(url, {
                        method: 'POST',
                        credentials: 'include',
                        headers: headers,
                        body: JSON.stringify(body),
                    });
                    return { status: resp.status, body: await resp.text() };
                }
                """,
                {
                    "url": "https://szgateway.jd.com/api/lowcode/tradeSummary/summary/getSummary.ajax",
                    "body": {
                        "realtime": False, "interval": "DAY", "dateType": "d30",
                        "startDate": str(start_date), "endDate": str(end_date),
                        "compareStartDate": str(p_start), "compareEndDate": str(p_end),
                        "compareType": "hb", "channel": "all",
                        "industryType": "shopSelfInCate",
                    },
                    "headers": {
                        "Content-Type": "application/json;charset=UTF-8",
                        "Accept": "application/json, text/plain, */*",
                        "X-Requested-With": "XMLHttpRequest",
                        "user-mnp": h0.get("user-mnp", ""),
                        "user-mup": h0.get("user-mup", ""),
                        "uuid": h0.get("uuid", ""),
                    },
                },
            )
            print(f"  status: {r['status']}")
            print(f"  body: {r['body'][:500]}")

        await page.close()
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
