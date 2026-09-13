#!/usr/bin/env python3
"""
JD 商智 订单明细 acquisition — step 1: discover endpoints via CDP Network.

Connects to the running Chrome (port 9222), navigates to the order detail page,
sets the time range to 近30天, triggers the query, and records every
szgateway.jd.com / lowcode / *.ajax request + response. Also records any
window.URL.createObjectURL blob URLs (used for "下载数据" Excel exports).
"""
import asyncio
import json
import sys
import time
from pathlib import Path

OUT_DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("data/jd_acquisition_test")
OUT_DIR.mkdir(parents=True, exist_ok=True)


async def main():
    from playwright.async_api import async_playwright

    captured = []  # list of {kind, ts, ...}
    blob_urls = []

    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp("http://127.0.0.1:9222")

        # Find the 商智 page (or open a new tab in same context for cookies)
        sz_page = None
        for ctx in browser.contexts:
            for pg in ctx.pages:
                if "sz.jd.com" in pg.url or "jdsz.jd.com" in pg.url:
                    sz_page = pg
                    break
            if sz_page:
                break

        if not sz_page:
            print("[!] No sz.jd.com page; cannot use existing session.", file=sys.stderr)
            sys.exit(1)

        print(f"[+] Using page: {sz_page.url}")

        # Hook request/response BEFORE navigating
        async def on_request(req):
            captured.append({
                "kind": "request",
                "ts": time.time(),
                "method": req.method,
                "url": req.url,
                "resource_type": req.resource_type,
                "post_data": req.post_data,
                "headers": dict(req.headers) if req.headers else {},
            })

        async def on_response(resp):
            try:
                url = resp.url
                ct = resp.headers.get("content-type", "")
                body = None
                if "szgateway.jd.com" in url or "lowcode" in url or ".ajax" in url:
                    try:
                        body = await resp.text()
                    except Exception:
                        body = None
                captured.append({
                    "kind": "response",
                    "ts": time.time(),
                    "url": url,
                    "status": resp.status,
                    "content_type": ct,
                    "body_preview": body[:8000] if body else None,
                })
            except Exception as e:
                captured.append({"kind": "response_error", "ts": time.time(), "url": resp.url, "err": str(e)})

        sz_page.on("request", on_request)
        sz_page.on("response", on_response)

        # Navigate to 订单明细
        order_url = "https://jdsz.jd.com/szweb/view/tradeAnalysis/orderDetails.html"
        print(f"[+] Navigating to {order_url}")
        await sz_page.goto(order_url, wait_until="domcontentloaded", timeout=30000)
        await asyncio.sleep(3)

        # Click 近30天 button — try several selectors
        print("[+] Clicking 近30天…")
        clicked = False
        for sel in [
            "text=近30天",
            "button:has-text('近30天')",
            "span:has-text('近30天')",
            "div:has-text('近30天')",
        ]:
            try:
                el = await sz_page.query_selector(sel)
                if el:
                    await el.click()
                    clicked = True
                    print(f"    ✓ clicked via {sel}")
                    break
            except Exception as e:
                pass
        if not clicked:
            print("    ! 近30天 button not found by text — will inspect page")
        await asyncio.sleep(2)

        # Click 查询 button to trigger the request
        print("[+] Clicking 查询…")
        for sel in [
            "button:has-text('查询')",
            "span:has-text('查询')",
            "div:has-text('查询')",
        ]:
            try:
                el = await sz_page.query_selector(sel)
                if el:
                    await el.click()
                    print(f"    ✓ clicked via {sel}")
                    break
            except Exception:
                pass
        await asyncio.sleep(5)

        # Save the full capture log
        out = OUT_DIR / "step1_discovery_capture.json"
        with open(out, "w", encoding="utf-8") as f:
            json.dump(captured, f, ensure_ascii=False, indent=2, default=str)
        print(f"[+] Wrote {out} ({len(captured)} events)")

        # Extract just the API endpoints
        apis = {}
        for ev in captured:
            if ev.get("kind") == "request" and "szgateway.jd.com" in ev.get("url", ""):
                ep = ev["url"].split("?")[0].split("/")[-1]
                apis.setdefault(ep, []).append(ev)
        apis_summary = {
            ep: {
                "count": len(reqs),
                "sample_url": reqs[0]["url"],
                "sample_body": reqs[0].get("post_data"),
            }
            for ep, reqs in apis.items()
        }
        out2 = OUT_DIR / "step1_apis_summary.json"
        with open(out2, "w", encoding="utf-8") as f:
            json.dump(apis_summary, f, ensure_ascii=False, indent=2, default=str)
        print(f"[+] Wrote {out2} — {len(apis_summary)} unique endpoint(s)")
        for ep, info in apis_summary.items():
            print(f"    {ep}: {info['count']} call(s)  {info['sample_url'][:120]}")

        # Try the download button — capture the blob URL flow
        print("\n[+] Trying 下载数据 button…")

        async def on_download(download):
            print(f"    [download] suggested={download.suggested_filename} url={download.url[:80]}")
            try:
                path = OUT_DIR / f"step1_xlsx_{download.suggested_filename}"
                await download.save_as(str(path))
                print(f"    ✓ saved {path}")
            except Exception as e:
                print(f"    ! save failed: {e}")

        sz_page.on("download", on_download)

        # Hook window.URL.createObjectURL to capture blob urls (in-page download).
        # `createObjectURL` is overloaded (string/Blob/MediaSource); we accept any
        # object and probe common size/type fields defensively.
        await sz_page.evaluate("""
            window.__capturedBlobs = [];
            const orig = window.URL.createObjectURL.bind(window.URL);
            window.URL.createObjectURL = function(obj) {
                const u = orig(obj);
                let size = null, type = null;
                if (obj && typeof obj === 'object') {
                    size = obj.size ?? null;
                    type = obj.type ?? null;
                }
                try { window.__capturedBlobs.push({url: u, size, type}); } catch(e) {}
                return u;
            };
        """)

        for sel in [
            "button:has-text('下载数据')",
            "span:has-text('下载数据')",
            "div:has-text('下载数据')",
        ]:
            try:
                el = await sz_page.query_selector(sel)
                if el:
                    await el.click()
                    print(f"    ✓ clicked download via {sel}")
                    break
            except Exception:
                pass
        await asyncio.sleep(8)

        blobs = await sz_page.evaluate("window.__capturedBlobs || []")
        with open(OUT_DIR / "step1_blob_log.json", "w", encoding="utf-8") as f:
            json.dump(blobs, f, ensure_ascii=False, indent=2)
        print(f"[+] Wrote step1_blob_log.json — {len(blobs)} blob(s)")
        for b in blobs:
            print(f"    blob: {b}")

        # Save a screenshot for evidence
        shot = OUT_DIR / "step1_order_detail_page.png"
        await sz_page.screenshot(path=str(shot), full_page=True)
        print(f"[+] Screenshot: {shot}")

        # Inspect first-row data
        first_row = await sz_page.evaluate("""
            (() => {
                const rows = document.querySelectorAll('table tbody tr');
                if (!rows.length) return null;
                const headers = Array.from(document.querySelectorAll('table thead th, table thead td')).map(t => t.innerText.trim());
                const cells = Array.from(rows[0].querySelectorAll('td, th')).map(c => c.innerText.trim());
                return {headers, cells, total_rows: rows.length};
            })()
        """)
        with open(OUT_DIR / "step1_first_row.json", "w", encoding="utf-8") as f:
            json.dump(first_row, f, ensure_ascii=False, indent=2)
        print(f"[+] First row headers: {first_row['headers'] if first_row else 'NONE'}")

        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
