// P0010.2.11 C2 — CONTROL: reload in background, wait up to 30s, log every
// ajax with timestamps. Establishes whether the boot fetch fires reliably
// in a background tab before we blame the lazyLoad guards.
import WebSocket from '/Users/bx/.hermes/hermes-agent/node_modules/ws/wrapper.mjs';
const list = await (await fetch('http://localhost:9222/json')).json();
const tab = list.find(t => (t.url||'').includes('tradeSummary'));
const ws = new WebSocket(tab.webSocketDebuggerUrl, {perMessageDeflate:false});
let id=0; const pending=new Map(); const t0=Date.now(); const events=[];
const send=(m,p)=>new Promise((res,rej)=>{const i=++id;pending.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}))});
ws.on('message',(d)=>{const x=JSON.parse(d);
  if(x.id&&pending.has(x.id)){const {res,rej}=pending.get(x.id);pending.delete(x.id);x.error?rej(new Error(JSON.stringify(x.error))):res(x.result);}
  if(x.method==='Network.requestWillBeSent'){const r=x.params.request;
    if(/\.ajax/.test(r.url)) events.push(`+${((Date.now()-t0)/1000).toFixed(1)}s ${r.url.replace('https://szgateway.jd.com','').slice(0,80)} ${r.postData&&/"realtime":true/.test(r.postData)?'REALTIME':''}`);}});
await new Promise(r=>ws.on('open',r));
await send('Network.enable',{});
await send('Page.enable',{});
await send('Page.navigate',{url:'https://jdsz.jd.com/szweb/view/tradeAnalysis/tradeSummary.html'});
await new Promise(r=>setTimeout(r,30000));
console.log(events.join('\n') || '(no ajax at all)');
ws.close();process.exit(0);
