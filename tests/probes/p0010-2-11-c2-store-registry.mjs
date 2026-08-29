// P0010.2.11 C2 — inspect the store lib (module 27022) for a global store
// registry so we can reach the guarded stores (Ne/Ve/Ie/Ke) directly.
import WebSocket from '/Users/bx/.hermes/hermes-agent/node_modules/ws/wrapper.mjs';
import { writeFileSync } from 'node:fs';
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
  window.webpackChunksz_2024.push([[14], {}, (r) => { window.__wr = r; }]);
  const m = window.__wr(27022);
  const out2 = { keys: Object.keys(m), types: {} };
  for (const k of Object.keys(m)) out2.types[k] = typeof m[k];
  // dump factory source too big? get it separately
  try { out2.srcLen = String(window.__wr.m[27022]).length; } catch(e){ out2.srcLen = 'err'; }
  return out2;
})()
`);
writeFileSync('/Users/bx/Workspace/agentFabric/data/bundles/module-27022.js', String(out.srcLen||''));
console.log(JSON.stringify(out, null, 1).slice(0, 2000));
ws.close();process.exit(0);
