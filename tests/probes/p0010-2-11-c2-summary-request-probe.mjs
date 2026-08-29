// P0010.2.11 C2 probe — capture the page's own getSummary/getTrend REQUEST
// bodies at boot (昨天 mode) so we can mirror the store's param shape when
// invoking the picker's onChange programmatically. Read-only: attaches a
// Network listener and reloads nothing (reads the CURRENT page's next boot
// only when this probe itself navigates).
import WebSocket from '/Users/bx/.hermes/hermes-agent/node_modules/ws/wrapper.mjs';
const list = await (await fetch('http://localhost:9222/json')).json();
const tab = list.find(t => (t.url||'').includes('tradeSummary'));
const ws = new WebSocket(tab.webSocketDebuggerUrl, {perMessageDeflate:false});
let id=0; const pending=new Map(); const bodies=[];
const send=(m,p)=>new Promise((res,rej)=>{const i=++id;pending.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}))});
ws.on('message',(d)=>{const x=JSON.parse(d);
  if(x.id&&pending.has(x.id)){const {res,rej}=pending.get(x.id);pending.delete(x.id);x.error?rej(new Error(JSON.stringify(x.error))):res(x.result);}
  if(x.method==='Network.requestWillBeSent'){const r=x.params.request;
    if(r.url.includes('getSummary.ajax')||r.url.includes('getTrend.ajax')) bodies.push({api:r.url.split('/').pop().split('?')[0], postData:r.postData, urlQuery:r.url.split('?')[1]||''});}
});
await new Promise(r=>ws.on('open',r));
await send('Network.enable',{});
await send('Page.enable',{});
// re-boot the page (same as acquisition's goto) to capture the request bodies
await send('Page.navigate',{url:'https://jdsz.jd.com/szweb/view/tradeAnalysis/tradeSummary.html'});
await new Promise(r=>setTimeout(r,8000));
console.log(JSON.stringify(bodies, null, 1).slice(0, 4000));
ws.close();process.exit(0);
