// P0010.2.11 C2 — dump module 99859 exports (the page's ajax helper s.Fe)
// to confirm how to call it directly with the realtime request body.
import WebSocket from '/Users/bx/.hermes/hermes-agent/node_modules/ws/wrapper.mjs';
const list = await (await fetch('http://localhost:9222/json')).json();
const tab = list.find(t => (t.url||'').includes('tradeSummary'));
const ws = new WebSocket(tab.webSocketDebuggerUrl, {perMessageDeflate:false});
let id=0; const pending=new Map();
const send=(m,p)=>new Promise((res,rej)=>{const i=++id;pending.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}))});
ws.on('message',(d)=>{const x=JSON.parse(d);
  if(x.id&&pending.has(x.id)){const {res,rej}=pending.get(x.id);pending.delete(x.id);x.error?rej(new Error(JSON.stringify(x.error))):res(x.result);}});
await new Promise(r=>ws.on('open',r));
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true});
  return r.exceptionDetails ? {EXCEPTION: r.exceptionDetails.exception.description} : r.result.value;
};
const out = await evalJs(`
(() => {
  window.__wr = null;
  window.webpackChunksz_2024.push([[15], {}, (r) => { window.__wr = r; }]);
  const s = window.__wr(99859);
  const out2 = { keys: Object.keys(s), types: {} };
  for (const k of Object.keys(s)) out2.types[k] = typeof s[k];
  if (typeof s.Fe === 'function') out2.FeSrc = String(s.Fe).slice(0, 1500);
  return out2;
})()
`);
console.log(JSON.stringify(out, null, 1).slice(0, 4000));
ws.close();process.exit(0);
