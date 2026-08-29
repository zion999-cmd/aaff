// P0010.2.11 C2 — debug defaultValue shape: dump R (boot value) vs the
// realtime value shape that is known-good, and SzDPParams outputs for both.
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
  const r = await send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true});
  return r.exceptionDetails ? {EXCEPTION: r.exceptionDetails.exception.description} : r.result.value;
};
const out = await evalJs(`
(async () => {
  window.__wr = null;
  window.webpackChunksz_2024.push([[Date.now()%100000], {}, (r) => { window.__wr = r; }]);
  const jD = window.__wr(4461).jD;
  const echo = document.querySelector('span.jmt-combo-date-picker-echo-item');
  if (!echo) return { ERR: 'no echo span' };
  let f = echo[Object.keys(echo).find(k=>k.startsWith('__reactFiber$'))];
  let comp=null;
  for (let i=0;i<10 && f;i++){
    const pp=f.memoizedProps;
    if (pp && pp.onChange && pp.data && pp.refreshInterval===7000) { comp=f; break; }
    f=f.return;
  }
  if (!comp) return { ERR: 'page component not found' };
  const p = comp.memoizedProps;
  const items = p.data.dimVals || p.data;
  const M = items.reduce((acc,it)=>{ if (it && it.key) acc[it.key]={min:it.min,max:it.max}; return acc; },{});
  const itemKeys = items.map(it => it && it.key);
  const E = jD.generateData(items);
  const R = jD.defaultValue(E, { currentKey: 'yesterday' });
  // realtime known-good shape for comparison
  const rt = items.find(it => it && it.key==='realtime');
  const opt = rt.config.panels[0].options[0];
  const resolvedVal = opt.value(opt);
  const hb = (opt.comparesMap||{}).hb;
  const hbResolved = typeof hb.value==='function' ? hb.value(resolvedVal) : hb.value;
  const rtValue = { key:'realtime', value: Object.assign({}, opt, { value: resolvedVal }), compareValue: Object.assign({}, hb, { value: hbResolved }) };
  return {
    itemKeys,
    E_keys: E && typeof E === 'object' ? Object.keys(E) : String(E),
    E_preview: JSON.stringify(E).slice(0, 400),
    R_keys: R && typeof R === 'object' ? Object.keys(R) : String(R),
    R_preview: JSON.stringify(R).slice(0, 600),
    rtValue_preview: JSON.stringify(rtValue).slice(0, 300),
    paramsFromR: jD.SzDPParams(R, M),
    paramsFromRt: jD.SzDPParams(rtValue, M),
    stateValue: JSON.stringify(p.value || null).slice(0, 400)
  };
})()
`);
console.log('RESULT:', JSON.stringify(out, null, 1).slice(0, 3000));
ws.close();process.exit(0);
