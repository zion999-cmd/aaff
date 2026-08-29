// P0010.2.11 C2 probe — dump picker props.value shape (current yesterday-mode
// store value) and the realtime option's config function sources, so we can
// construct a correctly-shaped onChange event. Read-only.
import WebSocket from '/Users/bx/.hermes/hermes-agent/node_modules/ws/wrapper.mjs';
const list = await (await fetch('http://localhost:9222/json')).json();
const tab = list.find(t => (t.url||'').includes('tradeSummary'));
const ws = new WebSocket(tab.webSocketDebuggerUrl, {perMessageDeflate:false});
let id=0; const pending=new Map();
const send=(m,p)=>new Promise((res,rej)=>{const i=++id;pending.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}))});
ws.on('message',(d)=>{const x=JSON.parse(d);
  if(x.id&&pending.has(x.id)){const {res,rej}=pending.get(x.id);pending.delete(x.id);x.error?rej(new Error(JSON.stringify(x.error))):res(x.result);}});
await new Promise(r=>ws.on('open',r));
const evalJs = async (expr) => (await send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true})).result.value;

const out = await evalJs(`
(() => {
  const dump = (v, depth) => {
    if (v === null || v === undefined) return v;
    if (typeof v === 'function') return 'FN: ' + String(v).slice(0, 300);
    if (depth > 4) return Array.isArray(v) ? '[arr]' : typeof v;
    if (Array.isArray(v)) return v.map(x => dump(x, depth+1));
    if (typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = dump(v[k], depth+1); return o; }
    return v;
  };
  const echo = document.querySelector('span.jmt-combo-date-picker-echo-item');
  let f = echo[Object.keys(echo).find(k=>k.startsWith('__reactFiber$'))];
  let picker=null;
  for (let i=0;i<8 && f;i++){ if (f.memoizedProps && f.memoizedProps.onChange && f.memoizedProps.data) { picker=f; break; } f=f.return; }
  const p = picker.memoizedProps;
  return {
    value: dump(p.value, 0),
    onChangeSrc: String(p.onChange).slice(0, 800),
    onRefreshSrc: p.onRefresh ? String(p.onRefresh).slice(0, 400) : null,
  };
})()
`);
console.log(JSON.stringify(out, null, 1));
ws.close();process.exit(0);
