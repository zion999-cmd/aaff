// P0010.2.11 — real-page reconciliation (read-only). Extract the 4 displayed
// 核心指标 values from the live page DOM via raw CDP (no clicks, no store
// writes, no tab activation). The page is in 昨天 (8/28) mode, so these must
// equal the Fabric offline getTrend 8/28 point.
import WebSocket from '/Users/bx/.hermes/hermes-agent/node_modules/ws/wrapper.mjs';
const list = await (await fetch('http://localhost:9222/json')).json();
const tab = list.find(t => (t.url||'').includes('tradeSummary'));
if (!tab) { console.log('NO TAB'); process.exit(1); }
const ws = new WebSocket(tab.webSocketDebuggerUrl, {perMessageDeflate:false});
let id=0; const pending=new Map();
const send=(m,p)=>new Promise((res,rej)=>{const i=++id;pending.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}))});
ws.on('message',(d)=>{const x=JSON.parse(d);
  if(x.id&&pending.has(x.id)){const {res,rej}=pending.get(x.id);pending.delete(x.id);x.error?rej(new Error(JSON.stringify(x.error))):res(x.result);}});
await new Promise(r=>ws.on('open',r));
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate',{expression:expr,returnByValue:true});
  return r.exceptionDetails ? {EXCEPTION: r.exceptionDetails.exception.description} : r.result.value;
};
const out = await evalJs(`
(() => {
  // The page renders each core metric as a block with label + value. Grab
  // the whole card grid text so we can see labels adjacent to values.
  const text = (sel) => Array.from(document.querySelectorAll(sel)).map(n => (n.textContent||'').trim());
  // Fallback: the main metric container
  const bodyText = document.body.innerText;
  const grab = (label) => {
    const idx = bodyText.indexOf(label);
    if (idx < 0) return null;
    return bodyText.slice(idx, idx + 80).replace(/\\n/g, ' | ');
  };
  return {
    echo: (document.querySelector('span.jmt-combo-date-picker-echo-item')||{}).textContent || null,
    gmv: grab('成交金额'),
    orders: grab('成交订单量') || grab('订单量'),
    visitors: grab('店铺访客数') || grab('访客数'),
    cvr: grab('成交转化率'),
    uv: grab('商品访客数'),
  };
})()
`);
console.log('PAGE:', JSON.stringify(out, null, 1));
ws.close();process.exit(0);
