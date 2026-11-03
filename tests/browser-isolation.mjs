// Manual browser regression: node --experimental-sqlite tests/browser-isolation.mjs
// Open http://127.0.0.1:8769. Uses synthetic in-memory data and the real view handler.
import { createServer } from 'node:http';
import { fixture } from './helpers.mjs';
import { onRequestGet } from '../site/functions/api/sections/[id]/view.js';

const env = fixture();
const dataUrl = '/api/sections/sales/data?days=120';
const probe = `<!doctype html><html><body><h2>Isolation probe</h2><pre id="result">Running</pre><script>
(async()=>{
  const checks=[];
  const check=(name,pass)=>checks.push({name,pass});
  const blocked=(name,fn)=>{try{fn();check(name,false);}catch(e){check(name,e.name==='SecurityError');}};
  if(parent!==window)blocked('parent DOM',()=>parent.document.body.textContent);
  blocked('cookies',()=>document.cookie);
  blocked('localStorage',()=>localStorage.getItem('fixture'));
  try{const data=await(await fetch('${dataUrl}')).json();check('allowed snapshot',data.ok&&data.section==='sales');}catch(e){check('allowed snapshot',false);}
  try{await fetch('/api/users',{method:'POST',body:'synthetic'});check('API fetch denied',false);}catch(e){check('API fetch denied',true);}
  const xhrBlocked=await new Promise(resolve=>{const x=new XMLHttpRequest();x.onload=()=>resolve(false);x.onerror=()=>resolve(true);x.ontimeout=()=>resolve(false);x.timeout=3000;try{x.open('GET','/api/probe');x.send();}catch(e){resolve(true);}});
  check('native XHR denied',xhrBlocked);
  document.getElementById('result').textContent=JSON.stringify(checks,null,2);
  parent.postMessage({kind:'isolation-results',checks},'*');
})();</script></body></html>`;
env.sqlite.prepare("INSERT OR REPLACE INTO sections (id,name,config) VALUES ('sales','Synthetic','{}')").run();
env.sqlite.prepare("INSERT INTO section_versions (section,version,html,active) VALUES ('sales',1,?,1)").run(probe);
let unexpected = 0;
const host = `<!doctype html><html><meta charset="utf-8"><title>P1 HTML isolation checks</title><body>
<h1>P1 HTML isolation checks</h1><p>Synthetic data; no production connection.</p><pre id="results">Running</pre>
<iframe title="iframe sandbox" sandbox="allow-scripts" src="/api/sections/sales/view?case=iframe"></iframe>
<iframe title="CSP header only" src="/api/sections/sales/view?case=header"></iframe>
<p><a href="/api/sections/sales/view">Check direct opening</a></p>
<script>let count=0;const output=[];document.cookie='synthetic_cookie=1';localStorage.setItem('fixture','synthetic');
addEventListener('message',async e=>{if(e.data?.kind!=='isolation-results')return;
 output.push({case:++count,opaqueOrigin:e.origin==='null',checks:e.data.checks});
 const hits=await(await fetch('/hits')).json();
 const pass=count===2&&hits.unexpected===0&&output.every(r=>r.opaqueOrigin&&r.checks.every(c=>c.pass));
 document.querySelector('#results').textContent=(pass?'PASS: both frames isolated; zero API requests':'Running or FAILED')+String.fromCharCode(10)+JSON.stringify({output,hits},null,2);
});</script></body></html>`;
const server = createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://127.0.0.1:8769');
    let response;
    if(url.pathname==='/')response=new Response(host,{headers:{'content-type':'text/html;charset=utf-8'}});
    else if(url.pathname==='/hits')response=Response.json({unexpected});
    else if(url.pathname==='/api/sections/sales/view')response=await onRequestGet({request:new Request(url,{headers:{cookie:'shtab_s=fixture-session'}}),env,params:{id:'sales'}});
    else if(url.pathname==='/favicon.ico')response=new Response(null,{status:204});
    else {unexpected++;response=Response.json({unexpected},{status:418});}
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  } catch(e) {res.writeHead(500);res.end(String(e));}
});
server.listen(8769,'127.0.0.1',()=>console.log('Synthetic isolation test: http://127.0.0.1:8769'));
process.on('SIGINT',()=>server.close(()=>{env.sqlite.close();process.exit(0);}));
