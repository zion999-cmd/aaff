// Search the live webpack module cache for modules containing 'currentKey'
// and dump the defaultValue / initValue sources. Read-only.
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
  const hits = [];
  const scan = (modules, label) => {
    for (const k of Object.keys(modules)) {
      let src;
      try { src = typeof modules[k] === 'function' ? String(modules[k]) : (modules[k] && String(modules[k].toString?modules[k]:'')); } catch(e){ continue; }
      if (typeof src === 'string' && src.includes('currentKey')) {
        const i = src.indexOf('currentKey');
        hits.push({label, id:k, ctx: src.slice(Math.max(0,i-400), i+400)});
      }
    }
  };
  // webpack 5 chunk cache: window.webpackChunk<name> arrays; find require cache
  const chunkKeys = Object.keys(window).filter(k=>k.startsWith('webpackChunk'));
  const out2 = {chunkKeys};
  // walk chunk arrays -> they only hold module factories; installed modules live in __webpack_require__.c if exposed
  for (const ck of chunkKeys) {
    const arr = window[ck];
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      if (!entry || !entry[1]) continue;
      scan(entry[1], ck);
    }
  }
  out2.hits = hits.slice(0, 8).map(h => ({...h, ctx: h.ctx.slice(0,800)}));
  out2.hitCount = hits.length;
  return out2;
})()
`);
console.log(JSON.stringify(out, null, 1).slice(0, 8000));
ws.close();process.exit(0);
