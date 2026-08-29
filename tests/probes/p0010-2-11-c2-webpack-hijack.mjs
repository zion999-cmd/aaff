// P0010.2.11 C2 probe — hijack webpack require, dump module 24347 + 52306
// exports (looking for the Fe page store and the params builder j), and
// dump their factory sources to data/bundles/module-*.js for offline reading.
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
  window.webpackChunksz_2024.push([[Math.random()], {}, (r) => { window.__wr = r; }]);
  if (!window.__wr) return {ERR:'hijack failed'};
  const inspect = (id) => {
    try {
      const m = window.__wr(id);
      return { id, keys: Object.keys(m), types: Object.keys(m).map(k => k+':'+(typeof m[k]==='function'?'fn':(m[k]&&m[k].Component?'store/comp':typeof m[k]))) };
    } catch(e) { return { id, ERR: e.message }; }
  };
  const src = (id) => { try { return String(window.__wr.m ? window.__wr.m[id] : ''); } catch(e){ return 'src-err:'+e.message; } };
  const r24 = inspect(24347), r52 = inspect(52306);
  // dump factory sources for offline reading
  const dumpSrc = (id) => {
    try { const f = window.__wr.m ? window.__wr.m[id] : null; return f ? String(f) : 'no __wr.m'; }
    catch(e){ return 'err:'+e.message; }
  };
  return { r24, r52, hasM: !!window.__wr.m, s24len: dumpSrc(24347).length, s52len: dumpSrc(52306).length,
           s24: dumpSrc(24347), s52: dumpSrc(52306) };
})()
`);
if (out.s24) writeFileSync('/Users/bx/Workspace/agentFabric/data/bundles/module-24347.js', out.s24);
if (out.s52) writeFileSync('/Users/bx/Workspace/agentFabric/data/bundles/module-52306.js', out.s52);
console.log(JSON.stringify({r24: out.r24, r52: out.r52, hasM: out.hasM, s24len: out.s24len, s52len: out.s52len}, null, 1));
ws.close();process.exit(0);
