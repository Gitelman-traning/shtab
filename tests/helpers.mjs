import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

export const root = new URL('../', import.meta.url);
export function fixture(perms = {}, role = 'member') {
  const sqlite = new DatabaseSync(':memory:');
  // schema20 restores the overwritten prep migration and already includes schema18.
  const order = file => file === 'schema20.sql' ? 17.5 : +(file.match(/\d+/)?.[0] || 1);
  for (const file of readdirSync(root).filter(f => /^schema\d*\.sql$/.test(f) && f !== 'schema18.sql').sort((a,b) => order(a) - order(b))) {
    sqlite.exec(readFileSync(new URL(file, root), 'utf8'));
  }
  const calls = [];
  function statement(sql, args = []) {
    const execute = kind => {
      calls.push({sql,args,kind});
      const q = sqlite.prepare(sql);
      if (kind === 'first') return q.get(...args) || null;
      if (kind === 'all') return { results:q.all(...args), success:true };
      const r = q.run(...args); return { meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)},success:true };
    };
    return {sql,args,bind:(...a)=>statement(sql,a),first:async()=>execute('first'),all:async()=>execute('all'),run:async()=>execute('run'),execute};
  }
  const DB = { prepare:sql=>statement(sql), calls, batch:async statements=>{
    sqlite.exec('BEGIN');
    try { const results=statements.map(s=>s.execute('run'));sqlite.exec('COMMIT');return results; }
    catch(e) {sqlite.exec('ROLLBACK');throw e;}
  }};
  sqlite.prepare("INSERT INTO users (login,name,pass_hash,salt,role,active) VALUES ('reader','Synthetic Reader','','',?,1)").run(role);
  sqlite.prepare("INSERT INTO sessions (id,login,expires) VALUES ('fixture-session','reader','2099-01-01T00:00:00.000Z')").run();
  for (const [section,level] of Object.entries(perms)) sqlite.prepare("INSERT INTO perms (login,section,level) VALUES ('reader',?,?)").run(section,level);
  for (const m of JSON.parse(readFileSync(new URL('metrics.json',root),'utf8'))) {
    sqlite.prepare('INSERT OR REPLACE INTO metrics (id,name,section,unit,kind,definition) VALUES (?,?,?,?,?,?)').run(m.id,m.name,m.section,m.unit,m.kind,m.definition);
  }
  const kv=new Map(), kvCalls=[];
  return {sqlite,DB,kv,kvCalls,INGEST_TOKEN:'fixture-ingest',OKK_KV:{
    get:async key=>{kvCalls.push(['get',key]);return kv.get(key)??null;},
    put:async(key,value)=>{kvCalls.push(['put',key]);kv.set(key,value);},
    delete:async key=>{kvCalls.push(['delete',key]);kv.delete(key);}
  }};
}

export function request(path, body, { method = body === undefined ? 'GET':'POST', auth = 'personal' } = {}) {
  const headers = auth === 'personal' ? {cookie:'shtab_s=fixture-session'} : auth === 'collector' ? {authorization:'Bearer fixture-ingest'} : auth === 'shared' ? {cookie:'okk_auth=fixture-legacy'} : {};
  if (body !== undefined) headers['content-type']='application/json';
  return new Request('https://audit.invalid'+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
}
export const rows = (env,table) => env.sqlite.prepare('SELECT * FROM '+table).all();
