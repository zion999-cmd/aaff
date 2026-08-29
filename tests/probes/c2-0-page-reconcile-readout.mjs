// C2.0 clean re-run observation — READ-ONLY page reconciliation.
// Connects to the operator's Chrome (:9222), finds the existing tradeSummary
// tab, and reads the currently displayed values straight from the DOM.
// NO navigation, NO clicks, NO page activation — background CDP evaluate only.
import { existsSync } from 'node:fs';

const cdpPort = 9222;
const list = await (await fetch(`http://localhost:${cdpPort}/json`)).json();
const tab = list.find((t) => t.type === 'page' && t.url.includes('tradeSummary.html'));
if (!tab) {
  console.log(JSON.stringify({ ok: false, error: 'no tradeSummary tab' }));
  process.exit(0);
}

// Raw CDP over the tab's own websocket — no new tabs, no activation.
// Node 22 ships a global WebSocket client.

const ws = new WebSocket(tab.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
});
await new Promise((r, j) => {
  ws.addEventListener('open', r);
  ws.addEventListener('error', j);
});

const expr = `(() => {
  const echo = document.querySelector('span.jmt-combo-date-picker-echo-item');
  const text = document.body.innerText;
  const pick = (label) => {
    const idx = text.indexOf(label);
    if (idx < 0) return null;
    return text.slice(idx, idx + 40).replace(/\\n/g, ' | ');
  };
  return {
    url: location.href.slice(-40),
    echo: echo ? echo.textContent : null,
    成交金额: pick('成交金额'),
    成交单量: pick('成交单量'),
    订单: pick('订单'),
    店铺访客数: pick('店铺访客数'),
    访客数: pick('访客数'),
    店铺成交转化率: pick('店铺成交转化率'),
    转化率: pick('转化率'),
    对比时间: pick('对比时间'),
    实时: pick('实时'),
  };
})()`;
const res = await send('Runtime.evaluate', {
  expression: expr,
  returnByValue: true,
});
console.log(JSON.stringify(res.result?.value ?? res, null, 2));
ws.close();
process.exit(0);
