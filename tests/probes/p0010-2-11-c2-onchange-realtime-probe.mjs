// P0010.2.11 C2 probe — invoke the picker's onChange with correctly-shaped
// events (key 'realtime') and watch for a getSummary request whose postData
// contains "realtime":true. Background-only (no bringToFront).
import WebSocket from '/Users/bx/.hermes/hermes-agent/node_modules/ws/wrapper.mjs';
const list = await (await fetch('http://localhost:9222/json')).json();
const tab = list.find(t => (t.url||'').includes('tradeSummary'));
const ws = new WebSocket(tab.webSocketDebuggerUrl, {perMessageDeflate:false});
let id=0; const pending=new Map(); const realtimeReqs=[];
const send=(m,p)=>new Promise((res,rej)=>{const i=++id;pending.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}))});
ws.on('message',(d)=>{const x=JSON.parse(d);
  if(x.id&&pending.has(x.id)){const {res,rej}=pending.get(x.id);pending.delete(x.id);x.error?rej(new Error(JSON.stringify(x.error))):res(x.result);}
  if(x.method==='Network.requestWillBeSent'){const r=x.params.request;
    if(r.url.includes('getSummary.ajax')&&r.postData) realtimeReqs.push({rt:/"realtime":true/.test(r.postData), postData:r.postData.slice(0,220)});}
});
await new Promise(r=>ws.on('open',r));
await send('Network.enable',{});
const evalJs = async (expr) => (await send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true})).result.value;

const attempt = `
(async () => {
  const echo = document.querySelector('span.jmt-combo-date-picker-echo-item');
  if (!echo) return 'no echo';
  let f = echo[Object.keys(echo).find(k=>k.startsWith('__reactFiber$'))];
  let picker = null;
  for (let i=0;i<6 && f;i++){ if (f.memoizedProps && f.memoizedProps.onChange && f.memoizedProps.data) { picker=f; break; } f=f.return; }
  if (!picker) return 'no picker fiber';
  const p = picker.memoizedProps;
  const rt = (p.data||[]).find(it => it && it.key==='realtime');
  if (!rt) return 'no realtime item; keys=' + (p.data||[]).map(i=>i&&i.key).join(',');
  return { ok:true, itemKeys:(p.data||[]).map(i=>i&&i.key).join(','), rt: JSON.parse(JSON.stringify(rt, (k,v)=> typeof v==='function' ? '[fn]' : v)) };
})()
`;
const found = await evalJs(attempt);
console.log('REALTIME ITEM:', JSON.stringify(found).slice(0,600));

// attempt 1: minimal shape {key, value}
const tryShape = (label, eventJson) => evalJs(`
(async () => {
  const echo = document.querySelector('span.jmt-combo-date-picker-echo-item');
  let f = echo[Object.keys(echo).find(k=>k.startsWith('__reactFiber$'))];
  let picker=null;
  for (let i=0;i<6 && f;i++){ if (f.memoizedProps && f.memoizedProps.onChange && f.memoizedProps.data) { picker=f; break; } f=f.return; }
  const p = picker.memoizedProps;
  const rt = (p.data||[]).find(it => it && it.key==='realtime');
  try { p.onChange(${eventJson}); return 'called'; } catch(e){ return 'throw: '+e.message; }
})()
`);
const shapes = [
  ['minimal {key,value}', `{key:'realtime', value: rt}`],
];
for (const [label, expr] of shapes) {
  realtimeReqs.length = 0;
  const r = await tryShape(label, expr.replace(/rt/g, `(p.data||[]).find(it=>it&&it.key==='realtime')`));
  await new Promise(r2=>setTimeout(r2,4000));
  console.log(`ATTEMPT ${label} -> handler:`, r, '| ajax:', JSON.stringify(realtimeReqs));
}
ws.close();process.exit(0);
