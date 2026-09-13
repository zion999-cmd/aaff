#!/usr/bin/env python3
"""
JD 商智 交易经营数据 (Target A) — discovery.

Connects to Chrome, navigates to 交易概况 (tradeSummary), sets 30天
range, captures all szgateway.jd.com API calls + responses.
"""
import asyncio
import json
import sys
import time
from pathlib import Path
from datetime import datetime, timedelta

OUT_DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("data/jd_acquisition_test")
OUT_DIR.mkdir(parents=True, exist_ok=True)


async def main():
    from playwright.async_api import async_playwright

    captured = []
    csrf_tokens = {}

    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp("http://127.0.0.1:9222")
        ctx = browser.contexts[0]
        page = await ctx.new_page()

        async def on_response(resp):
            try:
                url = resp.url
                if "szgateway.jd.com" in url:
                    body = None
                    try:
                        body = await resp.text()
                    except Exception:
                        pass
                    h = resp.request.headers
                    if h.get("user-mnp") and "user-mnp" not in csrf_tokens:
                        csrf_tokens["user-mnp"] = h["user-mnp"]
                    if h.get("user-mup") and "user-mup" not in csrf_tokens:
                        csrf_tokens["user-mup"] = h["user-mup"]
                    if h.get("uuid") and "uuid" not in csrf_tokens:
                        csrf_tokens["uuid"] = h["uuid"]
                    captured.append({
                        "ts": time.time(),
                        "url": url,
                        "method": resp.request.method,
                        "status": resp.status,
                        "request_body": resp.request.post_data,
                        "request_headers": {k: v for k, v in h.items() if k.lower() in ("user-mnp", "user-mup", "uuid", "x-requested-with", "content-type")},
                        "response_body": body,
                    })
            except Exception as e:
                captured.append({"ts": time.time(), "err": str(e)})

        page.on("response", on_response)

        url = "https://jdsz.jd.com/szweb/view/tradeAnalysis/tradeSummary.html"
        print(f"[+] Navigating to {url}")
        await page.goto(url, wait_until="domcontentloaded", timeout=30000)
        await asyncio.sleep(3)

        # Click 近30天
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
        await asyncio.sleep(3)

        # The SPA typically auto-refreshes when range changes
        # Wait a bit more for any data fetches
        await asyncio.sleep(5)

        # Click 查询 if there is one
        for sel in ["button:has-text('查询')", "span:has-text('查询')"]:
            try:
                el = await page.query_selector(sel)
                if el:
                    await el.click()
                    print(f"    ✓ clicked {sel}")
                    break
            except Exception:
                pass
        await asyncio.sleep(4)

        # Save capture
        out = OUT_DIR / "target_a_discovery_capture.json"
        with open(out, "w", encoding="utf-8") as f:
            json.dump(captured, f, ensure_ascii=False, indent=2, default=str)
        print(f"\n[+] Wrote {out} — {len(captured)} events")

        # Group by endpoint
        apis = {}
        for ev in captured:
            if ev.get("kind") is None or ev.get("url"):
                ep = (ev.get("url") or "").split("?")[0].split("/")[-1] if ev.get("url") else "?"
                apis.setdefault(ep, []).append(ev)
        print(f"[+] Unique endpoints: {len(apis)}")
        for ep, evs in sorted(apis.items()):
            print(f"    {ep}: {len(evs)} call(s)  {evs[0].get('url', '?')[:120]}")
            if evs[0].get("request_body"):
                print(f"        sample body: {evs[0]['request_body'][:200]}")

        # Screenshot
        shot = OUT_DIR / "target_a_discovery_page.png"
        await page.screenshot(path=str(shot), full_page=True)
        print(f"[+] Screenshot: {shot}")

        # Persist CSRF tokens
        with open(OUT_DIR / "target_a_csrf_tokens.json", "w", encoding="utf-8") as f:
            json.dump(csrf_tokens, f, ensure_ascii=False, indent=2)
        print(f"[+] CSRF tokens: {list(csrf_tokens.keys())}")

        await page.close()
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
