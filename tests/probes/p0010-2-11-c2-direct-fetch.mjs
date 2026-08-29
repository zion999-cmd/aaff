// P0010.2.11 C2 — DIRECT FETCH: bypass all visibility guards by calling the
// page's own ajax helper (module 99859 s.Fe) with a realtime getSummary body
// (SzDPParams params + boot indicator list). The page's own signed transport
// is used; we verify the response contains TODAY's realtime values.
import WebSocket from '/Users/bx/.hermes/hermes-agent/node_modules/ws/wrapper.mjs';
const list = await (await fetch('http://localhost:9222/json')).json();
const tab = list.find(t => (t.url||'').includes('tradeSummary'));
const ws = new WebSocket(tab.webSocketDebuggerUrl, {perMessageDeflate:false});
let id=0; const pending=new Map(); const reqs=[];
const send=(m,p)=>new Promise((res,rej)=>{const i=++id;pending.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}))});
ws.on('message',(d)=>{const x=JSON.parse(d);
  if(x.id&&pending.has(x.id)){const {res,rej}=pending.get(x.id);pending.delete(x.id);x.error?rej(new Error(JSON.stringify(x.error))):res(x.result);}
  if(x.method==='Network.requestWillBeSent'){const r=x.params.request;
    if(r.url.includes('getSummary.ajax')&&r.postData) reqs.push({rt:/"realtime":true/.test(r.postData), head:r.postData.slice(0,160)});}});
await new Promise(r=>ws.on('open',r));
await send('Network.enable',{});
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true});
  return r.exceptionDetails ? {EXCEPTION: r.exceptionDetails.exception.description} : r.result.value;
};
// Boot (昨天-mode) indicator list captured 2026-08-29 from the page itself.
const BOOT_INDICATORS = ["jdr_sch_trade_deal_ord_ord_amt_sz_trade_deal_snapshot","jdr_sch_trade_deal_ord_ord_amt_sz_trade_deal_snapshot##compareValue","jdr_sch_trade_deal_ord_ord_amt_sz_trade_deal_snapshot##compare","jdr_sch_trade_deal_ord_ord_amt_sz_trade_shop_cate_and_level_snapshot##industry","jdr_sch_trade_deal_ord_ord_amt_sz_trade_shop_cate_and_level_snapshot##preIndustry","jdr_sch_trade_deal_ord_sku_qtty_sz_trade_deal_snapshot","jdr_sch_trade_deal_ord_sku_qtty_sz_trade_deal_snapshot##compareValue","jdr_sch_trade_deal_ord_sku_qtty_sz_trade_deal_snapshot##compare","jdr_sch_trade_deal_ord_sku_qtty_sz_trade_shop_cate_and_level_snapshot##industry","jdr_sch_trade_deal_ord_sku_qtty_sz_trade_shop_cate_and_level_snapshot##preIndustry","jdr_sch_user_deal_ord_user_cnt_sz_user_deal_snapshot","jdr_sch_user_deal_ord_user_cnt_sz_user_deal_snapshot##compareValue","jdr_sch_user_deal_ord_user_cnt_sz_user_deal_snapshot##compare","jdr_sch_user_deal_ord_user_cnt_sz_shop_cate_and_level_user_deal_snapshot##industry","jdr_sch_user_deal_ord_user_cnt_sz_shop_cate_and_level_user_deal_snapshot##preIndustry","jdr_sch_trade_deal_ord_ord_qtty_sz_trade_deal_snapshot","jdr_sch_trade_deal_ord_ord_qtty_sz_trade_deal_snapshot##compareValue","jdr_sch_trade_deal_ord_ord_qtty_sz_trade_deal_snapshot##compare","jdr_sch_trade_deal_ord_ord_qtty_sz_trade_shop_cate_and_level_snapshot##industry","jdr_sch_trade_deal_ord_ord_qtty_sz_trade_shop_cate_and_level_snapshot##preIndustry","fo_jdr_sch_shop_deal_rate","fo_jdr_sch_shop_deal_rate##compareValue","fo_jdr_sch_shop_deal_rate##compare","fo_jdr_sch_trade_deal_ord_amt_user_sz_trade_deal_snapshot","fo_jdr_sch_trade_deal_ord_amt_user_sz_trade_deal_snapshot##compareValue","fo_jdr_sch_trade_deal_ord_amt_user_sz_trade_deal_snapshot##compare","fo_jdr_sch_sz_trade_shop_cate_and_level_deal_snapshot##industry","fo_jdr_sch_sz_trade_shop_cate_and_level_deal_snapshot##preIndustry","jdr_sch_traffic_enter_shop__browse_page_qtty_shop_last_src","jdr_sch_traffic_enter_shop__browse_page_qtty_shop_last_src##compareValue","jdr_sch_traffic_enter_shop__browse_page_qtty_shop_last_src##compare","jdr_sch_traffic_enter_shop__browse_page_cnt_shop_last_src","jdr_sch_traffic_enter_shop__browse_page_cnt_shop_last_src##compareValue","jdr_sch_traffic_enter_shop__browse_page_cnt_shop_last_src##compare","fo_jdr_sch_traffic_enter_shop__browse_page_avg_duration_shop_last_src","fo_jdr_sch_traffic_enter_shop__browse_page_avg_duration_shop_last_src##compareValue","fo_jdr_sch_traffic_enter_shop__browse_page_avg_duration_shop_last_src##compare","jdr_sch_sku_add_cart_sku_user_qtty_product_user_cart_add_minus_sz_bsg_shoppingcart@increase","jdr_sch_sku_add_cart_sku_user_qtty_product_user_cart_add_minus_sz_bsg_shoppingcart@increase##compareValue","jdr_sch_sku_add_cart_sku_user_qtty_product_user_cart_add_minus_sz_bsg_shoppingcart@increase##compare","jdr_sch_sku_add_cart_sku_sku_piece_shopping_cart","jdr_sch_sku_add_cart_sku_sku_piece_shopping_cart##compareValue","jdr_sch_sku_add_cart_sku_sku_piece_shopping_cart##compare","fo_jdr_sch_add_cart_user_uv_rate@increase","fo_jdr_sch_add_cart_user_uv_rate@increase##compareValue","fo_jdr_sch_add_cart_user_uv_rate@increase##compare"];

// pass indicators into the page via a global
await evalJs(`window.__BOOT_INDICATORS = ${JSON.stringify(BOOT_INDICATORS)}; 'ok'`);

const out = await evalJs(`
(async () => {
  window.__wr = null;
  window.webpackChunksz_2024.push([[16], {}, (r) => { window.__wr = r; }]);
  const s = window.__wr(99859);          // page ajax helpers
  const jD = window.__wr(4461).jD;
  const echo = document.querySelector('span.jmt-combo-date-picker-echo-item');
  let f = echo[Object.keys(echo).find(k=>k.startsWith('__reactFiber$'))];
  let comp=null;
  for (let i=0;i<10 && f;i++){
    const pp=f.memoizedProps;
    if (pp && pp.onChange && pp.data && pp.refreshInterval===7000) { comp=f; break; }
    f=f.return;
  }
  const p = comp.memoizedProps;
  const items = p.data.dimVals || p.data;
  const rt = items.find(it => it && it.key==='realtime');
  const opt = rt.config.panels[0].options[0];
  const resolvedVal = opt.value(opt);
  const hb = (opt.comparesMap||{}).hb;
  const hbResolved = typeof hb.value==='function' ? hb.value(resolvedVal) : hb.value;
  const M = items.reduce((acc,it)=>{ if (it && it.key) acc[it.key]={min:it.min,max:it.max}; return acc; },{});
  const value = { key:'realtime', value: Object.assign({}, opt, { value: resolvedVal }), compareValue: Object.assign({}, hb, { value: hbResolved }) };
  const params = jD.SzDPParams(value, M);
  const body = Object.assign({}, params, { channel:'all', indicators: window.__BOOT_INDICATORS });
  try {
    const resp = await s.Fe({ url:'/api/lowcode/tradeSummary/summary/getSummary.ajax', method:'post', data: body });
    return { params, respKeys: resp && Object.keys(resp), success: resp && resp.success, code: resp && resp.code, head: JSON.stringify(resp && (resp.body || resp.data || resp)).slice(0, 1200) };
  } catch(e) {
    return { ERR: e.message, params };
  }
})()
`);
console.log('RESULT:', JSON.stringify(out, null, 1).slice(0, 2500));
console.log('NETWORK REQ:', JSON.stringify(reqs));
ws.close();process.exit(0);
