// P0010.2.11 C2 — same switch attempt, but capture the ACTUAL exception
// (Runtime.exceptionThrown) that breaks the picker render after
// Fe.updates.updateValue receives our realtime value.
import WebSocket from '/Users/bx/.hermes/hermes-agent/node_modules/ws/wrapper.mjs';
const list = await (await fetch('http://localhost:9222/json')).json();
const tab = list.find(t => (t.url||'').includes('tradeSummary'));
const ws = new WebSocket(tab.webSocketDebuggerUrl, {perMessageDeflate:false});
let id=0; const pending=new Map(); const exceptions=[]; const reqs=[];
const send=(m,p)=>new Promise((res,rej)=>{const i=++id;pending.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}))});
ws.on('message',(d)=>{const x=JSON.parse(d);
  if(x.id&&pending.has(x.id)){const {res,rej}=pending.get(x.id);pending.delete(x.id);x.error?rej(new Error(JSON.stringify(x.error))):res(x.result);}
  if(x.method==='Network.requestWillBeSent'){const r=x.params.request;
    if((r.url.includes('getSummary.ajax')||r.url.includes('getTrend.ajax'))&&r.postData) reqs.push({api:r.url.split('/').pop().split('?')[0], rt:/"realtime":true/.test(r.postData)});}
  if(x.method==='Runtime.exceptionThrown'){
    const e=x.params.exceptionDetails;
    exceptions.push({text:e.text, desc:e.exception&&e.exception.description?String(e.exception.description).slice(0,1800):null});
  }});
await new Promise(r=>ws.on('open',r));
await send('Runtime.enable',{});
await send('Page.enable',{});
await send('Page.navigate',{url:'https://jdsz.jd.com/szweb/view/tradeAnalysis/tradeSummary.html'});
await new Promise(r=>setTimeout(r,9000));
exceptions.length=0; reqs.length=0;
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true});
  return r.exceptionDetails ? {EXCEPTION: r.exceptionDetails.exception.description} : r.result.value;
};
const callOut = await evalJs(`
(() => {
  window.__wr = null;
  window.webpackChunksz_2024.push([[8], {}, (r) => { window.__wr = r; }]);
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
  const hbResolved = typeof hb.value==='function' ? hb.value(resolvedVal) : hb.value;
  const M = (p.data||[]).reduce((acc,it)=>{ if (it && it.key) acc[it.key]={min:it.min,max:it.max}; return acc; },{});
  const value = { key:'realtime', value: Object.assign({}, opt, { value: resolvedVal }), compareValue: Object.assign({}, hb, { value: hbResolved }) };
  try { p.onChange(value); return { called:true, params: jD.SzDPParams(value, M) }; }
  catch(e) { return { called:false, err: e.message }; }
})()
`);
console.log('CALL:', JSON.stringify(callOut));
await new Promise(r=>setTimeout(r,6000));
console.log('EXCEPTIONS:', JSON.stringify(exceptions, null, 1).slice(0, 3000));
console.log('AJAX:', JSON.stringify(reqs));
ws.close();process.exit(0);
