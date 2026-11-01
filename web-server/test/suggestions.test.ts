import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { once } from 'node:events';
import { fixture,login,headers } from './helpers.js';
test('suggestion routes require view and tag permissions and bound tag edits before bot dispatch',async()=>{
 const f=await fixture();let bot:WebSocket|undefined;try{
  f.config.ticketSyncToken='a'.repeat(43);bot=new WebSocket(f.url.replace('http','ws')+'/tickets-commands',{headers:{Authorization:'Bearer '+f.config.ticketSyncToken}});await once(bot,'open');
  const commands:any[]=[];bot.on('message',data=>{const c=JSON.parse(data.toString());commands.push(c);bot!.send(JSON.stringify({type:'item',id:c.id,message:{name:'Suggestions',tags:[]}}));bot!.send(JSON.stringify({type:'done',id:c.id}));});
  const account=f.config.users.get('admin')!;account.permissions=['panel.access'];let staff=await login(f);
  const get=(path:string)=>f.app.inject({url:path,headers:headers(f,staff)});
  const post=(tags:string[],expected:string[]=[])=>f.app.inject({method:'POST',url:'/api/suggestions/12345678901234567/tags',headers:headers(f,staff),payload:{tags,expected}});
  assert.equal((await get('/api/suggestions')).statusCode,403);assert.equal(commands.length,0);
  account.permissions.push('tab.suggestions');staff=await login(f);assert.equal((await get('/api/suggestions')).statusCode,200);assert.equal(commands[0].action,'suggestions-list');assert.deepEqual(commands[0].tags,[]);
  assert.equal((await get('/api/suggestions?tags=invalid')).statusCode,400);assert.equal((await get('/api/suggestions?untagged=invalid')).statusCode,400);assert.equal((await get('/api/suggestions?untagged=true&tags=12345678901234568')).statusCode,400);
  assert.equal((await get('/api/suggestions?q='+encodeURIComponent('spawn station'))).statusCode,200);
  assert.equal(commands.at(-1).action,'suggestions-list');
  assert.equal(commands.at(-1).query,'spawn station');
  assert.equal((await get('/api/suggestions?q='+encodeURIComponent('x'.repeat(161)))).statusCode,400);
  assert.equal((await post([])).statusCode,403);assert.equal((await get('/api/suggestions/12345678901234567/messages')).statusCode,200);assert.equal(commands.at(-1).action,'suggestions-history');
  account.permissions.push('suggestions.tags');staff=await login(f);
  assert.equal((await post(Array(6).fill('12345678901234568'))).statusCode,400);assert.equal((await post(['bad'])).statusCode,400);
  assert.equal((await post(['12345678901234568'])).statusCode,200);assert.equal(commands.at(-1).action,'suggestions-tags');
  assert(f.audit.recent().some(r=>r.action==='suggestion-tags'&&r.state==='success'));
 }finally{bot?.terminate();await f.close();}
});

test('suggestion replies require their own grant, CSRF and unique request ID and carry staff rank',async()=>{
 const {randomUUID}=await import('node:crypto');const f=await fixture();let bot:WebSocket|undefined;
 try{
  f.config.ticketSyncToken='a'.repeat(43);bot=new WebSocket(f.url.replace('http','ws')+'/tickets-commands',{headers:{Authorization:'Bearer '+f.config.ticketSyncToken}});await once(bot,'open');
  const commands:any[]=[];bot.on('message',data=>{const c=JSON.parse(data.toString());commands.push(c);bot!.send(JSON.stringify({type:'done',id:c.id}));});
  const account=f.config.users.get('admin')!;account.permissions=['panel.access','tab.suggestions','tickets.reply'];let staff=await login(f);
  const post=(id:string,csrf=true)=>f.app.inject({method:'POST',url:'/api/suggestions/12345678901234567/reply',headers:{...headers(f,staff),'x-request-id':id,...(!csrf?{'x-csrf-token':'bad'}:{})},payload:{content:'We will look into this.'}});
  assert.equal((await post(randomUUID())).statusCode,403);assert.equal(commands.length,0);
  account.permissions.push('suggestions.reply');staff=await login(f);assert.equal((await post(randomUUID(),false)).statusCode,403);
  const id=randomUUID();assert.equal((await post(id)).statusCode,200);assert.equal((await post(id)).statusCode,409);assert.equal(commands.length,1);
  assert.equal(commands[0].action,'suggestions-reply');assert.equal(commands[0].rank,'admin');assert.equal(commands[0].actor,'admin');
  assert(f.audit.recent().some(r=>r.action==='suggestion-reply'&&r.state==='success'));
  account.permissions=['panel.access','suggestions.reply'];staff=await login(f);assert.equal((await post(randomUUID())).statusCode,403);
 }finally{bot?.terminate();await f.close();}
});

test('admin suggestion status, create and delete need their own grants, valid statuses and are audited',async()=>{
 const {randomUUID}=await import('node:crypto');const {readFile}=await import('node:fs/promises');const f=await fixture();let bot:WebSocket|undefined;
 try{
  f.config.ticketSyncToken='a'.repeat(43);bot=new WebSocket(f.url.replace('http','ws')+'/tickets-commands',{headers:{Authorization:'Bearer '+f.config.ticketSyncToken}});await once(bot,'open');
  const commands:any[]=[];bot.on('message',data=>{const c=JSON.parse(data.toString());commands.push(c);bot!.send(JSON.stringify({type:'item',id:c.id,message:{id:'12345678901234567',name:'Spawn station',status:c.status??null}}));bot!.send(JSON.stringify({type:'done',id:c.id}));});
  const account=f.config.users.get('admin')!;account.permissions=['panel.access','tab.suggestions'];let staff=await login(f);
  const id='12345678901234567';
  const status=(value:unknown,expected:unknown=null)=>f.app.inject({method:'POST',url:`/api/suggestions/${id}/status`,headers:headers(f,staff),payload:{status:value,expected}});
  const create=(payload:unknown,rid=randomUUID())=>f.app.inject({method:'POST',url:'/api/suggestions',headers:{...headers(f,staff),'x-request-id':rid},payload:payload as object});
  const remove=()=>f.app.inject({method:'POST',url:`/api/suggestions/${id}/delete`,headers:headers(f,staff),payload:{}});
  assert.equal((await status('Done')).statusCode,403);assert.equal((await create({title:'T',content:'C'})).statusCode,403);assert.equal((await remove()).statusCode,403);assert.equal(commands.length,0);

  account.permissions.push('suggestions.status');staff=await login(f);
  for(const bad of ['Invented','done','',null,7])assert.equal((await status(bad)).statusCode,400);
  assert.equal((await status('Done','Invented')).statusCode,400);assert.equal(commands.length,0);
  for(const value of ['Denied','Done','Under consideration','Maybe next season','Waiting for update','Testing','Poll'])assert.equal((await status(value,'Testing')).statusCode,200);
  assert.deepEqual({action:commands.at(-1).action,status:commands.at(-1).status,expected:commands.at(-1).expected,actor:commands.at(-1).actor,rank:commands.at(-1).rank,channel:commands.at(-1).channel},{action:'suggestions-status',status:'Poll',expected:'Testing',actor:'admin',rank:'admin',channel:id});
  assert(f.audit.recent().some(r=>r.action==='suggestion-status'&&r.state==='success'));
  assert.equal((await status('Done')).statusCode,200);

  account.permissions.push('suggestions.create');staff=await login(f);
  assert.equal((await create({title:'',content:'C'})).statusCode,400);assert.equal((await create({title:'T'.repeat(101),content:'C'})).statusCode,400);assert.equal((await create({title:'T',content:'C'.repeat(1701)})).statusCode,400);
  assert.equal((await f.app.inject({method:'POST',url:'/api/suggestions',headers:headers(f,staff),payload:{title:'T',content:'C'}})).statusCode,400);
  const rid=randomUUID(),before=commands.length;assert.equal((await create({title:'Spawn station',content:'Please add one'},rid)).statusCode,200);assert.equal((await create({title:'Spawn station',content:'Please add one'},rid)).statusCode,409);
  assert.equal(commands.length,before+1);assert.deepEqual({action:commands.at(-1).action,title:commands.at(-1).title,content:commands.at(-1).content,rank:commands.at(-1).rank},{action:'suggestions-create',title:'Spawn station',content:'Please add one',rank:'admin'});
  assert(f.audit.recent().some(r=>r.action==='suggestion-create'&&r.state==='success'));

  const count=commands.length;assert.equal((await remove()).statusCode,403);assert.equal(commands.length,count);
  account.permissions.push('suggestions.delete');staff=await login(f);
  assert.equal((await f.app.inject({method:'POST',url:'/api/suggestions/not-an-id/delete',headers:headers(f,staff),payload:{}})).statusCode,400);
  assert.equal((await remove()).statusCode,200);assert.equal(commands.at(-1).action,'suggestions-delete');assert.equal(commands.at(-1).channel,id);
  assert(f.audit.recent().some(r=>r.action==='suggestion-delete'&&r.state==='success'));

  const bot_source=await readFile('../discord-bot/src/suggestions.ts','utf8'),{SUGGESTION_STATUSES}=await import('../src/suggestion-statuses.js');
  const listed=[...bot_source.match(/SUGGESTION_STATUSES=\[([^\]]+)\]/)![1]!.matchAll(/'([^']+)'/g)].map(m=>m[1]);
  assert.deepEqual(listed,[...SUGGESTION_STATUSES],'bot and panel status lists match');
 }finally{bot?.terminate();await f.close();}
});
