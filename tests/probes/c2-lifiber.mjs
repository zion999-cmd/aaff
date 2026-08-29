import WebSocket from '/Users/bx/.hermes/hermes-agent/node_modules/ws/wrapper.mjs';
const list = await (await fetch('http://localhost:9222/json')).json();
const tab = list.find(t => (t.url||'').includes('tradeSummary'));
const ws = new WebSocket(tab.webSocketDebuggerUrl, {perMessageDeflate:false});
let id=0; const pending=new Map(); const ajax=[];
const send=(m,p)=>new Promise((res,rej)=>{const i=++id;pending.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}))});
ws.on('message',(d)=>{const x=JSON.parse(d);
  if(x.id&&pending.has(x.id)){const {res,rej}=pending.get(x.id);pending.delete(x.id);x.error?rej(new Error(JSON.stringify(x.error))):res(x.result);}
  if(x.method==='Network.responseReceived'){const u=x.params.response.url; if(u.includes('getSummary.ajax')||u.includes('getTrend.ajax')) ajax.push(u.split('/').pop().split('?')[0].replace('.ajax',''));}
});
await new Promise(r=>ws.on('open',r));
await send('Network.enable',{});
const ev = async (expr)=> (await send('Runtime.evaluate',{expression:expr,returnByValue:true})).result?.value;
const probe = await ev(`(()=>{
  const li=document.querySelector('li[data-event-content="当前时间_实时"]');
  if(!li) return JSON.stringify({error:'li not in DOM — dropdown closed'});
  const fk=Object.keys(li).find(k=>k.startsWith('__reactFiber$'));
  const out={fk:!!fk, chain:[]};
  let f=li[fk]; let hops=0;
  while(f && hops<10){ const p=f.memoizedProps||{};
    out.chain.push({hops, tag:f.tag, keys:Object.keys(p).filter(k=>/^on[A-Z]/.test(k)).slice(0,6), itemKeys:typeof p.item==='object'&&p.item?['label:'+p.item.label,'key:'+p.item.key]:null});
    f=f.return; hops++;
  }
  return JSON.stringify(out);
})()`);
console.log(probe);
const res2 = await ev(`(()=>{
  const li=document.querySelector('li[data-event-content="当前时间_实时"]');
  if(!li) return 'li missing';
  const fk=Object.keys(li).find(k=>k.startsWith('__reactFiber$'));
  let f=li[fk]; let hops=0; let called=[];
  while(f && hops<10){ const p=f.memoizedProps||{};
    for(const k of Object.keys(p)) if(/^on(Click|Select|Pick|Change)$/.test(k) && typeof p[k]==='function'){
      try{ p[k]({target:li, currentTarget:li}); called.push(hops+':'+k); }catch(e){ called.push(hops+':'+k+':ERR:'+e.message); }
    }
    f=f.return; hops++;
  }
  return JSON.stringify(called);
})()`);
console.log('calls:', res2);
for (let i=1;i<=4;i++) {
  await new Promise(r=>setTimeout(r,5000));
  const s = await ev(`[...document.querySelectorAll('span.jmt-combo-date-picker-echo-item')].map(x=>x.textContent.trim()).join('|')`);
  console.log(`t+${i*5}s echo:`, s, 'ajax:', JSON.stringify(ajax));
  if (ajax.length) break;
}
ws.close();process.exit(0);
