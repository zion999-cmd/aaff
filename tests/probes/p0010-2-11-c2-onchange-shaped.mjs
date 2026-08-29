// P0010.2.11 C2 probe — invoke picker onChange with a fully-shaped realtime
// event mirroring the yesterday-mode value structure:
//   { key:'realtime', value:{...todayRealtime, value:resolved}, compareValue:{...hb,resolved} }
// Watch for a getSummary request whose postData contains "realtime":true.
import WebSocket from '/Users/bx/.hermes/hermes-agent/node_modules/ws/wrapper.mjs';
const list = await (await fetch('http://localhost:9222/json')).json();
const tab = list.find(t => (t.url||'').includes('tradeSummary'));
const ws = new WebSocket(tab.webSocketDebuggerUrl, {perMessageDeflate:false});
let id=0; const pending=new Map(); const reqs=[];
const send=(m,p)=>new Promise((res,rej)=>{const i=++id;pending.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}))});
ws.on('message',(d)=>{const x=JSON.parse(d);
  if(x.id&&pending.has(x.id)){const {res,rej}=pending.get(x.id);pending.delete(x.id);x.error?rej(new Error(JSON.stringify(x.error))):res(x.result);}
  if(x.method==='Network.requestWillBeSent'){const r=x.params.request;
    if((r.url.includes('getSummary.ajax')||r.url.includes('getTrend.ajax'))&&r.postData) reqs.push({api:r.url.split('/').pop().split('?')[0], rt:/"realtime":true/.test(r.postData), head:r.postData.slice(0,180)});}});
await new Promise(r=>ws.on('open',r));
await send('Network.enable',{});
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true});
  return r.exceptionDetails ? {EXCEPTION: r.exceptionDetails.exception.description} : r.result.value;
};
const out = await evalJs(`
(() => {
  const echo = document.querySelector('span.jmt-combo-date-picker-echo-item');
  if (!echo) return {ERR:'no echo', body: document.body.innerText.slice(0,200)};
  let f = echo[Object.keys(echo).find(k=>k.startsWith('__reactFiber$'))];
  let picker=null;
  for (let i=0;i<8 && f;i++){ if (f.memoizedProps && f.memoizedProps.onChange && f.memoizedProps.data) { picker=f; break; } f=f.return; }
  const p = picker.memoizedProps;
  const rt = (p.data||[]).find(it => it && it.key==='realtime');
  const opt = rt.config.panels[0].options[0];
  const compares = (opt.compares||[]).map(c => ({key:c.key, value:c.value, type:typeof c.value}));
  const resolved = opt.value(opt);
  const hb = (opt.compares||[]).find(c=>c.key==='hb');
  try {
    p.onChange({
      key: 'realtime',
      value: Object.assign({}, opt, { value: resolved }),
      compareValue: hb || null,
    });
    return { called:true, compares, resolved, hbValue: hb ? hb.value : null };
  } catch(e) { return { called:false, err: e.message }; }
})()
`);
console.log('CALL RESULT:', JSON.stringify(out).slice(0,900));
await new Promise(r=>setTimeout(r,6000));
console.log('AJAX:', JSON.stringify(reqs, null, 1));
const after = await evalJs(`({echo: (document.querySelector('span.jmt-combo-date-picker-echo-item')||{}).innerText || null, err: document.body.innerText.includes('combo-date-picker错误')})`);
console.log('AFTER:', JSON.stringify(after));
ws.close();process.exit(0);
