// P0010.2.11 C2 — switch to realtime, then capture ALL ajax endpoints fired
// (not just getSummary/getTrend) to find which API realtime mode actually
// calls. Boot requests are captured first as the baseline.
import WebSocket from '/Users/bx/.hermes/hermes-agent/node_modules/ws/wrapper.mjs';
const list = await (await fetch('http://localhost:9222/json')).json();
const tab = list.find(t => (t.url||'').includes('tradeSummary'));
const ws = new WebSocket(tab.webSocketDebuggerUrl, {perMessageDeflate:false});
let id=0; const pending=new Map(); let phase='boot'; const reqs=[];
const send=(m,p)=>new Promise((res,rej)=>{const i=++id;pending.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}))});
ws.on('message',(d)=>{const x=JSON.parse(d);
  if(x.id&&pending.has(x.id)){const {res,rej}=pending.get(x.id);pending.delete(x.id);x.error?rej(new Error(JSON.stringify(x.error))):res(x.result);}
  if(x.method==='Network.requestWillBeSent'){const r=x.params.request;
    if(/\.ajax|api\/lowcode/.test(r.url)) reqs.push({phase, url:r.url.replace('https://szgateway.jd.com','').slice(0,90), rt: r.postData ? /"realtime":true/.test(r.postData) : null});}});
await new Promise(r=>ws.on('open',r));
await send('Network.enable',{});
await send('Page.enable',{});
await send('Page.navigate',{url:'https://jdsz.jd.com/szweb/view/tradeAnalysis/tradeSummary.html'});
await new Promise(r=>setTimeout(r,9000));
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true});
  return r.exceptionDetails ? {EXCEPTION: r.exceptionDetails.exception.description} : r.result.value;
};
phase='switch';
await evalJs(`
(() => {
  window.__wr = null;
  window.webpackChunksz_2024.push([[10], {}, (r) => { window.__wr = r; }]);
  const jD = window.__wr(4461).jD;
  const trend = window.__wr(22886);
  const echo = document.querySelector('span.jmt-combo-date-picker-echo-item');
  let f = echo[Object.keys(echo).find(k=>k.startsWith('__reactFiber$'))];
  let pageComp=null;
  for (let i=0;i<10 && f;i++){
    const pp=f.memoizedProps;
    if (pp && pp.onChange && pp.data && pp.refreshInterval===7000) { pageComp=f; break; }
    f=f.return;
  }
  const p = pageComp.memoizedProps;
  const items = p.data.dimVals || p.data;
  const rt = items.find(it => it && it.key==='realtime');
  const opt = rt.config.panels[0].options[0];
  const resolvedVal = opt.value(opt);
  const hb = (opt.comparesMap||{}).hb;
  const hbResolved = typeof hb.value==='function' ? hb.value(resolvedVal) : hb.value;
  const M = items.reduce((acc,it)=>{ if (it && it.key) acc[it.key]={min:it.min,max:it.max}; return acc; },{});
  const value = { key:'realtime', value: Object.assign({}, opt, { value: resolvedVal }), compareValue: Object.assign({}, hb, { value: hbResolved }) };
  const params = jD.SzDPParams(value, M);
  p.onChange({ value, params, trendParams: trend.M(params,6), downloadParams: trend.M(params,0) });
  return 'ok';
})()
`);
await new Promise(r=>setTimeout(r,12000));
phase='idle';
const bootUrls = reqs.filter(r=>r.phase==='boot').map(r=>r.url);
const switchUrls = reqs.filter(r=>r.phase==='switch').map(r=>`${r.url} realtime=${r.rt}`);
console.log('BOOT endpoints:'); console.log([...new Set(bootUrls)].join('\n'));
console.log('\nSWITCH-phase endpoints:'); console.log([...new Set(switchUrls)].join('\n') || '(none)');
const after = await evalJs(`({echo: (document.querySelector('span.jmt-combo-date-picker-echo-item')||{}).innerText || null, broken: document.body.innerText.includes('combo-date-picker错误'), bodyHead: document.body.innerText.slice(0,150)})`);
console.log('\nAFTER:', JSON.stringify(after));
ws.close();process.exit(0);
