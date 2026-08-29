// P0010.2.11 C2 probe — full dump of the realtime item's todayRealtime
// quick option (ALL keys, full fn sources) + call its value/echo fns to get
// resolved values. Read-only.
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
const out = await evalJs(`
(() => {
  const fnSrc = (v) => typeof v === 'function' ? String(v) : undefined;
  const echo = document.querySelector('span.jmt-combo-date-picker-echo-item');
  if (!echo) return {ERR:'no echo'};
  let f = echo[Object.keys(echo).find(k=>k.startsWith('__reactFiber$'))];
  let picker=null;
  for (let i=0;i<8 && f;i++){ if (f.memoizedProps && f.memoizedProps.onChange && f.memoizedProps.data) { picker=f; break; } f=f.return; }
  const p = picker.memoizedProps;
  const rt = (p.data||[]).find(it => it && it.key==='realtime');
  const opt = rt.config.panels[0].options[0];
  const srcs = {};
  for (const k of Object.keys(opt)) {
    const s = fnSrc(opt[k]);
    if (s) srcs[k] = s.slice(0, 700);
  }
  // try resolving the option's value via its own fns (if any)
  let resolved = null;
  try {
    if (typeof opt.value === 'function') resolved = {viaValueFn: opt.value(opt)};
    else if (opt.echo && typeof opt.echo === 'function') resolved = {viaEcho: opt.echo(opt)};
  } catch(e) { resolved = {ERR: e.message}; }
  return {
    optKeys: Object.keys(opt),
    quickOption: opt.quickOption,
    srcs,
    resolved,
    realtimeItemKeys: Object.keys(rt),
    rtHasValue: 'value' in rt,
  };
})()
`);
console.log(JSON.stringify(out, null, 1).slice(0, 7000));
ws.close();process.exit(0);
