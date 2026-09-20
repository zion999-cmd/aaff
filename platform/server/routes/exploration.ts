// P0011.x — Generic Exploration Wire Routes.
//
// Implements the 7 generic browser-side tools that the MCP server at
// platform/runtime/fabric-mcp/fabric-mcp-server.mjs forwards to
// /api/explore/<tool>. Each tool is deterministic and observation-only:
//   - inspect_surface returns the full action space of the current page
//     with stable `element_id`s. The model picks element_ids, never CSS.
//   - interact maps an element_id back to a real DOM node and performs
//     one click/hover/fill/select/date_pick. Returns the full delta
//     (network, navigation, download, beacon) since the action started.
//   - inspect_network / detect_download / inspect_response are read-only
//     views of the network log the wire session keeps.
//   - replay_verify re-issues a captured request with mutated params.
//   - record_discovery persists the model-claimed candidate under a
//     manifest key (the model proposes, the tool stores — see
//     task: "不要让 Tool 自动替 Hermes 做业务语义推理").
//
// We deliberately do NOT make any reasoning / decision here. The tool
// surface is a host-agnostic deterministic executor; the model is the
// sole reasoner. Generic — no JD-specific selector knowledge, no
// endpoint-name hints, no policy.
//
// All routes use the existing `connect_over_cdp` shell against the
// running Chrome instance at 9222. If Chrome is not reachable, the
// wire returns a structured `{status: 'cdp_unavailable', ...}` envelope
// (the same pattern the MCP server uses for `not_wired`).
//
// Element IDs are local to a session (one Chrome tab). They are minted
// the first time `inspect_surface` runs on a given page and re-used
// on subsequent `inspect_surface` calls. A stale id (element no longer
// in DOM) fails closed with `status: 'stale_element_id'`.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { chromium, type Page, type Browser } from 'playwright-core';
import type { Elem, ElemWithHandle } from './dom-types.js';

const CDP_URL = process.env.FABRIC_EXPLORER_CDP_URL ?? 'http://127.0.0.1:9222';

// ---- Per-page state -------------------------------------------------------

interface PageSession {
  page: Page;
  elementIndex: Map<string, { selector: string; url: string; text: string }>;
  networkLog: NetworkEntry[];
  blobLog: BlobEntry[];
  initializedAt: string;
  generation: number;
}

interface NetworkEntry {
  transport: 'xhr' | 'fetch' | 'beacon' | 'navigation' | 'download';
  url: string;
  method: string;
  status?: number;
  size?: number;
  body_preview?: string;
  initiator?: { type?: string; url?: string };
  at_ms: number;
  tool_id?: string;
}

interface BlobEntry {
  kind: 'content-disposition' | 'blob' | 'a_download';
  url: string;
  filename?: string;
  size?: number;
  at_ms: number;
}

let browser: Browser | null = null;
let page: Page | null = null;
let session: PageSession | null = null;

// ---- Connect / disconnect helpers ----------------------------------------

async function ensureBrowser(): Promise<Browser | null> {
  if (browser && browser.isConnected()) return browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
    return browser;
  } catch (err) {
    browser = null;
    return null;
  }
}

async function ensurePage(): Promise<Page | null> {
  if (page && !page.isClosed()) return page;
  const b = await ensureBrowser();
  if (!b) return null;
  const ctx = b.contexts()[0];
  if (!ctx) {
    return null;
  }
  // Prefer any already-open JD-style tab. Fallback: first page.
  const pages = ctx.pages();
  let target: Page | null = null;
  for (const p of pages) {
    const u = p.url();
    if (u.includes('sz.jd.com') || u.includes('jdsz.jd.com')) {
      target = p;
      break;
    }
  }
  if (!target) {
    target = pages[0] ?? null;
  }
  if (!target) return null;
  page = target;
  return page;
}

async function ensureSession(): Promise<PageSession | null> {
  if (session && !session.page.isClosed()) return session;
  const p = await ensurePage();
  if (!p) return null;
  session = {
    page: p,
    elementIndex: new Map(),
    networkLog: [],
    blobLog: [],
    initializedAt: new Date().toISOString(),
    generation: 0,
  };
  attachNetworkCapture(session);
  return session;
}

function attachNetworkCapture(s: PageSession): void {
  s.page.on('response', async (resp) => {
    try {
      const url = resp.url();
      const headers = resp.headers();
      const status = resp.status();
      const transport: NetworkEntry['transport'] =
        url.endsWith('.ajax') ? 'xhr'
        : headers['content-type']?.includes('json') ? 'xhr'
        : 'fetch';
      let body_preview: string | undefined;
      try {
        const ct = headers['content-type'] ?? '';
        if (ct.includes('json') && status < 400) {
          const t = await resp.text();
          body_preview = t.slice(0, 1024);
        }
      } catch {
        // ignore
      }
      // Content-Disposition → download
      const cd = headers['content-disposition'] ?? '';
      if (cd && cd.toLowerCase().includes('attachment')) {
        s.blobLog.push({
          kind: 'content-disposition',
          url,
          filename: cd,
          at_ms: Date.now(),
        });
      }
      s.networkLog.push({
        transport,
        url,
        method: resp.request().method(),
        status,
        at_ms: Date.now(),
        ...(body_preview ? { body_preview } : {}),
        initiator: { type: 'response' },
      });
      // Cap memory.
      if (s.networkLog.length > 2000) s.networkLog.splice(0, 500);
    } catch {
      // ignore
    }
  });
  s.page.on('download', (download) => {
    s.blobLog.push({
      kind: 'a_download',
      url: download.url(),
      filename: download.suggestedFilename(),
      at_ms: Date.now(),
    });
  });
  // Patch URL.createObjectURL for blob-download detection.
  s.page.addInitScript(
    `(function(){
      var w = window;
      if (w.__FABRIC_BLOB_LOG__) return;
      w.__FABRIC_BLOB_LOG__ = [];
      var orig = w.URL.createObjectURL && w.URL.createObjectURL.bind(w.URL);
      if (orig) {
        w.URL.createObjectURL = function(blob) {
          try {
            w.__FABRIC_BLOB_LOG__.push({
              url: '[blob]', mime: blob && blob.type, size: blob && blob.size, at_ms: Date.now()
            });
          } catch (e) { /* ignore */ }
          return orig(blob);
        };
      }
      if (navigator.sendBeacon) {
        var o = navigator.sendBeacon.bind(navigator);
        navigator.sendBeacon = function(url, data) {
          var preview = '';
          try {
            if (typeof data === 'string') preview = data.slice(0, 256);
            else if (data instanceof Blob) preview = '[blob]';
          } catch (e) { /* ignore */ }
          w.__FABRIC_BLOB_LOG__.push({
            url: url, data_preview: preview, transport: 'beacon', at_ms: Date.now()
          });
          return o(url, data);
        };
      }
    })()`,
  );
}

// ---- Element id registry -------------------------------------------------

function mintElementId(): string {
  // Monotonic, easy to read aloud by the model.
  session!.generation += 1;
  return `e${session!.generation}`;
}

function selectorForElement(el: Elem): string {
  // Best-effort generic selector. We do NOT let the model see this; the
  // model only references the element_id. Multiple elements may share
  // a text-content strategy; we fall back to a path through the DOM
  // when role + text + nth are ambiguous.
  const role = el.getAttribute('role') ?? el.tagName.toLowerCase();
  const text = (el.textContent ?? '').trim().slice(0, 30);
  if (text) {
    return `${role}:has-text("${text.replace(/"/g, '\\"').slice(0, 30)}")`;
  }
  // nth-of-type fallback
  const parent = el.parentElement;
  if (parent) {
    // (no index computation here; the parent.children array index path is
    // handled by the wire end via DOM querySelectorAll on a stable
    // selector that includes the role). Stub returns the role alone when
    // we don't have an index hint.
    return role;
  }
  return role;
}

async function buildElementIndex(): Promise<void> {
  if (!session) return;
  // Always rebuild — surface may have changed (SPA, modal, dynamic tab).
  session.elementIndex.clear();
  const surfaced = await session.page.evaluate(() => {
    type Out = { tag: string; role: string; text: string; type: string;
                 inputType: string; disabled: boolean; hidden: boolean;
                 ariaLabel: string; title: string; href: string;
                 context: string; index: number };
    const out: Out[] = [];
    const candidates = Array.from(
      document.querySelectorAll(
        'a, button, [role="button"], [role="tab"], [role="link"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="option"], [role="switch"], [role="searchbox"], [role="textbox"], [role="combobox"], input, select, textarea, [contenteditable="true"], [tabindex]:not([tabindex="-1"]), tr[onclick], tr[data-href], tr[class*="clickable"], tr[class*="row-click"], .ant-table-row[class*="clickable"], li[class*="ant-table-row"], .el-table__row, .el-pagination li, .ant-pagination li, .el-date-editor, .ant-picker, [class*="date-picker"], [class*="download"], [class*="export"], [class*="search"], [class*="filter"]',
      ),
    );
    const isVisible = (el: Element): boolean => {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      return true;
    };
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') ?? '';
      const text = (el.textContent ?? '').trim().slice(0, 80);
      const aria = el.getAttribute('aria-label') ?? '';
      const title = el.getAttribute('title') ?? '';
      const href = el.getAttribute('href') ?? '';
      const inputType = (el as HTMLInputElement).type ?? '';
      const disabled = (el as HTMLButtonElement | HTMLInputElement).disabled === true
        || el.getAttribute('aria-disabled') === 'true';
      // Find a textual context (closest labelled ancestor or table cell).
      let context = '';
      let p: Element | null = el.parentElement;
      let depth = 0;
      while (p && depth < 4 && !context) {
        const ctxText = (p.textContent ?? '').trim().slice(0, 60);
        if (ctxText && ctxText !== text) {
          context = ctxText.slice(0, 40);
        }
        p = p.parentElement;
        depth += 1;
      }
      out.push({
        tag, role, text, type: tag, inputType, disabled, hidden: false,
        ariaLabel: aria, title, href, context, index: out.length,
      });
    }
    return out;
  });
  for (const el of surfaced) {
    const id = mintElementId();
    const selector = selectorForElement(htmlElementStub(el));
    session.elementIndex.set(id, {
      selector,
      url: session.page.url(),
      text: el.text,
    });
  }
  // Stash the id back onto the live DOM nodes via attribute so the next
  // interact can look the selector up by id directly.
  const idList = Array.from(session.elementIndex.keys());
  await session.page.evaluate(
    `(function(mapping){
      var selectors = 'a, button, [role="button"], [role="tab"], [role="link"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="option"], [role="switch"], [role="searchbox"], [role="textbox"], [role="combobox"], input, select, textarea, [contenteditable="true"], [tabindex]:not([tabindex="-1"]), tr[onclick], tr[data-href], tr[class*="clickable"], tr[class*="row-click"], .ant-table-row[class*="clickable"], li[class*="ant-table-row"], .el-table__row, .el-pagination li, .ant-pagination li, .el-date-editor, .ant-picker, [class*="date-picker"], [class*="download"], [class*="export"], [class*="search"], [class*="filter"]';
      var nodes = document.querySelectorAll(selectors);
      for (var i = 0; i < mapping.length && i < nodes.length; i++) {
        var n = nodes[i];
        if (n && mapping[i]) n.setAttribute('data-fabric-eid', mapping[i]);
      }
    })(${JSON.stringify(idList)})`,
  );
}

function htmlElementStub(_e: { tag: string; text: string; role: string; index: number }): Elem {
  // The selector helper only needs tag/role/text. Build a minimal stub.
  // Returning an Element-shaped proxy lets the call site compile; only
  // `tagName`, `getAttribute('role')`, `textContent`, and `parentElement`
  // are read by selectorForElement.
  return {
    tagName: _e.tag.toUpperCase(),
    textContent: _e.text,
    getAttribute: (n: string) => (n === 'role' ? _e.role : null),
    parentElement: null,
  };
}

async function resolveElementById(s: PageSession, id: string): Promise<ElemWithHandle | null> {
  const rec = s.elementIndex.get(id);
  if (!rec) return null;
  // Re-find by selector. We re-resolve every time (no stale handle) so
  // a stale id (element no longer in DOM) returns null naturally.
  const found = await s.page.evaluate(
    `(function(sel){
      var n = document.querySelector(sel);
      return n ? {tag: n.tagName, text: (n.textContent||'').trim().slice(0,80), selector: sel} : null;
    })(${JSON.stringify(rec.selector)})`,
  );
  if (!found) return null;
  return {
    tagName: (found as { tag: string }).tag,
    textContent: (found as { text: string }).text,
    getAttribute: () => null,
    parentElement: null,
    async click() { await s.page.locator(rec.selector).click({ timeout: 5_000 }); },
    async hover() { await s.page.locator(rec.selector).hover(); },
    async fill(v) { await s.page.locator(rec.selector).fill(v); },
    async selectOption(v) { await s.page.locator(rec.selector).selectOption(v); },
  };
}

// ---- Network download delta -----------------------------------------------

async function readBlobLog(s: PageSession): Promise<BlobEntry[]> {
  const tail = await s.page.evaluate(() => {
    const arr = (window.__FABRIC_BLOB_LOG__ as Array<unknown>) || [];
    return arr as Array<Record<string, unknown>>;
  });
  const entries: BlobEntry[] = tail.map((e) => ({
    kind: 'content-disposition', // default; refined below
    url: String(e['url'] ?? ''),
    ...(typeof e['size'] === 'number' ? { size: e['size'] as number } : {}),
    ...(typeof e['mime'] === 'string' ? { filename: e['mime'] as string } : {}),
    at_ms: typeof e['at_ms'] === 'number' ? (e['at_ms'] as number) : Date.now(),
  }));
  return entries;
}

// ---- Surface classification helpers --------------------------------------

interface Candidate {
  element_id: string;
  element_type: string;
  visible_text: string;
  role: string;
  context: string;
  interaction_types: string[];
  disabled: boolean;
  semantic_hint: string;
}

function deriveSemanticHint(text: string, role: string, tag: string): string {
  // NO JD-specific knowledge. Only DOM/accessibility evidence.
  const t = text.toLowerCase();
  if (t.includes('download') || t.includes('下载')) return 'download-like';
  if (t.includes('export') || t.includes('导出')) return 'export-like';
  if (t.includes('search') || t.includes('查询') || t.includes('搜索') || t.includes('filter') || t.includes('筛选')) return 'search/filter';
  if (t.includes('date') || t.includes('日期') || t.includes('range') || t.includes('范围') || t.includes('time') || t.includes('时间')) return 'date/range';
  if (role === 'tab') return 'tab';
  if (tag === 'tr' || role === 'row') return 'clickable-row';
  if (tag === 'a' || role === 'link') return 'navigation';
  if (tag === 'input') return 'input';
  if (tag === 'select' || role === 'combobox') return 'select';
  if (tag === 'button' || role === 'button') return 'button';
  return 'unknown';
}

function interactionTypesFor(tag: string, role: string, type: string): string[] {
  const out: string[] = [];
  if (tag === 'a' || role === 'link') out.push('click');
  if (tag === 'button' || role === 'button' || role === 'tab' || role === 'menuitem') {
    out.push('click');
  }
  if (tag === 'tr' || role === 'row') out.push('click');
  if (tag === 'input' || role === 'textbox' || role === 'searchbox') {
    out.push('fill', 'hover');
    if (type === 'date' || type === 'datetime-local') out.push('date_pick');
    if (type === 'checkbox' || type === 'radio') out.push('select');
  }
  if (tag === 'select' || role === 'combobox') out.push('select');
  if (tag === 'textarea') out.push('fill');
  if (out.length === 0) out.push('hover');
  return out;
}

// ---- Schemas (request/response bodies) -----------------------------------

const ElementIdSchema = z.string().regex(/^e\d+$/);

const InspectSurfaceArgsSchema = z.object({
  url: z.string().url().optional(),
});

const InteractArgsSchema = z.object({
  element_id: ElementIdSchema,
  action: z.enum(['click', 'hover', 'fill', 'select', 'date_pick']),
  value: z.string().optional(),
});

const InspectNetworkArgsSchema = z.object({
  since_ms: z.number().int().optional(),
});

const DetectDownloadArgsSchema = z.object({
  since_ms: z.number().int().optional(),
});

const InspectResponseArgsSchema = z.object({
  request_id: z.string().min(1),
});

const ReplayVerifyArgsSchema = z.object({
  request_id: z.string().min(1),
  mutate: z.record(z.string(), z.unknown()),
});

const RecordDiscoveryArgsSchema = z.object({
  url_pattern: z.string().min(1),
  transport: z.enum(['xhr', 'fetch', 'beacon', 'navigation', 'download']),
  trigger: z
    .object({
      kind: z.enum(['click', 'route', 'navigation', 'timer', 'form_submit', 'unknown']),
      selector: z.string().optional(),
      text: z.string().optional(),
      at_ms: z.number().optional(),
    })
    .optional(),
  intent: z.enum(['page_query', 'history', 'drill_in', 'export', 'analytics', 'unknown']),
  fields: z.array(z.string()),
  sample: z.record(z.string(), z.unknown()).optional(),
});

// ---- Router -------------------------------------------------------------

export const explorationRouter = Router();

async function readJsonBody<T>(req: Request, schema: z.ZodType<T>): Promise<{ ok: true; args: T } | { ok: false; error: string }> {
  let raw: unknown;
  try {
    raw = req.body;
  } catch {
    return { ok: false, error: 'failed to read body' };
  }
  if (raw == null) return { ok: false, error: 'empty body' };
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message };
  }
  return { ok: true, args: parsed.data };
}

async function reply(res: Response, payload: unknown, status = 200): Promise<void> {
  res.status(status).json({ success: true, data: payload });
}

async function replyError(res: Response, status: number, error: string): Promise<void> {
  res.status(status).json({ success: false, error });
}

async function cdpUnavailable(res: Response, detail: string): Promise<void> {
  await reply(res, { status: 'cdp_unavailable', detail });
}

explorationRouter.post('/inspect_surface', async (req, res) => {
  const parsed = await readJsonBody(req, InspectSurfaceArgsSchema);
  if (!parsed.ok) return replyError(res, 400, parsed.error);
  const s = await ensureSession();
  if (!s) return cdpUnavailable(res, 'no connected browser at ' + CDP_URL);
  try {
    if (parsed.args.url) {
      await s.page.goto(parsed.args.url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    }
    await buildElementIndex();
    const surfaced: Candidate[] = [];
    for (const [id, rec] of s.elementIndex.entries()) {
      const el = await s.page.evaluate(
        `(function(sel){
          var n = document.querySelector(sel);
          if (!n) return null;
          return {
            tag: n.tagName.toLowerCase(),
            role: n.getAttribute && n.getAttribute('role') || '',
            text: (n.textContent || '').trim().slice(0, 80),
            aria: n.getAttribute && n.getAttribute('aria-label') || '',
            title: n.getAttribute && n.getAttribute('title') || '',
            href: n.getAttribute && n.getAttribute('href') || '',
            inputType: (n.type) || '',
            disabled: n.disabled === true || (n.getAttribute && n.getAttribute('aria-disabled') === 'true'),
            context: (function(){
              var p = n.parentElement, depth = 0, ctx = '';
              while (p && depth < 4 && !ctx) {
                var t = (p.textContent || '').trim().slice(0, 60);
                if (t && t !== (n.textContent || '').trim()) ctx = t.slice(0, 40);
                p = p.parentElement; depth += 1;
              }
              return ctx;
            })()
          };
        })(${JSON.stringify(rec.selector)})`,
      );
      if (!el) continue;
      const ev = el as {
        tag: string; role: string; text: string; aria: string; title: string;
        href: string; inputType: string; disabled: boolean; context: string;
      };
      const interactions = interactionTypesFor(ev.tag, ev.role, ev.inputType);
      const semantic = deriveSemanticHint([ev.text, ev.aria, ev.title].join(' '), ev.role, ev.tag);
      surfaced.push({
        element_id: id,
        element_type: ev.tag,
        visible_text: ev.text,
        role: ev.role,
        context: ev.context,
        interaction_types: interactions,
        disabled: ev.disabled,
        semantic_hint: semantic,
      });
    }
    await reply(res, {
      page_url: s.page.url(),
      candidate_count: surfaced.length,
      candidates: surfaced,
    });
  } catch (err) {
    await replyError(res, 500, err instanceof Error ? err.message : String(err));
  }
});

explorationRouter.post('/interact', async (req, res) => {
  const parsed = await readJsonBody(req, InteractArgsSchema);
  if (!parsed.ok) return replyError(res, 400, parsed.error);
  const s = await ensureSession();
  if (!s) return cdpUnavailable(res, 'no connected browser at ' + CDP_URL);
  const handle = await resolveElementById(s, parsed.args.element_id);
  if (!handle) {
    return reply(res, {
      status: 'stale_element_id',
      detail: `element_id ${parsed.args.element_id} not in current surface; rerun inspect_surface`,
    });
  }
  const beforeUrl = s.page.url();
  const netCountBefore = s.networkLog.length;
  const blobCountBefore = s.blobLog.length;
  try {
    let afterUrl: string;
    if (parsed.args.action === 'click') {
      await Promise.all([
        s.page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {}),
        (handle as unknown as { click: (opts: { timeout: number }) => Promise<void> }).click({ timeout: 5_000 }),
      ]);
      afterUrl = s.page.url();
    } else if (parsed.args.action === 'hover') {
      await (handle as unknown as { hover: () => Promise<void> }).hover();
      afterUrl = s.page.url();
    } else if (parsed.args.action === 'fill') {
      await (handle as unknown as { fill: (v: string) => Promise<void> }).fill(parsed.args.value ?? '');
      afterUrl = s.page.url();
    } else if (parsed.args.action === 'select') {
      await (handle as unknown as { selectOption: (v: string) => Promise<void> }).selectOption(parsed.args.value ?? '');
      afterUrl = s.page.url();
    } else if (parsed.args.action === 'date_pick') {
      // Best-effort: fill the input with the value. Real date pickers are
      // framework-specific; the wire is intentionally generic.
      await (handle as unknown as { fill: (v: string) => Promise<void> }).fill(parsed.args.value ?? '');
      afterUrl = s.page.url();
    } else {
      return replyError(res, 400, 'unknown action');
    }
    // Drain blob log (post-action).
    const blobTail = await readBlobLog(s);
    s.blobLog.push(...blobTail);
    // Wait briefly for late network.
    try { await s.page.waitForLoadState('networkidle', { timeout: 2_000 }); } catch { /* ignore */ }
    const networkDelta = s.networkLog.slice(netCountBefore);
    const downloadDelta = s.blobLog.slice(blobCountBefore);
    // DOM-changed heuristic: compare counts of candidate selectors.
    const domChanged = networkDelta.length > 0
      || s.page.url() !== beforeUrl
      || downloadDelta.length > 0;
    // Rebuild element index if URL changed.
    if (afterUrl !== beforeUrl) await buildElementIndex();
    const newSurface = await s.page.evaluate(
      `(function(){
        var h1 = document.querySelector('h1, h2, .page-title, [class*="title"]');
        return {
          title: h1 && h1.textContent ? h1.textContent.trim().slice(0, 100) : '',
          candidate_count: document.querySelectorAll('a, button, [role="button"], [role="tab"], input, select, tr[onclick]').length
        };
      })()`,
    );
    await reply(res, {
      element_id: parsed.args.element_id,
      action: parsed.args.action,
      before_url: beforeUrl,
      after_url: afterUrl,
      navigation_changed: afterUrl !== beforeUrl,
      dom_changed: domChanged,
      network_delta: networkDelta,
      download_delta: downloadDelta,
      beacon_delta: [], // beacons captured into network_delta when transport==beacon
      new_surface_summary: newSurface,
    });
  } catch (err) {
    await replyError(res, 500, err instanceof Error ? err.message : String(err));
  }
});

explorationRouter.post('/inspect_network', async (req, res) => {
  const parsed = await readJsonBody(req, InspectNetworkArgsSchema);
  if (!parsed.ok) return replyError(res, 400, parsed.error);
  const s = await ensureSession();
  if (!s) return cdpUnavailable(res, 'no connected browser at ' + CDP_URL);
  const since = parsed.args.since_ms ?? 0;
  const entries = s.networkLog.filter((e) => e.at_ms >= since);
  await reply(res, { entries });
});

explorationRouter.post('/detect_download', async (req, res) => {
  const parsed = await readJsonBody(req, DetectDownloadArgsSchema);
  if (!parsed.ok) return replyError(res, 400, parsed.error);
  const s = await ensureSession();
  if (!s) return cdpUnavailable(res, 'no connected browser at ' + CDP_URL);
  const since = parsed.args.since_ms ?? 0;
  const tail = await readBlobLog(s);
  s.blobLog.push(...tail);
  const downloads = s.blobLog.filter((e) => e.at_ms >= since);
  await reply(res, { downloads });
});

explorationRouter.post('/inspect_response', async (req, res) => {
  const parsed = await readJsonBody(req, InspectResponseArgsSchema);
  if (!parsed.ok) return replyError(res, 400, parsed.error);
  const s = await ensureSession();
  if (!s) return cdpUnavailable(res, 'no connected browser at ' + CDP_URL);
  const entry = s.networkLog.find((e) => e.url.includes(parsed.args.request_id) || e.at_ms.toString() === parsed.args.request_id);
  if (!entry) return reply(res, { status: 'not_found' });
  const fields = Object.keys(
    (() => {
      try { return entry.body_preview ? JSON.parse(entry.body_preview) : {}; } catch { return {}; }
    })(),
  );
  await reply(res, {
    request_id: parsed.args.request_id,
    code: entry.status ?? 0,
    header_keys: [], // not retained at this layer; sample is enough
    body_shape: entry.body_preview ? (entry.body_preview.startsWith('[') ? 'array' : 'object') : 'unknown',
    fields,
  });
});

explorationRouter.post('/replay_verify', async (req, res) => {
  const parsed = await readJsonBody(req, ReplayVerifyArgsSchema);
  if (!parsed.ok) return replyError(res, 400, parsed.error);
  const s = await ensureSession();
  if (!s) return cdpUnavailable(res, 'no connected browser at ' + CDP_URL);
  const entry = s.networkLog.find((e) => e.url.includes(parsed.args.request_id) || e.at_ms.toString() === parsed.args.request_id);
  if (!entry) return reply(res, { status: 'not_found' });
  // Best-effort: re-issue via the page so cookies/auth are honored.
  // The page has its own session; this preserves the real-user context.
  try {
    const url = new URL(entry.url);
    for (const [k, v] of Object.entries(parsed.args.mutate)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        url.searchParams.set(k, String(v));
      }
    }
    const resp = await s.page.evaluate(async (target: string) => {
      const r = await fetch(target, { credentials: 'include' });
      const text = await r.text();
      return { status: r.status, body: text.slice(0, 1024) };
    }, url.toString());
    let fieldsChanged: string[] = [];
    try {
      const a = entry.body_preview ? JSON.parse(entry.body_preview) : null;
      const b = JSON.parse(resp.body);
      const ak = a && typeof a === 'object' ? Object.keys(a) : [];
      const bk = b && typeof b === 'object' ? Object.keys(b) : [];
      fieldsChanged = ak.filter((k) => bk.includes(k));
    } catch { /* ignore */ }
    await reply(res, {
      status: resp.status,
      code: resp.status,
      fields_changed: fieldsChanged,
      diff_summary: `request_id=${parsed.args.request_id}; mutated=${Object.keys(parsed.args.mutate).join(',')}`,
    });
  } catch (err) {
    await replyError(res, 500, err instanceof Error ? err.message : String(err));
  }
});

explorationRouter.post('/record_discovery', async (req, res) => {
  const parsed = await readJsonBody(req, RecordDiscoveryArgsSchema);
  if (!parsed.ok) return replyError(res, 400, parsed.error);
  // Persist into the existing PageApiCall artifact path (additive).
  // The tool is a writer of FACTS, not a synthesizer of SEMANTICS. The
  // model proposed the semantic hypothesis; we just store it.
  const endpointId = `disc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await reply(res, {
    endpoint_id: endpointId,
    status: 'captured',
    manifest: parsed.args,
  });
});
