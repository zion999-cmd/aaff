// P0010.2.11 C2 probe — open the date dropdown (background), find the 实时
// option li's React fiber, and dump the SOURCE of every onClick along its
// owner chain so we can see how the picker constructs the onChange event.
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
// 1. click echo to open dropdown
await evalJs(`(() => { const e=document.querySelector('span.jmt-combo-date-picker-echo-item'); e && e.click(); return !!e; })()`);
await new Promise(r=>setTimeout(r,1200));
// 2. find 实时 li and dump onClick sources up the chain
const out = await evalJs(`
(() => {
  const li = document.querySelector('li[data-event-content="当前时间_实时"]');
  if (!li) return {ERR:'no li', lis: [...document.querySelectorAll('li[data-event-content]')].map(l=>l.getAttribute('data-event-content'))};
  const hops = [];
  let f = li[Object.keys(li).find(k=>k.startsWith('__reactFiber$'))];
  for (let i=0; i<12 && f; i++) {
    const p = f.memoizedProps;
    if (p && (p.onClick || p.onSelect || p.onChange)) {
      hops.push({hop:i, type:f.tag, onClick: p.onClick?String(p.onClick).slice(0,1500):null, onSelect: p.onSelect?String(p.onSelect).slice(0,1500):null});
    }
    f = f.return;
  }
  return {hops};
})()
`);
console.log(JSON.stringify(out, null, 1).slice(0, 9000));
ws.close();process.exit(0);
