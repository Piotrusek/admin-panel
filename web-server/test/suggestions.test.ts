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
