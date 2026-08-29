// P0010.2.11 C2 — dump the jD helper function sources (nextValue,
// pickDatePicerValue, getOptionItem, valueDestructuring, isValueValid,
// realtimeKeys) to find the canonical value builder for an item click.
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
  window.webpackChunksz_2024.push([[11], {}, (r) => { window.__wr = r; }]);
  const jD = window.__wr(4461).jD;
  const dump = {};
  for (const k of ['nextValue','pickDatePicerValue','getOptionItem','valueDestructuring','isValueValid']) {
    dump[k] = typeof jD[k] === 'function' ? String(jD[k]).slice(0, 2200) : String(jD[k]);
  }
  dump.realtimeKeys = jD.realtimeKeys;
  return dump;
})()
`);
console.log(JSON.stringify(out, null, 1).slice(0, 11000));
ws.close();process.exit(0);
