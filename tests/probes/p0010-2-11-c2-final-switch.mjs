// P0010.2.11 C2 — the decisive probe. Reload page (background), hijack
// webpack require, resolve jD.SzDPParams, build the realtime value
// (option + resolved value + resolved compare), then call the picker's
// onChange so the page wrapper builds params and updates the Fe store.
// Success = getSummary/getTrend request with "realtime":true.
import WebSocket from '/Users/bx/.hermes/hermes-agent/node_modules/ws/wrapper.mjs';
const list = await (await fetch('http://localhost:9222/json')).json();
const tab = list.find(t => (t.url||'').includes('tradeSummary'));
const ws = new WebSocket(tab.webSocketDebuggerUrl, {perMessageDeflate:false});
let id=0; const pending=new Map(); const reqs=[];
const send=(m,p)=>new Promise((res,rej)=>{const i=++id;pending.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}))});
ws.on('message',(d)=>{const x=JSON.parse(d);
  if(x.id&&pending.has(x.id)){const {res,rej}=pending.get(x.id);pending.delete(x.id);x.error?rej(new Error(JSON.stringify(x.error))):res(x.result);}
  if(x.method==='Network.requestWillBeSent'){const r=x.params.request;
    if((r.url.includes('getSummary.ajax')||r.url.includes('getTrend.ajax'))&&r.postData) reqs.push({api:r.url.split('/').pop().split('?')[0], rt:/"realtime":true/.test(r.postData), head:r.postData.slice(0,260)});}});
await new Promise(r=>ws.on('open',r));
await send('Network.enable',{});
await send('Page.enable',{});
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true});
  return r.exceptionDetails ? {EXCEPTION: r.exceptionDetails.exception.description} : r.result.value;
};
// 1. reload for a clean store (previous probes corrupted it)
await send('Page.navigate',{url:'https://jdsz.jd.com/szweb/view/tradeAnalysis/tradeSummary.html'});
await new Promise(r=>setTimeout(r,9000));
// 2. hijack + inspect + construct + call
const out = await evalJs(`
(() => {
  window.__wr = null;
  window.webpackChunksz_2024.push([[7], {}, (r) => { window.__wr = r; }]);
  if (!window.__wr) return {ERR:'hijack failed'};
  let jD;
  try { jD = window.__wr(4461).jD; } catch(e) { return {ERR:'module 4461: '+e.message}; }
  const fnNames = Object.keys(jD||{});
  const echo = document.querySelector('span.jmt-combo-date-picker-echo-item');
  if (!echo) return {fnNames, ERR:'no echo'};
  let f = echo[Object.keys(echo).find(k=>k.startsWith('__reactFiber$'))];
  let picker=null;
  for (let i=0;i<8 && f;i++){ if (f.memoizedProps && f.memoizedProps.onChange && f.memoizedProps.data) { picker=f; break; } f=f.return; }
  if (!picker) return {fnNames, ERR:'no picker fiber'};
  const p = picker.memoizedProps;
  const rt = (p.data||[]).find(it => it && it.key==='realtime');
  const opt = rt.config.panels[0].options[0];
  const resolvedVal = opt.value(opt);            // ['2026-08-29', [[h,m,s],[h,m,s]]]
  // resolve the hb compare: fn(e){return e=Z(e),[g().dayHb,e[1]]}
  let hbResolved = null, hbErr = null;
  const hb = (opt.comparesMap||{}).hb;
  if (hb && typeof hb.value === 'function') {
    try { hbResolved = hb.value(resolvedVal); } catch(e) { hbErr = e.message; }
  }
  // M (min/max map) from data items, mirroring the wrapper's reduce
  const M = (p.data||[]).reduce((acc,it)=>{ if (it && it.key) acc[it.key]={min:it.min,max:it.max}; return acc; },{});
  const buildValue = (compareValue) => ({ key:'realtime', value: Object.assign({}, opt, { value: resolvedVal }), compareValue });
  const report = { fnNames, resolvedVal, hbResolved: hbResolved ? JSON.parse(JSON.stringify(hbResolved,(k,v)=>typeof v==='function'?'[fn]':v)) : null, hbErr, M };
  // pre-check params via SzDPParams without touching the store
  try { report.paramsPreview = jD.SzDPParams ? JSON.parse(JSON.stringify(jD.SzDPParams(buildValue(hbResolved), M))) : 'no SzDPParams'; }
  catch(e) { report.paramsPreviewErr = e.message; }
  return report;
})()
`);
console.log('PREP:', JSON.stringify(out).slice(0, 2500));
if (out.EXCEPTION || out.ERR) { ws.close(); process.exit(1); }
// 3. call onChange with the prepared value (fresh evaluation; pass via serialized args)
const callOut = await evalJs(`
(() => {
  const jD = window.__wr(4461).jD;
  const echo = document.querySelector('span.jmt-combo-date-picker-echo-item');
  let f = echo[Object.keys(echo).find(k=>k.startsWith('__reactFiber$'))];
  let picker=null;
  for (let i=0;i<8 && f;i++){ if (f.memoizedProps && f.memoizedProps.onChange && f.memoizedProps.data) { picker=f; break; } f=f.return; }
  const p = picker.memoizedProps;
  const rt = (p.data||[]).find(it => it && it.key==='realtime');
  const opt = rt.config.panels[0].options[0];
  const resolvedVal = opt.value(opt);
  const hb = (opt.comparesMap||{}).hb;
  let hbResolved = null;
  try { hbResolved = typeof hb.value==='function' ? hb.value(resolvedVal) : hb.value; } catch(e) { hbResolved = hb; }
  const M = (p.data||[]).reduce((acc,it)=>{ if (it && it.key) acc[it.key]={min:it.min,max:it.max}; return acc; },{});
  const value = { key:'realtime', value: Object.assign({}, opt, { value: resolvedVal }), compareValue: Object.assign({}, hb, { value: hbResolved }) };
  try {
    p.onChange(value);           // wrapper: setTimeout(() => { params=j(value,M); Fe.updates.updateValue({...}) })
    return { called:true, params: JSON.parse(JSON.stringify(jD.SzDPParams(value, M))) };
  } catch(e) { return { called:false, err: e.message }; }
})()
`);
console.log('CALL:', JSON.stringify(callOut).slice(0, 1500));
await new Promise(r=>setTimeout(r,8000));
console.log('AJAX:', JSON.stringify(reqs, null, 1).slice(0, 1600));
const after = await evalJs(`({echo: (document.querySelector('span.jmt-combo-date-picker-echo-item')||{}).innerText || null, broken: document.body.innerText.includes('combo-date-picker错误')})`);
console.log('AFTER:', JSON.stringify(after));
ws.close();process.exit(0);
