import { suggestionCommand, suggestionThread, SuggestionError, SUGGESTION_ACTIONS } from './suggestions.js';
import { staffSignature } from './signature.js';
import { authorProfiles, profile } from './profiles.js';
import { mentionFormatter } from './mentions.js';
import { WebSocket } from 'ws';
import { PermissionFlagsBits, type Guild, type Message } from 'discord.js';
import { matches, UNCATEGORIZED_TICKET, type TicketConfig } from './tickets.js';
export async function messageView(m:Message,format:ReturnType<typeof mentionFormatter>,resolveProfile?:ReturnType<typeof authorProfiles>) {
 const embeds=[];
 for(const e of m.embeds){const fields=[];for(const f of e.fields)fields.push({rawName:f.name,rawValue:f.value,name:await format(f.name,m),value:await format(f.value,m)});embeds.push({rawTitle:e.title,rawDescription:e.description,title:await format(e.title,m),description:await format(e.description,m),fields,image:e.image?{url:e.image.proxyURL??e.image.url,name:e.title??'Embedded image',contentType:'image/*'}:undefined,thumbnail:e.thumbnail?{url:e.thumbnail.proxyURL??e.thumbnail.url,name:e.title??'Thumbnail',contentType:'image/*'}:undefined,video:e.video?{url:e.video.proxyURL??e.video.url,name:e.title??'Embedded video',contentType:'video/*'}:undefined});}
 const content=await format(m.content,m);
 return {rawContent:m.content,mentions:{...format.mentions},id:m.id,...(resolveProfile?await resolveProfile(m):profile(m)),bot:m.author.bot,content,createdAt:m.createdTimestamp,editedAt:m.editedTimestamp,
  attachments:[...m.attachments.values()].map(a=>({name:a.name,url:a.url,contentType:a.contentType,size:a.size,width:a.width,height:a.height,spoiler:a.spoiler})),embeds};
}
export async function conversationCommand(guild:Guild,config:TicketConfig,c:Record<string,unknown>) {
 if(SUGGESTION_ACTIONS.includes(String(c.action)))return suggestionCommand(guild,config,c);
 const suggestion=c.action==='suggestions-history'||c.action==='suggestions-reply';
 if(suggestion){await suggestionThread(guild,config,c.channel);c={...c,action:c.action==='suggestions-reply'?'reply':'history'};}
 if(!['history','reply'].includes(String(c.action))||typeof c.channel!=='string'||! /^[1-9][0-9]{16,19}$/.test(c.channel))throw new Error('Invalid command');
 const channel=await guild.channels.fetch(c.channel,{force:true});
 if(!channel||!channel.isTextBased()||!('send' in channel)||!channel.viewable)throw new Error('Channel unavailable');
 const parent=channel.parentId?await guild.channels.fetch(channel.parentId,{force:true}):null;
 const source=channel.isThread()?parent?.parentId:channel.parentId;
 const rule=config.rules.find(r=>matches(channel.name,r.pattern));
 if(!suggestion&&(!source||!config.categoryIds.includes(source)||(rule?.id??UNCATEGORIZED_TICKET.id)!==c.category))throw new Error('Channel is not an allowed ticket');
 const me=await guild.members.fetchMe();
 if(!channel.permissionsFor(me)?.has(PermissionFlagsBits.ReadMessageHistory))throw new Error('Message history permission required');
 if(c.action==='history'){
  if(c.before!==undefined&&(typeof c.before!=='string'||! /^[1-9][0-9]{16,19}$/.test(c.before)))throw new Error('Invalid cursor');
  const messages=await channel.messages.fetch({limit:25,before:c.before as string|undefined,cache:false});
  const format=mentionFormatter(guild),resolveProfile=authorProfiles(guild),rows=[];
  for(const message of [...messages.values()].sort((a,b)=>a.createdTimestamp-b.createdTimestamp))rows.push(await messageView(message,format,resolveProfile));
  return {messages:rows,hasMore:messages.size===25};
 }
 if(typeof c.content!=='string'||!c.content.trim()||c.content.length>1800||typeof c.actor!=='string'||c.actor.length>130||typeof c.rank!=='string'||!c.rank.trim()||c.rank.length>32||typeof c.requestId!=='string'||! /^[a-f0-9-]{36}$/.test(c.requestId))throw new Error('Invalid reply');
 if(channel.isThread()&&(channel.archived||channel.locked))throw new Error('Thread is closed');
 if(!channel.permissionsFor(me)?.has(channel.isThread()?PermissionFlagsBits.SendMessagesInThreads:PermissionFlagsBits.SendMessages))throw new Error('Send permission required');
 const signature=await staffSignature(guild,c.actor,c.rank);
 const message=await channel.send({content:`${c.content}\n\n${signature}`,allowedMentions:{parse:[],repliedUser:false},nonce:c.requestId.replaceAll('-','').slice(0,24),enforceNonce:true});
 return {messages:[await messageView(message,mentionFormatter(guild),authorProfiles(guild))],hasMore:false};
}
export function connectConversations(guild:Guild,config:TicketConfig):()=>void {
 if(!config.url||!config.token)return()=>{};
 const url=new URL(config.url);url.pathname='/tickets-commands';
 let stopped=false,socket:WebSocket|undefined,retry:ReturnType<typeof setTimeout>|undefined;
 const connect=()=>{
  if(stopped)return;
  const ws=new WebSocket(url,{headers:{Authorization:'Bearer '+config.token},handshakeTimeout:10000,maxPayload:16384,perMessageDeflate:false});socket=ws;
  let active=0,alive=true;
  const heartbeat=setInterval(()=>{if(!alive){ws.terminate();return;}alive=false;if(ws.readyState===WebSocket.OPEN)ws.ping();},15000);
  ws.on('pong',()=>{alive=true;});
  ws.on('message',async data=>{
   let c:Record<string,unknown>;
   try{c=JSON.parse(data.toString());if(typeof c.id!=='string')throw new Error();}catch{ws.close(1008,'Invalid command');return;}
   const send=async(value:unknown)=>{const body=JSON.stringify(value);if(Buffer.byteLength(body)>60000)throw new Error('Message too large');await new Promise<void>((resolve,reject)=>ws.send(body,error=>error?reject(error):resolve()));};
   if(active>=4){await send({type:'done',id:c.id,error:true}).catch(()=>{});return;}active++;
   try{const result=await conversationCommand(guild,config,c);for(const message of result.messages)await send({type:'item',id:c.id,message});await send({type:'done',id:c.id,hasMore:result.hasMore});}
   catch(error){await send({type:'done',id:c.id,error:true,errorCode:error instanceof SuggestionError?error.code:undefined}).catch(()=>{});}finally{active--;}
  });
  ws.on('open',()=>console.log('Ticket conversations connected.'));
  ws.on('error',()=>{});
  ws.on('close',()=>{clearInterval(heartbeat);if(!stopped)retry=setTimeout(connect,3000);});
 };
 connect();return()=>{stopped=true;clearTimeout(retry);socket?.terminate();};
}
