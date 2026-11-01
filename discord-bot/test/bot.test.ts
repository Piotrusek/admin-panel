import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, type Guild } from 'discord.js';
import { loadConfig } from '../src/config.js';
import { channelListing, printGuildChannels } from '../src/channels.js';

test('only bot token and guild ID are required; invalid configuration does not expose secrets',()=>{
 const env={DISCORD_BOT_TOKEN:'test-secret',DISCORD_GUILD_ID:'12345678901234567'};
 assert.deepEqual(loadConfig(env),{token:'test-secret',guildId:env.DISCORD_GUILD_ID});
 for(const invalid of [{}, {...env,DISCORD_BOT_TOKEN:''},{...env,DISCORD_GUILD_ID:'not-an-id'},{...env,DISCORD_BOT_TOKEN:'secret with spaces'}]){
  assert.throws(()=>loadConfig(invalid),error=>error instanceof Error&&!error.message.includes('test-secret')&&!error.message.includes('secret with spaces'));
 }
});
test('console listing filters invisible channels, deduplicates, covers channel types and escapes names',()=>{
 const channel={id:'1',name:'general',type:ChannelType.GuildText,viewable:true,parentId:null} as const;
 const {lines,count}=channelListing([channel,channel,null,{...channel,id:'2',name:'hidden',viewable:false},{...channel,id:'3',name:'voice',type:ChannelType.GuildVoice},{...channel,id:'4',name:'unsafe\n\u001b[31m',type:ChannelType.GuildForum}]);
 assert.equal(count,3);assert.equal(lines.length,4);assert(lines[1].includes('GuildText'));assert(lines[2].includes('GuildVoice'));assert(lines[3].includes('GuildForum'));
 assert(lines.every(line=>!line.includes('\n')&&!line.includes('\u001b')&&!line.includes('hidden')));
});
test('startup listing refreshes membership, fetches guild channels and accessible active threads',async()=>{
 const calls:string[]=[],output:string[]=[];
 const guild={id:'12345678901234567',name:'Configured guild',members:{fetchMe:async()=>{calls.push('member');}},channels:{
  fetch:async()=>{calls.push('channels');return new Map([['1',{id:'1',name:'general',type:ChannelType.GuildText,viewable:true}],['2',{id:'2',name:'private',type:ChannelType.GuildText,viewable:false}]]);},
  fetchActiveThreads:async()=>{calls.push('threads');return {threads:new Map([['3',{id:'3',name:'discussion',type:ChannelType.PublicThread,viewable:true}]])};}
 }} as unknown as Guild;
 await printGuildChannels(guild,line=>output.push(line));
 assert.deepEqual(calls,['member','channels','threads']);assert.equal(output.length,4);assert(output[0].includes('2 visible'));assert(!output.join('\n').includes('private'));
});


test('categories follow position, threads follow parents, and hidden parents do not leak',()=>{
 const make=(id:string,name:string,type:ChannelType,parentId:string|null=null,rawPosition=0,viewable=true)=>({id,name,type,viewable,parentId,rawPosition});
 const channels=[
  make('c2','Second',ChannelType.GuildCategory,null,2),make('c1','First',ChannelType.GuildCategory,null,1),
  make('b','later',ChannelType.GuildText,'c1',2),make('a','earlier',ChannelType.GuildText,'c1',1),
  make('t','thread',ChannelType.PublicThread,'a'),make('u','loose',ChannelType.GuildVoice),
  make('hidden','Secret category',ChannelType.GuildCategory,null,0,false),make('orphan','visible override',ChannelType.GuildText,'hidden'),
  make('missing','orphan thread',ChannelType.PublicThread,'unavailable')
 ];
 const {lines,count}=channelListing(channels as Parameters<typeof channelListing>[0]);
 assert.equal(count,8);assert.equal(lines[0],'Uncategorized');
 assert(!lines.join('\n').includes('Secret category'));
 assert(lines.findIndex(l=>l.includes('First'))<lines.findIndex(l=>l.includes('Second')));
 const earlier=lines.findIndex(l=>l.includes('earlier'));
 assert(lines[earlier+1].startsWith('    [')&&lines[earlier+1].includes('(t)'));assert(lines[earlier+2].includes('later'));
 assert.equal(lines.filter(l=>l.includes('(missing)')).length,1);
 assert.deepEqual(channelListing([]),{count:0,lines:[]});
});


test('forum threads display applied tag names, empty tags and unknown IDs without leaking hidden tags',()=>{
 const forum={id:'forum',name:'Support',type:ChannelType.GuildForum as const,parentId:null,viewable:true,availableTags:[{id:'bug',name:'Bug'},{id:'unsafe',name:'Review\n\u001b[31m'}]};
 const thread={id:'post',name:'Question',type:ChannelType.PublicThread as const,parentId:'forum',viewable:true,appliedTags:['bug','unsafe','deleted']};
 const {lines}=channelListing([forum,thread,{...thread,id:'empty',appliedTags:[]},{...forum,id:'text',type:ChannelType.GuildText},{...thread,id:'ordinary',parentId:'text'}, {...forum,id:'hidden',viewable:false},{...thread,id:'orphan',parentId:'hidden'}]);
 const post=lines.find(line=>line.includes('(post)'))!;
 assert(post.includes('Tags: "Bug", "Review\\n\\u001b[31m", "Unknown tag (deleted)"'));
 assert(!post.includes('\n')&&!post.includes('\u001b'));
 assert(lines.find(line=>line.includes('(empty)'))!.endsWith('Tags: none'));
 for(const id of ['ordinary','orphan'])assert(!lines.find(line=>line.includes('('+id+')'))!.includes('Tags:'));
});

import { ticketConfig,matches,collectTickets,publishTickets } from '../src/tickets.js';
test('ticket config defaults and overrides use anchored wildcard matching',()=>{
 const config=ticketConfig({TICKET_RULES:JSON.stringify({'lost-items-or-airship':{label:'Lost Items',pattern:'lost-*'}})});
 assert.equal(config.rules.length,7);assert.equal(config.rules[0]!.label,'Lost Items');
 assert(matches('lost-items-or-airship-1619','lost-items-or-airship-*'));
 assert(!matches('other-lost-items-or-airship-1619','lost-items-or-airship-*'));
 for(const rules of ['[]','null','{"unknown":{}}','{"report":{"pattern":".*"}}'])assert.throws(()=>ticketConfig({TICKET_RULES:rules}));
 assert.throws(()=>ticketConfig({TICKET_CATEGORY_IDS:'bad'}));
 assert.throws(()=>ticketConfig({TICKET_SYNC_URL:'wss://example.com/tickets-sync',TICKET_SYNC_TOKEN:'a'.repeat(43)}),/CATEGORY_IDS/);
});
test('tickets include only visible matching channels and forum threads under configured categories',async()=>{
 const source='12345678901234567';
 const channel={id:'1',name:'lost-items-or-airship-1619',type:ChannelType.GuildText,viewable:true,parentId:source,isThread:()=>false};
 const forum={...channel,id:'forum',name:'Support',type:ChannelType.GuildForum,availableTags:[{id:'open',name:'Open'}]};
 const thread={...channel,id:'thread',name:'report-20',type:ChannelType.PublicThread,parentId:'forum',isThread:()=>true,appliedTags:['open']};
 const guild={id:'12345678901234568',members:{fetchMe:async()=>{}},channels:{fetch:async()=>new Map([['1',channel],['forum',forum],['2',{...channel,id:'2',viewable:false}],['3',{...channel,id:'3',parentId:'other'}],['4',{...channel,id:'4',name:'general'}]]),fetchActiveThreads:async()=>({threads:new Map([['thread',thread]])})}} as unknown as Guild;
 const rows=await collectTickets(guild,ticketConfig({TICKET_CATEGORY_IDS:source}));
 assert.equal(rows.length,3);assert.equal(rows[0]!.category,'uncategorized');assert.equal(rows[1]!.category,'lost-items-or-airship');assert.deepEqual(rows[2]!.tags,['Open']);
});

test('publisher batches Unicode safely, orders snapshots, and sends an empty snapshot to clear tickets',async()=>{
 const config=ticketConfig({TICKET_CATEGORY_IDS:'12345678901234567',TICKET_SYNC_URL:'ws://10.0.1.1:3000/tickets-sync',TICKET_SYNC_TOKEN:'a'.repeat(43)});
 const calls:any[]=[];
 const fake=async(body:string)=>{assert(Buffer.byteLength(body)<=16384);calls.push(JSON.parse(body));};
 await publishTickets(config,Array.from({length:150},(_,i)=>({id:String(12345678901234567n+BigInt(i)),guildId:'12345678901234568',category:'report',name:'report-'+i,tags:['雪'.repeat(100)]})),fake);
 assert(calls.length>1);assert.equal(calls.flatMap(c=>c.tickets).length,150);
 assert.deepEqual(calls[0].categories.at(-1),{id:'uncategorized',label:'Uncategorized'});
 calls.forEach((c,i)=>{assert.equal(c.index,i);assert.equal(c.snapshot,calls[0].snapshot);assert.equal(c.final,i===calls.length-1);});
 calls.length=0;await publishTickets(config,[],fake);assert.equal(calls.length,1);assert(calls[0].final);assert.deepEqual(calls[0].tickets,[]);
 await assert.rejects(publishTickets(config,[],async()=>{throw new Error('401');}),/401/);
});

import { WebSocketServer } from 'ws';
import { once } from 'node:events';
test('real ticket WebSocket authenticates, acknowledges batches and reconnects after rejection',async()=>{
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
 const address=server.address();assert(typeof address==='object'&&address);
 const config=ticketConfig({TICKET_CATEGORY_IDS:'12345678901234567',TICKET_SYNC_URL:`ws://127.0.0.1:${address.port}/tickets-sync`,TICKET_SYNC_TOKEN:'a'.repeat(43)});
 let rejectAck=true,connections=0;
 server.on('connection',(socket,req)=>{connections++;assert.equal(req.headers.authorization,'Bearer '+config.token);socket.on('message',data=>{const b=JSON.parse(data.toString());socket.send(JSON.stringify({ok:!rejectAck,snapshot:b.snapshot,index:b.index}));});});
 try{await assert.rejects(publishTickets(config,[]),/acknowledgement rejected/);rejectAck=false;await publishTickets(config,[]);assert.equal(connections,2);}
 finally{for(const socket of server.clients)socket.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

import { conversationCommand } from '../src/conversations.js';
test('conversation commands recheck source/category, paginate, attribute staff and suppress mentions',async()=>{
 const config=ticketConfig({TICKET_CATEGORY_IDS:'12345678901234567'});
 const sent:Record<string,unknown>[]=[];
 const message={id:'12345678901234570',content:'Hello',author:{username:'Player',bot:false},createdTimestamp:1,editedTimestamp:null,attachments:new Map(),embeds:[]};
 let source=config.categoryIds[0];
 const channel={id:'12345678901234568',name:'report-1',viewable:true,parentId:source,isTextBased:()=>true,isThread:()=>false,permissionsFor:()=>({has:()=>true}),messages:{fetch:async(options:unknown)=>{assert.deepEqual(options,{limit:25,before:undefined,cache:false});return new Map([[message.id,message]]);}},send:async(body:Record<string,unknown>)=>{sent.push(body);return message;}};
 const guild={members:{fetchMe:async()=>({})},channels:{fetch:async(id:string)=>id===channel.id?{...channel,parentId:source}:null}} as unknown as Guild;
 const command={action:'history',channel:channel.id,category:'report'};
 assert.equal(((await conversationCommand(guild,config,command)).messages[0] as {content:string}).content,'Hello');
 await assert.rejects(conversationCommand(guild,config,{...command,category:'other-support'}));
 source='98765432101234567';await assert.rejects(conversationCommand(guild,config,command));source=config.categoryIds[0];
 await conversationCommand(guild,config,{...command,action:'reply',content:'@everyone hello',actor:'Admin',rank:'moderator',requestId:'12345678-1234-1234-1234-123456789012'});
 assert.deepEqual(sent[0]!.allowedMentions,{parse:[],repliedUser:false});assert.equal(sent[0]!.enforceNonce,true);assert(String(sent[0]!.content).endsWith('— Admin · moderator'));
 await assert.rejects(conversationCommand(guild,config,{...command,action:'reply',content:'x'.repeat(1801)}));assert.equal(sent.length,1);
 const nickGuild={...guild,members:{fetchMe:async()=>({}),fetch:async()=>({displayName:'Server Nickname'})}} as unknown as Guild;
 await conversationCommand(nickGuild,config,{...command,action:'reply',content:'Test',actor:'account [687968050280267805]',rank:'owner',requestId:'12345678-1234-1234-1234-123456789013'});
 assert(String(sent[1]!.content).endsWith('— Server Nickname · owner'));assert(!String(sent[1]!.content).includes('687968050280267805'));
 const missingGuild={...guild,members:{fetchMe:async()=>({}),fetch:async()=>{throw new Error('Missing member');}}} as unknown as Guild;
 await conversationCommand(missingGuild,config,{...command,action:'reply',content:'Test',actor:'account [687968050280267805]',rank:'helper',requestId:'12345678-1234-1234-1234-123456789014'});
 assert(String(sent[2]!.content).endsWith('— account · helper'));
});

import { errorDetail } from '../src/errors.js';
test('login diagnostics recognize uncoded Discord intent errors without exposing raw secrets',()=>{
 assert.match(errorDetail(new Error('Used disallowed intents')),/enable Message Content Intent/);
 assert.match(errorDetail({code:4014}),/Message Content Intent/);
 assert.match(errorDetail({code:'TokenInvalid',message:'secret-token'}),/Invalid bot token/);
 assert.match(errorDetail({cause:{code:'ENOTFOUND'}}),/DNS/);
 for(const e of [new Error('secret-token'),{code:'secret-token',message:'secret-token'},null])assert(!errorDetail(e).includes('secret-token'));
});

import { mentionFormatter } from '../src/mentions.js';
import { messageView } from '../src/conversations.js';
import type { Message } from 'discord.js';
test('mentions resolve users and roles across message and embed text with deduplicated lookups',async()=>{
 const user='748608591963095092',role='1489347648195530762';let users=0,roles=0;
 const guild={members:{cache:new Map(),fetch:async()=>{users++;return {displayName:'Pilot <Alice>'};}},roles:{cache:new Map(),fetch:async()=>{roles++;return {name:'Support Team'};}}} as unknown as Guild;
 const m={id:'1',author:{username:'Tickety',bot:true},content:`<@${user}>, <@&${role}>`,createdTimestamp:1,attachments:new Map(),embeds:[{title:`Hello <@!${user}>`,description:`Welcome **<@${user}>**`,fields:[{name:`<@&${role}>`,value:`Ask <@${user}>`}]}]} as unknown as Message;
 const result=await messageView(m,mentionFormatter(guild));
 assert.equal(result.content,'@Pilot <Alice>, @Support Team');assert.equal(result.embeds[0]!.title,'Hello @Pilot <Alice>');assert.equal(result.embeds[0]!.description,'Welcome **@Pilot <Alice>**');assert.equal(result.embeds[0]!.fields[0]!.name,'@Support Team');assert.equal(result.embeds[0]!.fields[0]!.value,'Ask @Pilot <Alice>');assert.equal(users,1);assert.equal(roles,1);
 assert.equal(m.content,`<@${user}>, <@&${role}>`,'does not modify Discord message content');
});
test('unavailable mentions preserve IDs, use known usernames and bound REST lookups',async()=>{
 let calls=0;const fetch=async()=>{calls++;throw new Error('Unavailable');};
 const guild={members:{cache:new Map(),fetch},roles:{cache:new Map(),fetch}} as unknown as Guild;
 const m={mentions:{users:new Map([['748608591963095092',{globalName:'Known User',username:'known'}]])}} as unknown as Message;
 const format=mentionFormatter(guild);
 assert.equal(await format('<@748608591963095092> <@&1489347648195530762>',m),'@Known User <@&1489347648195530762>');
 const text=Array.from({length:40},(_,i)=>`<@${12345678901234567n+BigInt(i)}>`).join(' ');
 assert.equal(await format(text,m),text);assert.equal(calls,25);
});

test('ticket serialization includes attachment media metadata and embed CDN previews',async()=>{
 const m={id:'1',author:{username:'Pilot',bot:false},content:'Photo',createdTimestamp:1,attachments:new Map([['a',{name:'photo.jpg',url:'https://cdn.discordapp.com/photo.jpg?ex=signature',contentType:'image/jpeg',size:1234,width:640,height:480,spoiler:true}]]),embeds:[{title:'Clip',fields:[],image:{url:'https://example.com/image',proxyURL:'https://images-ext-1.discordapp.net/image'},video:{url:'https://media.discordapp.net/clip.mp4'}}]} as unknown as Message;
 const result=await messageView(m,mentionFormatter({} as Guild));
 assert.equal(result.attachments[0]!.contentType,'image/jpeg');assert.equal(result.attachments[0]!.spoiler,true);assert(result.attachments[0]!.url.includes('?ex=signature'));
 assert.equal(result.embeds[0]!.image!.url,'https://images-ext-1.discordapp.net/image');assert.equal(result.embeds[0]!.video!.contentType,'video/*');
});

import { authorProfiles } from '../src/profiles.js';
test('ticket authors use guild nicknames and server avatars with deduplicated member fetches',async()=>{
 let calls=0;const guild={members:{fetch:async()=>{calls++;return {displayName:'Server Pilot',displayAvatarURL:()=> 'https://cdn.discordapp.com/guilds/server-avatar.png'};}}} as unknown as Guild;
 const m={author:{id:'12345678901234567',username:'accountname',globalName:'Global Pilot',displayAvatarURL:()=> 'https://cdn.discordapp.com/global.png'}} as unknown as Message;
 const resolve=authorProfiles(guild);
 assert.deepEqual(await resolve(m),{author:'Server Pilot',username:'accountname',avatarUrl:'https://cdn.discordapp.com/guilds/server-avatar.png'});
 await resolve(m);assert.equal(calls,1);
 const webhook=await resolve({...m,webhookId:'webhook'} as Message);assert.equal(webhook.author,'Global Pilot');assert.equal(webhook.avatarUrl,'https://cdn.discordapp.com/global.png');assert.equal(calls,1);
 const missing=authorProfiles({members:{fetch:async()=>{throw new Error('Member left');}}} as unknown as Guild);
 assert.equal((await missing(m)).author,'Global Pilot');assert.equal((await missing(m)).avatarUrl,'https://cdn.discordapp.com/global.png');
});

import { suggestionCommand,suggestionThread } from '../src/suggestions.js';
test('forum suggestions paginate active and archived threads and constrain tag updates to their forum',async()=>{
 const forumId='12345678901234567',threadId='12345678901234568',tag='12345678901234569';
 const config=ticketConfig({SUGGESTIONS_FORUM_ID:forumId});let edits=0,allowed=true;
 const thread={id:threadId,name:'Build a spawn station',guild:{id:'12345678901234570'},parentId:forumId,viewable:true,isThread:()=>true,appliedTags:[tag],archived:false,locked:false,createdTimestamp:1,archiveTimestamp:1234567890,permissionsFor:()=>({has:()=>allowed}),setAppliedTags:async(tags:string[])=>{edits++;thread.appliedTags=tags;return thread;}};
 const forum={id:forumId,name:'Suggestions',type:ChannelType.GuildForum,viewable:true,permissionsFor:()=>({has:()=>true}),availableTags:[{id:tag,name:'Planned',moderated:false}],threads:{fetchActive:async()=>({threads:new Map(Array.from({length:30},(_,i)=>[String(i),{...thread,id:String(12345678901234568n+BigInt(i))}]))}),fetchArchived:async(options:any)=>{assert.equal(options.limit,100);return {threads:new Map([[threadId,thread]]),hasMore:false};}}};
 const guild={id:'12345678901234570',members:{fetchMe:async()=>({})},channels:{fetch:async(id:string)=>id===forumId?forum:thread}} as unknown as Guild;
 const first=await suggestionCommand(guild,config,{action:'suggestions-list'});assert.equal(first.messages.length,25);assert(first.hasMore);
 const untagged=await suggestionCommand(guild,config,{action:'suggestions-list',untagged:true});assert.equal(untagged.messages.length,1);
 await assert.rejects(suggestionCommand(guild,config,{action:'suggestions-list',untagged:true,tags:[tag]}));
 const filtered=await suggestionCommand(guild,config,{action:'suggestions-list',tags:['12345678901234599']});assert.equal(filtered.messages.length,1);assert(!filtered.hasMore);
 const matching=await suggestionCommand(guild,config,{action:'suggestions-list',tags:[tag]});assert.equal(matching.messages.length,25);
 const next=await suggestionCommand(guild,config,{action:'suggestions-list',cursor:'24'});assert.equal(next.messages.length,7);assert(!next.hasMore);
 assert.equal((await suggestionCommand(guild,config,{action:'suggestions-list',archived:true})).messages.length,2);
 await suggestionCommand(guild,config,{action:'suggestions-tags',channel:threadId,tags:[],expected:[tag]});assert.equal(edits,1);
 assert.equal((await suggestionCommand(guild,config,{action:'suggestions-list',untagged:true})).messages.length,25);
 await assert.rejects(suggestionCommand(guild,config,{action:'suggestions-tags',channel:threadId,tags:[tag],expected:[tag]}),/suggestions-conflict/);
 await assert.rejects(suggestionCommand(guild,config,{action:'suggestions-tags',channel:threadId,tags:['12345678901234599'],expected:[]}),/Invalid forum tags/);
 allowed=false;await assert.rejects(suggestionCommand(guild,config,{action:'suggestions-tags',channel:threadId,tags:[tag],expected:[]}));allowed=true;
 thread.parentId='12345678901234599';await assert.rejects(suggestionThread(guild,config,threadId),/Not a suggestion/);assert.equal(edits,1);
 assert.throws(()=>ticketConfig({SUGGESTIONS_FORUM_ID:'bad'}));
});

import { newestActivity } from '../src/suggestions.js';
test('suggestion ordering follows latest message snowflakes rather than thread creation',()=>{
 const rows=[{id:'1489347648195530762',lastMessageId:null},{id:'748608591963095092',lastMessageId:'1489347648195530763'},{id:'748608591963095093',lastMessageId:'1489347648195530764'}];
 assert.deepEqual([...rows].sort(newestActivity).map(t=>t.id),[rows[2]!.id,rows[1]!.id,rows[0]!.id]);
});

test('archived suggestions sort across archive pages before tag filtering and display pagination',async()=>{
 const forumId='12345678901234567',tag='12345678901234569';let calls=0;
 const first={id:'1489347648195530762',lastMessageId:'1489347648195530763',name:'Recently archived',guild:{id:forumId},viewable:true,appliedTags:[tag],archiveTimestamp:2000};
 const second={...first,id:'748608591963095092',lastMessageId:'1489347648195530764',name:'Newest reply',archiveTimestamp:1000};
 const forum={id:forumId,name:'Suggestions',type:ChannelType.GuildForum,viewable:true,permissionsFor:()=>({has:()=>true}),availableTags:[],threads:{fetchArchived:async(options:any)=>{calls++;if(calls===1){assert.equal(options.before,undefined);return {threads:new Map([[first.id,first]]),hasMore:true};}assert.equal(options.before.getTime(),2000);return {threads:new Map([[second.id,second]]),hasMore:false};}}};
 const guild={id:forumId,members:{fetchMe:async()=>({})},channels:{fetch:async()=>forum}} as unknown as Guild;
 const result=await suggestionCommand(guild,ticketConfig({SUGGESTIONS_FORUM_ID:forumId}),{action:'suggestions-list',archived:true,tags:[tag]});
 assert.equal((result.messages[1] as {name:string}).name,'Newest reply');assert.equal(calls,2);assert(!result.hasMore);
 await suggestionCommand(guild,ticketConfig({SUGGESTIONS_FORUM_ID:forumId}),{action:'suggestions-list',archived:true});assert.equal(calls,2,'archive cache avoids repeated full scans');
});

test('suggestion replies are confined to the configured forum and reject archived threads',async()=>{
 const forumId='12345678901234567',threadId='12345678901234568';let sends=0;
 const message={id:'12345678901234569',content:'Sent',author:{username:'Bot',bot:true},createdTimestamp:1,attachments:new Map(),embeds:[]};
 const forum={id:forumId,type:ChannelType.GuildForum,viewable:true,permissionsFor:()=>({has:()=>true})};
 const thread={id:threadId,name:'Community idea',parentId:forumId,viewable:true,archived:false,locked:false,isThread:()=>true,isTextBased:()=>true,permissionsFor:()=>({has:()=>true}),send:async()=>{sends++;return message;}};
 const guild={members:{fetchMe:async()=>({})},channels:{fetch:async(id:string)=>id===forumId?forum:thread}} as unknown as Guild;
 const config=ticketConfig({SUGGESTIONS_FORUM_ID:forumId}),command={action:'suggestions-reply',channel:threadId,content:'Thanks for the idea!',actor:'Developer',rank:'dev',requestId:'12345678-1234-1234-1234-123456789012'};
 await conversationCommand(guild,config,command);assert.equal(sends,1);
 thread.archived=true;await assert.rejects(conversationCommand(guild,config,command),/closed/);thread.archived=false;
 thread.parentId='12345678901234599';await assert.rejects(conversationCommand(guild,config,command),/Not a suggestion/);assert.equal(sends,1);
});

import { Collection } from 'discord.js';
import { buildSuggestionIndex,indexSuggestionMessage,invalidateSuggestionThread } from '../src/suggestions.js';

test('background suggestion index finds message bodies across pages and follows new and edited messages',async()=>{
 const forumId='12345678901234567',guildId='12345678901234699',threadId='12345678901234568';
 const config=ticketConfig({SUGGESTIONS_FORUM_ID:forumId});
 const rows=new Map<string,any>();
 const add=(id:string,content:string)=>{const m={id,content,embeds:[],attachments:new Collection()};rows.set(id,m);return m;};
 add('12345678901234570','A buried blueprint mentions a hidden hangar');
 const thread:any={id:threadId,name:'Unrelated title',parentId:forumId,viewable:true,archived:false,locked:false,appliedTags:[],createdTimestamp:1,lastMessageId:'12345678901234570',
  guild:{id:guildId},messages:{fetch:async()=>new Collection(rows)}};
 const forum:any={id:forumId,name:'Suggestions',type:ChannelType.GuildForum,viewable:true,permissionsFor:()=>({has:()=>true}),availableTags:[],
  threads:{fetchActive:async()=>({threads:new Collection([[threadId,thread]])}),fetchArchived:async()=>({threads:new Collection(),hasMore:false})}};
 const guild={id:guildId,members:{fetchMe:async()=>({})},channels:{fetch:async()=>forum}} as unknown as Guild;
 await buildSuggestionIndex(guild,config);
 const query=async(q:string)=>((await suggestionCommand(guild,config,{action:'suggestions-list',query:q})).messages as any[]).slice(1);
 assert.equal((await query('hidden hangar')).length,1);
 assert.equal((await query('not in index')).length,0);
 const m=add('12345678901234571','The reactor needs extra cooling');
 indexSuggestionMessage(guild,config,{...m,guild,channel:{...thread,isThread:()=>true}} as unknown as Message);
 assert.equal((await query('extra cooling')).length,1,'new messages update the index immediately');
 rows.delete('12345678901234570');
 invalidateSuggestionThread(guild,config,thread);
 for(let i=0;i<20&&(await query('hidden hangar')).length;i++)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal((await query('hidden hangar')).length,0,'deletions remove stale text');
});

import { statusOf, withStatus, SUGGESTION_STATUSES } from '../src/suggestions.js';
test('suggestion status is a single trailing line that is replaced, never duplicated',()=>{
 assert.deepEqual([...SUGGESTION_STATUSES],['Denied','Done','Under consideration','Maybe next season','Waiting for update','Testing','Poll']);
 assert.equal(statusOf('Add a spawn station'),null);
 const first=withStatus('Add a spawn station\n\n— Staff · admin','Testing');
 assert.equal(first,'Add a spawn station\n\n— Staff · admin\n\n**Status:** Testing');assert.equal(statusOf(first),'Testing');
 const second=withStatus(first,'Under consideration');
 assert.equal(second,'Add a spawn station\n\n— Staff · admin\n\n**Status:** Under consideration');assert.equal(second.match(/Status/g)!.length,1);
 assert.equal(statusOf('Status: Done'),null);assert.equal(statusOf('**Status:** Invented'),null);
});

test('webhook configuration is validated without echoing its token',()=>{
 const forum='12345678901234567',token='a'.repeat(40),url='https://discord.com/api/webhooks/12345678901234568/'+token;
 assert.equal(ticketConfig({SUGGESTIONS_FORUM_ID:forum,SUGGESTIONS_WEBHOOK_URL:url}).suggestionsWebhookUrl,url);
 assert.equal(ticketConfig({SUGGESTIONS_FORUM_ID:forum}).suggestionsWebhookUrl,undefined);
 for(const bad of ['http://discord.com/api/webhooks/12345678901234568/'+token,'https://example.com/api/webhooks/12345678901234568/'+token,'https://discord.com/api/webhooks/1/'+token]){
  assert.throws(()=>ticketConfig({SUGGESTIONS_FORUM_ID:forum,SUGGESTIONS_WEBHOOK_URL:bad}),error=>error instanceof Error&&!error.message.includes(token));
 }
 assert.throws(()=>ticketConfig({SUGGESTIONS_WEBHOOK_URL:url}),/SUGGESTIONS_FORUM_ID/);
});

test('admin suggestion commands create via webhook, edit its message status, and delete threads',async()=>{
 const forumId='12345678901234567',threadId='12345678901234568',other='12345678901234571';
 const config=ticketConfig({SUGGESTIONS_FORUM_ID:forumId});
 const thread:any={id:threadId,name:'Build a spawn station',guild:{id:'12345678901234570'},parentId:forumId,viewable:true,isThread:()=>true,appliedTags:[],archived:false,locked:false,createdTimestamp:1,permissionsFor:()=>({has:()=>allowed}),deleted:0,delete:async()=>{thread.deleted++;}};
 let allowed=true,stored='Build a spawn station\n\n— Staff · admin',sent:any,edited:any,failFetch=false;
 const forum={id:forumId,name:'Suggestions',type:ChannelType.GuildForum,viewable:true,permissionsFor:()=>({has:()=>true}),availableTags:[]};
 const guild={id:'12345678901234570',members:{fetchMe:async()=>({}),fetch:async()=>{throw new Error('no member');}},channels:{fetch:async(id:string)=>id===forumId?forum:id===threadId?thread:null}} as unknown as Guild;
 const deps={webhook:async()=>({
  send:async(o:any)=>{sent=o;return {channel_id:threadId};},
  fetchMessage:async(id:string,o:any)=>{assert.equal(id,threadId);assert.equal(o.threadId,threadId);if(failFetch)throw new Error('Unknown Message');return {content:stored};},
  editMessage:async(id:string,o:any)=>{assert.equal(id,threadId);edited=o;stored=o.content;return {};}
 })};
 const staff={actor:'Alex [12345678901234569]',rank:'admin'};
 const created=await suggestionCommand(guild,config,{action:'suggestions-create',title:' Build a spawn station ',content:'Please add one @everyone',...staff},deps);
 assert.equal(sent.threadName,'Build a spawn station');assert.deepEqual(sent.allowedMentions,{parse:[]});assert(sent.content.endsWith('\n\n— Alex · admin'));
 assert.equal((created.messages[0] as any).status,null);
 await assert.rejects(suggestionCommand(guild,config,{action:'suggestions-create',title:'',content:'x',...staff},deps),/Invalid suggestion/);
 await assert.rejects(suggestionCommand(guild,config,{action:'suggestions-create',title:'t'.repeat(101),content:'x',...staff},deps),/Invalid suggestion/);
 await assert.rejects(suggestionCommand(guild,config,{action:'suggestions-create',title:'t',content:'x'.repeat(1701),...staff},deps),/Invalid suggestion/);
 await assert.rejects(suggestionCommand(guild,config,{action:'suggestions-create',title:'t',content:'x'},deps),/Invalid staff identity/);

 const changed=await suggestionCommand(guild,config,{action:'suggestions-status',channel:threadId,status:'Maybe next season',expected:null,...staff},deps);
 assert.equal(edited.content,'Build a spawn station\n\n— Staff · admin\n\n**Status:** Maybe next season');assert.equal(edited.threadId,threadId);assert.deepEqual(edited.allowedMentions,{parse:[]});
 assert.equal((changed.messages[0] as any).status,'Maybe next season');
 await assert.rejects(suggestionCommand(guild,config,{action:'suggestions-status',channel:threadId,status:'Done',expected:'Poll',...staff},deps),/suggestions-conflict/);
 await suggestionCommand(guild,config,{action:'suggestions-status',channel:threadId,status:'Done',expected:'Maybe next season',...staff},deps);
 assert.equal(stored.match(/Status/g)!.length,1);assert(stored.endsWith('**Status:** Done'));
 for(const status of ['Invented','',undefined])await assert.rejects(suggestionCommand(guild,config,{action:'suggestions-status',channel:threadId,status,...staff},deps),/Invalid suggestion status/);
 failFetch=true;await assert.rejects(suggestionCommand(guild,config,{action:'suggestions-status',channel:threadId,status:'Poll',...staff},deps),/suggestions-status-unsupported/);failFetch=false;
 await assert.rejects(suggestionCommand(guild,config,{action:'suggestions-status',channel:threadId,status:'Poll',...staff},{}),/suggestions-webhook-unconfigured/);
 stored='x'.repeat(1990);await assert.rejects(suggestionCommand(guild,config,{action:'suggestions-status',channel:threadId,status:'Testing',...staff},deps),/suggestions-too-long/);
 thread.locked=true;await assert.rejects(suggestionCommand(guild,config,{action:'suggestions-status',channel:threadId,status:'Poll',...staff},deps),/suggestions-readonly/);thread.locked=false;

 await assert.rejects(suggestionCommand(guild,config,{action:'suggestions-delete',channel:other,...staff}));
 allowed=false;await assert.rejects(suggestionCommand(guild,config,{action:'suggestions-delete',channel:threadId,...staff}),/suggestions-readonly/);assert.equal(thread.deleted,0);allowed=true;
 assert.deepEqual(await suggestionCommand(guild,config,{action:'suggestions-delete',channel:threadId,...staff}),{messages:[],hasMore:false});assert.equal(thread.deleted,1);
});
