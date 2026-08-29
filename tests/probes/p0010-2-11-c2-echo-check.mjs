// Check page state + whether echo exists; report exceptions.
import WebSocket from '/Users/bx/.hermes/hermes-agent/node_modules/ws/wrapper.mjs';
const list = await (await fetch('http://localhost:9222/json')).json();
console.log('TABS:', list.filter(t=>t.type==='page').map(t=>(t.url||'').slice(0,90)));
const tab = list.find(t => (t.url||'').includes('tradeSummary'));
const ws = new WebSocket(tab.webSocketDebuggerUrl, {perMessageDeflate:false});
let id=0; const pending=new Map();
const send=(m,p)=>new Promise((res,rej)=>{const i=++id;pending.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}))});
ws.on('message',(d)=>{const x=JSON.parse(d);
  if(x.id&&pending.has(x.id)){const {res,rej}=pending.get(x.id);pending.delete(x.id);x.error?rej(new Error(JSON.stringify(x.error))):res(x.result);}});
await new Promise(r=>ws.on('open',r));
const r = await send('Runtime.evaluate',{expression:`({url:location.href.slice(0,120), echo: !!document.querySelector('span.jmt-combo-date-picker-echo-item'), echoAll: document.querySelectorAll('[class*="date-picker-echo"]').length, bodyLen: document.body ? document.body.innerText.length : 0, head: document.body ? document.body.innerText.slice(0,200) : ''})`,returnByValue:true});
console.log(JSON.stringify(r, null, 1).slice(0,1500));
ws.close();process.exit(0);
