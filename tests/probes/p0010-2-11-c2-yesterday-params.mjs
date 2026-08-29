// P0010.2.11 C2 — build yesterday (offline) params from the 'yesterday' item
// directly (deterministic, independent of the page's current picker mode),
// mirroring the proven realtime construction. Then fire the offline trend
// request and verify 7 daily categories.
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
  const s = window.__wr(99859);
  const jD = window.__wr(4461).jD;
  const trendM = window.__wr(22886).M;
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
  const y = items.find(it => it && it.key==='yesterday');
  const yValueType = typeof y.value;
  const yResolved = yValueType === 'function' ? y.value(y) : y.value;
  // full p.value for reference (compareValue shape)
  const fullStateValue = JSON.stringify(p.value).slice(0, 1200);
  const yValue = { key:'yesterday', value: Object.assign({}, y, { value: yResolved }), compareValue: Object.assign({}, y, { value: yResolved }) };
  const paramsFromState = jD.SzDPParams(p.value, M);
  const paramsFromItem = jD.SzDPParams(yValue, M);
  // fire trend from the state-derived params (page's own boot state)
  const trendParams = trendM(paramsFromState, 6);
  const INDICATORS = ["jdr_sch_trade_deal_ord_ord_amt_sz_trade_deal_snapshot","jdr_sch_trade_deal_ord_ord_qtty_sz_trade_deal_snapshot","jdr_sch_traffic_enter_shop__browse_page_cnt_shop_last_src","fo_jdr_sch_shop_deal_rate"];
  const body = Object.assign({}, trendParams, { channel:'all', indicators: INDICATORS });
  try {
    const resp = await s.Fe({ url:'/api/lowcode/tradeSummary/summary/getTrend.ajax', method:'post', data: body });
    const t = resp && resp.body && resp.body.data && resp.body.data[0] && resp.body.data[0].trend;
    return {
      yValueType,
      yResolved: JSON.stringify(yResolved).slice(0,200),
      fullStateValue,
      paramsFromState,
      paramsFromItem,
      trendParams,
      code: resp && resp.header && resp.header.code,
      categories: t && t.categories,
      series: t && t.series ? t.series.map(x=>({code:x.code, n:x.data.length, last:x.data[x.data.length-1]})) : null
    };
  } catch(e) { return { ERR: e.message, paramsFromState, trendParams }; }
})()
`);
console.log('RESULT:', JSON.stringify(out, null, 1).slice(0, 3500));
ws.close();process.exit(0);
